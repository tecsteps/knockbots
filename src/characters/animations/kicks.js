/**
 * Knockbots — kick clips (the "3" and "4" buttons).
 *
 * Same rig conventions as punches.js — read the header there first; the axis
 * table and the shoulder rest-offset note apply to every clip here.
 *
 * Kicks live or die on the chamber. Each one passes through a readable folded
 * pose before it extends, because that chamber frame is what a player reads to
 * tell a mid kick from a high kick. The support leg is authored as a planted
 * FK leg and feeds the per-key ground solve; the kicking leg is authored as a
 * thigh/shin direction pair so the limb points where it is aimed regardless of
 * what the hips are doing. Pivoting kicks carry their turn in the root `ry`
 * track, which is what lets the support foot stay put while the body rotates.
 *
 * Airborne clips (k.jumpKick, k.stomp) carry their own arc in the root track so
 * they read correctly played standalone; a fighter that also drives its own
 * ballistic Y should scale or ignore the clip's vertical component.
 *
 * The foot is a three-joint chain, not a block: `ankle_*` swings the whole foot,
 * `foot_*` breaks at the ball and `toe_*` behind that. A toe-first kick is
 * dorsiflexed through the chamber, snaps to a blade at contact and whips past it
 * on the follow-through; a heel-first one (axe kick, stomp, sweep) does the
 * reverse, or the boot would be driven through the floor. The planted foot gives
 * back a share of whatever its own ankle is doing, so the sole stays nearer the
 * floor than the shin angle implies. Without those two joints a kick reads as a
 * mannequin swinging a plank.
 *
 * Every strike also carries a follow-through past its contact tick: the hip
 * keeps travelling while the knee starts to fold, which is how a limb actually
 * sheds its energy. Nothing sits still to do it — a kick that freezes at full
 * extension for four frames reads as a mannequin holding a pose, not as a leg
 * arriving somewhere hard.
 *
 * The anticipate -> hold -> release -> carry pass documented at the foot of
 * punches.js applies to every clip here as well; read it there. What it changed
 * on the kicks specifically: `k.midKick`, `k.highKick`, `k.roundhouse` and
 * `k.sideKick` all peaked one tick BEFORE contact and arrived at roughly half
 * their own peak speed, and `k.lowKick`'s knee was stationary (0.1cm) on the
 * frame the hitbox opened. Their peak now lands ON the contact tick without
 * raising the worst single-tick travel — k.highKick went 86cm to 83cm, because
 * the motion was moved rather than added.
 *
 * Two exceptions, both measured. `k.sweep` got WORSE when its drive was
 * restructured (contact speed 0.32 -> 0.11 of peak): twelve authored wind-up
 * keys and a knee already at peak flexion the tick before contact leave nothing
 * to hold, so it keeps its authored release. `k.stomp` and `k.diveKick` are
 * gravity strikes — the foot is carried by the pelvis-height track, which the
 * root rules in punches.js forbid retiming, so they still decelerate.
 *
 * Each clip declares `impact: { tick, bone }`, the tick the blow lands and the
 * bone it lands with. Fighter pins that tick onto the move's first active frame
 * and the clip's end onto the move's last, and stretches the wind-up and the
 * recovery separately to suit; the declaration is therefore load-bearing and has
 * to move whenever the strike does.
 *
 * ROUND 14 audited every one of those declarations against the rig, and six of
 * the 34 named a bone travelling under half as far as the limb actually leading
 * the strike. `impact.bone` is read by nothing in src/ — only by the offline
 * measurement tools — so a wrong one does not break the game, it silently makes
 * every speed and carry number for that clip a measurement of a limb standing
 * still. `k.spinKick` was the worst: it declared `foot_L`, the PLANTED foot,
 * which travels 0.143m by contact while foot_R travels 1.017m. That is why this
 * file has recorded it as a decelerator since round 11.
 *
 * Corrected here: k.lowKick knee_L -> foot_L, k.spinKick foot_L -> foot_R (and
 * its tick 19 -> 18, one past the peak of the swing). `k.sweep` was left alone:
 * it declares knee_L, which travels 0.556m and is a real authored hitbox anchor,
 * and the limb that leads it is the planting hand rather than the strike.
 *
 * Corrected fleet-wide, on the right bones at the right ticks, the numbers this
 * file quotes above move: mean contact-frame speed as a share of peak 0.863 ->
 * 0.879, clips decelerating into contact 5/34 -> 4/34, mean carry 247 -> 268mm.
 * Those are re-measurements, not improvements — the animation did not change.
 */

import { validateClip } from '../AnimationFormat.js';
import { whip, lead } from './reactions.js';
import { carry, sagittal } from './idle.js';
import { BONE_NAMES } from '../Skeleton.js';

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const KICK_CLIPS = {
  // i11. Lead-leg snap to the shin. Barely chambers — the knee does the work.
  'k.lowKick': {
    name: 'Low Kick',
    duration: 33, blendIn: 3, blendOut: 7,
    // Was `knee_L` (0.315m of travel). The blow lands with the shin tip:
    // foot_L travels 0.850m. See the note on `impact.bone` at the top of the
    // file -- the wrong bone here made every offline speed measurement of this
    // clip a measurement of the joint the foot swings around.
    impact: { tick: 16, bone: 'foot_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 10, p: [0, -0.107, 0.02], ease: 'linear' },
      { t: 11, p: [0, -0.107, 0.021], ease: 'linear' },
      { t: 12, p: [0, -0.107, 0.026], ease: 'linear' },
      { t: 13, p: [0, -0.108, 0.036], ease: 'linear' },
      { t: 14, p: [0, -0.109, 0.055], ease: 'linear' },
      { t: 15, p: [0, -0.109, 0.082], ease: 'linear' },
      { t: 16, p: [0, -0.109, 0.12], ease: 'sine' },
      { t: 19, p: [0, -0.109, 0.131], ease: 'quad' },
      { t: 24, p: [0, -0.115, 0.06], ease: 'sine' },
      { t: 33, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [0.89, -30.71, -0.42], ease: 'sine' },
        { t: 10, r: [1, -23.2, 0.9], ease: 'linear' }, { t: 14, r: [1.22, -20.05, 1.23], ease: 'linear' },
        { t: 15, r: [1.31, -18.79, 1.36], ease: 'linear' }, { t: 16, r: [1.4, -17.4, 1.5], ease: 'sine' },
        { t: 19, r: [1.44, -16.76, 1.57], ease: 'quad' }, { t: 24, r: [1.2, -25.5, 0.6], ease: 'sine' },
        { t: 33, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [1.62, 5.42, -0.7], ease: 'sine' },
        { t: 10, r: [1.9, 4.9, 1.5], ease: 'linear' }, { t: 14, r: [2.44, 4.63, 2.04], ease: 'linear' },
        { t: 15, r: [2.66, 4.52, 2.26], ease: 'linear' }, { t: 16, r: [2.9, 4.4, 2.5], ease: 'sine' },
        { t: 19, r: [3.01, 4.35, 2.61], ease: 'quad' }, { t: 24, r: [2.4, 5.1, 1], ease: 'sine' },
        { t: 33, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [2.26, 6.35, -0.78], ease: 'sine' },
        { t: 10, r: [2.6, 5.7, 1.7], ease: 'linear' }, { t: 14, r: [3.25, 5.43, 2.3], ease: 'linear' },
        { t: 15, r: [3.51, 5.32, 2.54], ease: 'linear' }, { t: 16, r: [3.8, 5.2, 2.8], ease: 'sine' },
        { t: 19, r: [3.93, 5.15, 2.92], ease: 'quad' }, { t: 24, r: [3.2, 6, 1.1], ease: 'sine' },
        { t: 33, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [2.26, 7.61, -3.9], ease: 'sine' },
        { t: 10, r: [2.6, 6.8, -1.1], ease: 'linear' }, { t: 14, r: [3.25, 6.47, -0.39], ease: 'linear' },
        { t: 15, r: [3.51, 6.34, -0.11], ease: 'linear' }, { t: 16, r: [3.8, 6.2, 0.2], ease: 'sine' },
        { t: 19, r: [3.93, 6.13, 0.34], ease: 'quad' }, { t: 24, r: [3.2, 7, -1.7], ease: 'sine' },
        { t: 33, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 10, r: [0.6, 4, 0], ease: 'quart' },
        { t: 16, r: [0.4, 2.6, 0], ease: 'sine' }, { t: 19, r: [0.38, 2.45, 0], ease: 'quad' },
        { t: 24, r: [0.5, 4.6, 0], ease: 'sine' }, { t: 33, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 10, r: [2.5, 5.8, 0], ease: 'quart' },
        { t: 16, r: [2.3, 3, 0], ease: 'sine' }, { t: 19, r: [2.28, 2.69, 0], ease: 'quad' },
        { t: 24, r: [2.4, 6.9, 0], ease: 'sine' }, { t: 33, r: [2.5, 8, 0], ease: 'linear' }],
      // THE SAME COUNTERWEIGHT, SCALED TO THE MOVE. A lead-leg snap kick is not a
      // committal turn -- the pelvis rotates 10 degrees here against the mid
      // kick's 58 -- so the arm that pays for it moves proportionally less. It
      // bottoms out at chest-local y -202 where k.midKick reaches -341 and
      // k.highKick -380, and it never leaves the front half of the reach.
      // Deliberately the smallest of the four: a low kick that threw the arm as
      // hard as a high round kick would read as the same move at a different
      // height, which is the defect one level up from the one being fixed.
      clavicle_L: [{ t: 0, r: [0, -10, -4], ease: 'quad' }, { t: 4, r: [-2, -12, 1], ease: 'sine' },
        { t: 10, r: [-6, -14, 4], ease: 'expo' }, { t: 16, r: [8, 4, -8], ease: 'snap' },
        { t: 19, r: [10, 6, -10], ease: 'sine' }, { t: 24, r: [2, -4, -5], ease: 'sine' },
        { t: 28, r: [0, -8, -4], ease: 'sine' }, { t: 33, r: [0, -10, -4], ease: 'linear' }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 4, r: [-38, -8, -34], ease: 'sine' },
        { t: 10, r: [-42, -18, -32], ease: 'expo' }, { t: 16, r: [-28, 24, -14], ease: 'snap' },
        { t: 19, r: [-26, 32, -8], ease: 'sine' }, { t: 24, r: [-34, 6, -30], ease: 'sine' },
        { t: 28, r: [-35, 1, -34], ease: 'sine' }, { t: 33, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 4, r: [-130, 0, 17], ease: 'sine' },
        { t: 10, r: [-136, 0, 17], ease: 'expo' }, { t: 16, r: [-108, 0, 17], ease: 'snap' },
        { t: 19, r: [-100, 0, 17], ease: 'sine' }, { t: 24, r: [-118, 0, 17], ease: 'sine' },
        { t: 28, r: [-122, 0, 17], ease: 'sine' }, { t: 33, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4, r: [-8, 3, 0], ease: 'sine' },
        { t: 10, r: [-8, 6, 0], ease: 'expo' }, { t: 16, r: [-8, -8, 0], ease: 'snap' },
        { t: 19, r: [-8, -11, 0], ease: 'sine' }, { t: 24, r: [-8, -2, 0], ease: 'sine' },
        { t: 33, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4, r: [-17, 0, 0], ease: 'sine' },
        { t: 10, r: [-20, 0, 0], ease: 'expo' }, { t: 16, r: [-8, 0, -2], ease: 'snap' },
        { t: 19, r: [-5, 0, -3], ease: 'sine' }, { t: 24, r: [-12, 0, 0], ease: 'sine' },
        { t: 33, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 10, r: [-18.5, 0.3, 30.8], ease: 'quart' },
        { t: 16, r: [-18.2, -3, 25.1], ease: 'sine' }, { t: 19, r: [-18.17, -3.36, 24.47], ease: 'quad' },
        { t: 24, r: [-21.3, -0.5, 31.7], ease: 'sine' }, { t: 33, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 10, r: [-145.3, 0, -1], ease: 'quart' },
        { t: 24, r: [-145.33, 0, -1], ease: 'sine' }, { t: 33, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 4, r: [-30.57, 12.6, 8.09], ease: 'sine' },
        { t: 10, r: [-49.9, 23.2, 25.1], ease: 'linear' }, { t: 14, r: [-56.53, 15.43, 23.82], ease: 'linear' },
        { t: 15, r: [-61.8, 9.25, 22.8], ease: 'linear' }, { t: 16, r: [-69.1, 0.7, 21.4], ease: 'snap' },
        { t: 19, r: [-83.6, -16.3, 18.61], ease: 'sine' }, { t: 22, r: [-70.2, -1.9, 20.5], ease: 'quad' },
        { t: 24, r: [-35.9, 27.4, 20.9], ease: 'sine' }, { t: 33, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 4, r: [53.2, 0, 0], ease: 'sine' },
        { t: 10, r: [24.4, 0, 0], ease: 'linear' }, { t: 14, r: [16.66, 0, 0], ease: 'linear' },
        { t: 15, r: [10.51, 0, 0], ease: 'linear' }, { t: 16, r: [2, 0, 0], ease: 'snap' },
        { t: 19, r: [-6, 0, 0], ease: 'sine' }, { t: 22, r: [6.1, 0, 0], ease: 'quad' },
        { t: 24, r: [15.6, 0, 0], ease: 'sine' }, { t: 33, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 10, r: [18, 0, 0], ease: 'quart' },
        { t: 16, r: [26, 0, 0], ease: 'sine' }, { t: 19, r: [26.88, 0, 0], ease: 'quad' },
        { t: 22, r: [25.8, 0, 0], ease: 'quad' }, { t: 24, r: [6, 0, 0], ease: 'sine' },
        { t: 33, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [-12, 0, 0], ease: 'quart' },
        { t: 16, r: [24, 0, 0], ease: 'sine' }, { t: 19, r: [27.5, 0, 0], ease: 'quad' },
        { t: 22, r: [31, 0, 0], ease: 'sine' }, { t: 24, r: [-8, 0, 0], ease: 'sine' },
        { t: 33, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [7, 0, 0], ease: 'quart' },
        { t: 16, r: [-11, 0, 0], ease: 'sine' }, { t: 19, r: [-12.98, 0, 0], ease: 'quad' },
        { t: 22, r: [-15, 0, 0], ease: 'sine' }, { t: 24, r: [6, 0, 0], ease: 'sine' },
        { t: 33, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 10, r: [4, 6, -13], ease: 'quart' },
        { t: 16, r: [8, 4, -13], ease: 'sine' }, { t: 19, r: [8.44, 3.78, -13], ease: 'quad' },
        { t: 24, r: [4, 6, -13], ease: 'sine' }, { t: 33, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 10, r: [20, 0, 0], ease: 'quart' },
        { t: 16, r: [16, 0, 0], ease: 'sine' }, { t: 19, r: [15.56, 0, 0], ease: 'quad' },
        { t: 24, r: [22, 0, 0], ease: 'sine' }, { t: 33, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 10, r: [-41.5, -3, 0], ease: 'quart' },
        { t: 16, r: [-42, -3, 0], ease: 'sine' }, { t: 19, r: [-42.05, -3, 0], ease: 'quad' },
        { t: 24, r: [-43.5, -3, 0], ease: 'sine' }, { t: 33, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [2.6, 0, 0], ease: 'quart' },
        { t: 16, r: [2.7, 0, 0], ease: 'sine' }, { t: 19, r: [2.71, 0, 0], ease: 'quad' },
        { t: 24, r: [3.2, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [1.4, 0, 0], ease: 'quart' },
        { t: 16, r: [1.5, 0, 0], ease: 'sine' }, { t: 19, r: [1.51, 0, 0], ease: 'quad' },
        { t: 24, r: [1.8, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i15. Rear round kick to the ribs. The support foot pivots through 58
  // degrees of root yaw, the hip turns over, and both arms swing opposite to
  // pay for the angular momentum.
  'k.midKick': {
    name: 'Mid Kick',
    duration: 36, blendIn: 4, blendOut: 8,
    impact: { tick: 15, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 7, p: [0, -0.092, 0.02], ease: 'sine' },
      { t: 12, p: [0, -0.082, 0.06], ry: -24, ease: 'linear' },
      { t: 13, p: [0, -0.082, 0.074], ry: -32.5, ease: 'linear' },
      { t: 14, p: [0, -0.081, 0.108], ry: -49.5, ease: 'linear' },
      { t: 15, p: [0, -0.081, 0.16], ry: -58, ease: 'sine' },
      { t: 19, p: [0, -0.081, 0.171], ry: -61.7, ease: 'quad' },
      { t: 26, p: [0, -0.089, 0.1], ry: -20, ease: 'sine' },
      { t: 36, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [1.07, -33.8, 0.46], ease: 'sine' },
        { t: 7, r: [1.2, -33.6, -0.6], ease: 'sine' }, { t: 12, r: [0.7, -15.1, -2.1], ease: 'linear' },
        { t: 13, r: [0.65, -7.02, -2.42], ease: 'linear' }, { t: 14, r: [0.58, 3.46, -2.84], ease: 'linear' },
        { t: 15, r: [0.5, 15.1, -3.3], ease: 'sine' }, { t: 19, r: [0.48, 18.42, -3.43], ease: 'quad' },
        { t: 26, r: [1.2, -8.1, -1.2], ease: 'sine' }, { t: 36, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [2.15, 6.12, 1.54], ease: 'sine' },
        { t: 7, r: [2.4, 5.7, -1], ease: 'sine' }, { t: 12, r: [1.4, 4.2, -3.5], ease: 'linear' },
        { t: 13, r: [1.29, 3.58, -4.04], ease: 'linear' }, { t: 14, r: [1.15, 2.78, -4.73], ease: 'linear' },
        { t: 15, r: [1, 1.9, -5.5], ease: 'sine' }, { t: 19, r: [0.96, 1.65, -5.72], ease: 'quad' },
        { t: 26, r: [2.4, 3.7, -2], ease: 'sine' }, { t: 36, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [2.96, 7.16, 1.74], ease: 'sine' },
        { t: 7, r: [3.2, 6.7, -1.1], ease: 'sine' }, { t: 12, r: [1.9, 5, -3.9], ease: 'linear' },
        { t: 13, r: [1.74, 4.28, -4.52], ease: 'linear' }, { t: 14, r: [1.53, 3.34, -5.32], ease: 'linear' },
        { t: 15, r: [1.3, 2.3, -6.2], ease: 'sine' }, { t: 19, r: [1.23, 2, -6.45], ease: 'quad' },
        { t: 26, r: [3.2, 4.4, -2.2], ease: 'sine' }, { t: 36, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [2.96, 8.59, -1.04], ease: 'sine' },
        { t: 7, r: [3.2, 7.9, -4.3], ease: 'sine' }, { t: 12, r: [1.9, 5.9, -7.5], ease: 'linear' },
        { t: 13, r: [1.74, 5.04, -8.17], ease: 'linear' }, { t: 14, r: [1.53, 3.93, -9.04], ease: 'linear' },
        { t: 15, r: [1.3, 2.7, -10], ease: 'sine' }, { t: 19, r: [1.23, 2.35, -10.27], ease: 'quad' },
        { t: 26, r: [3.2, 5.2, -5.6], ease: 'sine' }, { t: 36, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 7, r: [0.5, 6.7, 0], ease: 'sine' },
        { t: 12, r: [0.7, 2, 0], ease: 'sine' }, { t: 15, r: [0.8, -5.7, 0], ease: 'sine' },
        { t: 19, r: [0.81, -6.55, 0], ease: 'quad' }, { t: 26, r: [0.5, 0.2, 0], ease: 'sine' },
        { t: 36, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 7, r: [2.4, 10.7, 0], ease: 'sine' },
        { t: 12, r: [2.6, 1.9, 0], ease: 'sine' }, { t: 15, r: [2.8, -12.2, 0], ease: 'sine' },
        { t: 19, r: [2.82, -13.75, 0], ease: 'quad' }, { t: 26, r: [2.4, -1.3, 0], ease: 'sine' },
        { t: 36, r: [2.5, 8, 0], ease: 'linear' }],
      // THE OFF-ARM PAYS FOR THE HIP. See the note at the foot of this file. The
      // old track had the whole left arm inside a 103x69x155mm chest-local box
      // for the entire kick — the smallest envelope of any attack in the library
      // — so its 866mm of world travel was 93% the chest swinging it, and a
      // straight punch parked it within 129mm of the same place. A round kick
      // that squares 58 degrees of root yaw off one planted foot has to throw
      // something the other way, and the only mass available is this arm.
      //
      // It winds UP and across on the chamber (t7, chest-local y +341), whips
      // DOWN and wide as the shin arrives (t15, y -282) and trails past the
      // contact before it gathers. That is a 620mm arc through the opposite half
      // of the body's reach from where p.straight's guard retraction lives, which
      // is the point: the two moves must not route the hand through one region.
      clavicle_L: [{ t: 0, r: [0, -10, -4], ease: 'sine' }, { t: 3, r: [-4, -8, 2], ease: 'sine' },
        { t: 7, r: [-14, -22, 8], ease: 'quart' }, { t: 12, r: [-2, -4, 0], ease: 'expo' },
        { t: 15, r: [12, 8, -10], ease: 'snap' }, { t: 19, r: [16, 12, -13], ease: 'sine' },
        { t: 22, r: [10, 6, -8], ease: 'sine' }, { t: 26, r: [2, -2, -4], ease: 'sine' },
        { t: 30, r: [0, -8, -4], ease: 'sine' }, { t: 36, r: [0, -10, -4], ease: 'linear' }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 3, r: [-40, -10, -34], ease: 'sine' },
        { t: 7, r: [-48, -42, -26], ease: 'quart' }, { t: 12, r: [-34, 4, -24], ease: 'expo' },
        { t: 15, r: [-24, 42, -6], ease: 'snap' }, { t: 19, r: [-20, 54, 2], ease: 'sine' },
        { t: 22, r: [-26, 34, -12], ease: 'sine' }, { t: 26, r: [-34, 8, -30], ease: 'sine' },
        { t: 30, r: [-36, 0, -34], ease: 'sine' }, { t: 36, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 3, r: [-132, 0, 17], ease: 'sine' },
        { t: 7, r: [-150, 0, 17], ease: 'quart' }, { t: 12, r: [-120, 0, 17], ease: 'expo' },
        { t: 15, r: [-92, 0, 17], ease: 'snap' }, { t: 19, r: [-78, 0, 17], ease: 'sine' },
        { t: 22, r: [-96, 0, 17], ease: 'sine' }, { t: 26, r: [-116, 0, 17], ease: 'sine' },
        { t: 30, r: [-122, 0, 17], ease: 'sine' }, { t: 36, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'sine' }, { t: 3, r: [-8, 4, 0], ease: 'sine' },
        { t: 7, r: [-8, 14, 0], ease: 'quart' }, { t: 12, r: [-8, 0, 0], ease: 'expo' },
        { t: 15, r: [-8, -14, 0], ease: 'snap' }, { t: 19, r: [-8, -18, 0], ease: 'sine' },
        { t: 22, r: [-8, -10, 0], ease: 'sine' }, { t: 26, r: [-8, -2, 0], ease: 'sine' },
        { t: 36, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'sine' }, { t: 3, r: [-18, 0, 0], ease: 'sine' },
        { t: 7, r: [-28, 0, 0], ease: 'quart' }, { t: 12, r: [-14, 0, 0], ease: 'expo' },
        { t: 15, r: [-2, 0, -4], ease: 'snap' }, { t: 19, r: [2, 0, -6], ease: 'sine' },
        { t: 22, r: [-6, 0, -2], ease: 'sine' }, { t: 26, r: [-12, 0, 0], ease: 'sine' },
        { t: 36, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 7, r: [-40.6, -15.2, 24.4], ease: 'sine' },
        { t: 12, r: [-45.6, -16.2, 36.3], ease: 'sine' }, { t: 15, r: [7.2, -125.2, -17.5], ease: 'sine' },
        { t: 19, r: [10.7, -128.7, -21], ease: 'quad' }, { t: 26, r: [-41.7, -17.5, 27.7], ease: 'sine' },
        { t: 36, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 7, r: [-114.7, 0, -1], ease: 'sine' },
        { t: 12, r: [-114.8, 0, -1], ease: 'sine' }, { t: 15, r: [-69.1, 0, -1], ease: 'sine' },
        { t: 19, r: [-65.6, 0, -1], ease: 'quad' }, { t: 26, r: [-114.8, 0, -1], ease: 'sine' },
        { t: 36, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 7, r: [-18, -14, 10], ease: 'sine' },
        { t: 12, r: [-15.69, -16.64, 9.89], ease: 'sine' }, { t: 15, r: [-22, -6, 8], ease: 'sine' },
        { t: 19, r: [-22.44, -5.12, 7.78], ease: 'quad' }, { t: 26, r: [-18, -14, 10], ease: 'sine' },
        { t: 36, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 7, r: [30, 0, 0], ease: 'sine' },
        { t: 12, r: [24, 0, 0], ease: 'sine' }, { t: 15, r: [18, 0, 0], ease: 'sine' },
        { t: 19, r: [17.34, 0, 0], ease: 'quad' }, { t: 26, r: [28, 0, 0], ease: 'sine' },
        { t: 36, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 7, r: [-28.3, 2, 0], ease: 'sine' },
        { t: 12, r: [-22.3, 2, 0], ease: 'sine' }, { t: 15, r: [-13, 2, 0], ease: 'sine' },
        { t: 19, r: [-11.98, 2, 0], ease: 'quad' }, { t: 26, r: [-26.6, 2, 0], ease: 'sine' },
        { t: 36, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [7.3, 0, 0], ease: 'sine' },
        { t: 12, r: [5.5, 0, 0], ease: 'sine' }, { t: 15, r: [2.7, 0, 0], ease: 'sine' },
        { t: 19, r: [2.39, 0, 0], ease: 'quad' }, { t: 26, r: [6.8, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [4.1, 0, 0], ease: 'sine' },
        { t: 12, r: [3.1, 0, 0], ease: 'sine' }, { t: 15, r: [1.5, 0, 0], ease: 'sine' },
        { t: 19, r: [1.32, 0, 0], ease: 'quad' }, { t: 26, r: [3.8, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 3, r: [4, -1.11, -15.47], ease: 'sine' },
        { t: 7, r: [-35.3, -55, -30.1], ease: 'sine' }, { t: 12, r: [-65.3, 35.7, -3.9], ease: 'linear' },
        { t: 13, r: [-68.51, 25.79, -2.09], ease: 'linear' }, { t: 14, r: [-76.48, 1.19, 2.41], ease: 'linear' },
        { t: 15, r: [-88.5, -35.9, 9.2], ease: 'expo' }, { t: 19, r: [-94.57, -54.64, 12.63], ease: 'quad' },
        { t: 22, r: [-83.1, -38.3, 7.6], ease: 'quad' }, { t: 26, r: [-45.5, -12.7, -6.7], ease: 'sine' },
        { t: 36, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 3, r: [54.16, 0, 0], ease: 'sine' },
        { t: 7, r: [16, 0, 0], ease: 'sine' }, { t: 12, r: [85.9, 0, 0], ease: 'linear' },
        { t: 13, r: [75.71, 0, 0], ease: 'linear' }, { t: 14, r: [50.42, 0, 0], ease: 'linear' },
        { t: 15, r: [12.3, 0, 0], ease: 'snap' }, { t: 19, r: [4.3, 0, 0], ease: 'sine' },
        { t: 22, r: [18.5, 0, 0], ease: 'quad' }, { t: 26, r: [24.6, 0, 0], ease: 'sine' },
        { t: 36, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 3, r: [-41, -3.38, 0], ease: 'sine' },
        { t: 7, r: [20, 0, 0], ease: 'sine' }, { t: 12, r: [26, 0, 0], ease: 'linear' },
        { t: 13, r: [26.55, 0, 0], ease: 'linear' }, { t: 14, r: [27.93, 0, 0], ease: 'linear' },
        { t: 15, r: [30, 0, 0], ease: 'snap' }, { t: 19, r: [38, 0, 0], ease: 'sine' },
        { t: 22, r: [27.2, 0, 0], ease: 'quad' }, { t: 26, r: [12, 0, 0], ease: 'sine' },
        { t: 36, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 3, r: [-6, 0, 0], ease: 'sine' },
        { t: 7, r: [-4.8, 0, 0], ease: 'sine' }, { t: 12, r: [-12, 0, 0], ease: 'linear' },
        { t: 13, r: [-7.02, 0, 0], ease: 'linear' }, { t: 14, r: [5.35, 0, 0], ease: 'linear' },
        { t: 15, r: [24, 0, 0], ease: 'snap' }, { t: 19, r: [32, 0, 0], ease: 'sine' },
        { t: 22, r: [31, 0, 0], ease: 'sine' }, { t: 26, r: [-8, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [2.8, 0, 0], ease: 'sine' },
        { t: 12, r: [7, 0, 0], ease: 'sine' }, { t: 15, r: [-11, 0, 0], ease: 'sine' },
        { t: 19, r: [-12.98, 0, 0], ease: 'quad' }, { t: 22, r: [-15, 0, 0], ease: 'sine' },
        { t: 26, r: [6, 0, 0], ease: 'sine' }, { t: 36, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i18. The same engine wound tighter and thrown at head height; the support
  // leg straightens and the torso lays away and back to counterbalance.
  'k.highKick': {
    name: 'High Kick',
    duration: 39, blendIn: 4, blendOut: 9,
    impact: { tick: 15, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 7, p: [0, -0.094, 0.02], ease: 'sine' },
      { t: 12, p: [0, -0.08, 0.08], ry: -30, ease: 'linear' },
      { t: 13, p: [0, -0.076, 0.094], ry: -40, ease: 'linear' },
      { t: 14, p: [0, -0.069, 0.128], ry: -60, ease: 'linear' },
      { t: 15, p: [0, -0.066, 0.18], ry: -70, ease: 'sine' },
      { t: 19, p: [0, -0.064, 0.191], ry: -74, ease: 'quad' },
      { t: 27, p: [0, -0.09, 0.1], ry: -24, ease: 'sine' },
      { t: 39, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [1.3, -33.8, 0.64], ease: 'sine' },
        { t: 7, r: [1, -34.8, -0.9], ease: 'sine' }, { t: 12, r: [0.2, -13.9, -2.7], ease: 'linear' },
        { t: 13, r: [-0.23, -4.91, -3.34], ease: 'linear' }, { t: 14, r: [-0.78, 6.75, -4.17], ease: 'linear' },
        { t: 15, r: [-1.4, 19.7, -5.1], ease: 'sine' }, { t: 19, r: [-1.58, 23.2, -5.36], ease: 'quad' },
        { t: 27, r: [1.4, -5.8, -1.5], ease: 'sine' }, { t: 39, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [3.24, 6.21, 2.38], ease: 'sine' },
        { t: 7, r: [1.9, 5.8, -1.5], ease: 'sine' }, { t: 12, r: [0.5, 4.2, -4.5], ease: 'linear' },
        { t: 13, r: [-0.41, 3.5, -5.57], ease: 'linear' }, { t: 14, r: [-1.59, 2.6, -6.96], ease: 'linear' },
        { t: 15, r: [-2.9, 1.6, -8.5], ease: 'sine' }, { t: 19, r: [-3.27, 1.31, -8.94], ease: 'quad' },
        { t: 27, r: [2.9, 3.5, -2.5], ease: 'sine' }, { t: 39, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [4.39, 7.3, 2.66], ease: 'sine' },
        { t: 7, r: [2.6, 6.8, -1.7], ease: 'sine' }, { t: 12, r: [0.6, 4.9, -5], ease: 'linear' },
        { t: 13, r: [-0.58, 4.07, -6.2], ease: 'linear' }, { t: 14, r: [-2.11, 2.99, -7.76], ease: 'linear' },
        { t: 15, r: [-3.8, 1.8, -9.5], ease: 'sine' }, { t: 19, r: [-4.28, 1.46, -9.99], ease: 'quad' },
        { t: 27, r: [3.8, 4.2, -2.8], ease: 'sine' }, { t: 39, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [4.39, 8.73, 0.05], ease: 'sine' },
        { t: 7, r: [2.6, 8, -4.9], ease: 'sine' }, { t: 12, r: [0.6, 5.8, -8.8], ease: 'linear' },
        { t: 13, r: [-0.58, 4.84, -10.16], ease: 'linear' }, { t: 14, r: [-2.11, 3.59, -11.93], ease: 'linear' },
        { t: 15, r: [-3.8, 2.2, -13.9], ease: 'sine' }, { t: 19, r: [-4.28, 1.8, -14.46], ease: 'quad' },
        { t: 27, r: [3.8, 4.9, -6.2], ease: 'sine' }, { t: 39, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 7, r: [0.6, 7, 0], ease: 'sine' },
        { t: 12, r: [0.9, 1.7, 0], ease: 'sine' }, { t: 15, r: [1.6, -6.8, 0], ease: 'sine' },
        { t: 19, r: [1.68, -7.73, 0], ease: 'quad' }, { t: 27, r: [0.4, -0.4, 0], ease: 'sine' },
        { t: 39, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 7, r: [2.5, 11.2, 0], ease: 'sine' },
        { t: 12, r: [2.9, 1.4, 0], ease: 'sine' }, { t: 15, r: [3.7, -14.4, 0], ease: 'sine' },
        { t: 19, r: [3.79, -16.14, 0], ease: 'quad' }, { t: 27, r: [2.3, -2.4, 0], ease: 'sine' },
        { t: 39, r: [2.5, 8, 0], ease: 'linear' }],
      // THE SAME COUNTERWEIGHT AS k.midKick, WOUND FURTHER. See the note there
      // and at the foot of this file. The old arm reached chest-local
      // (209, -56, 91) at contact -- 10mm from where k.roundhouse put it, which
      // is how a mid, a high and a spinning kick all came to share one upper-body
      // silhouette. This one goes higher on the wind (y +345, the top of the
      // library) and lower and further BEHIND the chest on the release
      // (z -279 at t19, where the mid kick's follow-through stops at -24),
      // because the torso lays away 18 degrees here and the arm is what pays for
      // the lay-away. Same family as the mid kick, twice the arc.
      // t13 and t14 EXIST TO OBEY THE 60cm RULE, not to add a pose. Authored as
      // one t12 -> t15 span on `expo` this arm crossed 680mm in the single tick
      // the support foot also spins the body 20 degrees of yaw, which is over the
      // limit the header of punches.js sets and reads as a teleport rather than
      // as speed. Flattening the ease to `quart` alone left it at 605. The two
      // keys are the t12->t15 line sampled at 40% and 72% and run `linear`, which
      // is how the striking limbs in this file are keyed through their own drive;
      // the t15 pose is untouched and the worst tick is now 270mm.
      clavicle_L: [{ t: 0, r: [0, -10, -4], ease: 'sine' }, { t: 4, r: [-6, -12, 4], ease: 'sine' },
        { t: 7, r: [-18, -26, 10], ease: 'quart' }, { t: 12, r: [-2, -2, -2], ease: 'linear' },
        { t: 13, r: [6.8, 4.4, -7.6], ease: 'linear' }, { t: 14, r: [13.8, 9.5, -12.1], ease: 'linear' },
        { t: 15, r: [20, 14, -16], ease: 'snap' }, { t: 19, r: [20, 16, -16], ease: 'sine' },
        { t: 23, r: [12, 8, -9], ease: 'sine' }, { t: 28, r: [2, -2, -4], ease: 'sine' },
        { t: 33, r: [0, -8, -4], ease: 'sine' }, { t: 39, r: [0, -10, -4], ease: 'linear' }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 4, r: [-42, -16, -32], ease: 'sine' },
        { t: 7, r: [-54, -50, -24], ease: 'quart' }, { t: 12, r: [-32, 8, -26], ease: 'linear' },
        { t: 13, r: [-26.4, 31.2, -5.2], ease: 'linear' }, { t: 14, r: [-21.9, 49.8, 11.4], ease: 'linear' },
        { t: 15, r: [-18, 66, 26], ease: 'snap' }, { t: 19, r: [-14, 70, 32], ease: 'sine' },
        { t: 23, r: [-22, 40, 4], ease: 'sine' }, { t: 28, r: [-32, 8, -30], ease: 'sine' },
        { t: 33, r: [-35, 2, -35], ease: 'sine' }, { t: 39, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 4, r: [-136, 0, 17], ease: 'sine' },
        { t: 7, r: [-158, 0, 17], ease: 'quart' }, { t: 12, r: [-118, 0, 17], ease: 'linear' },
        { t: 13, r: [-101.2, 0, 17], ease: 'linear' }, { t: 14, r: [-87.8, 0, 17], ease: 'linear' },
        { t: 15, r: [-76, 0, 17], ease: 'snap' }, { t: 19, r: [-70, 0, 17], ease: 'sine' },
        { t: 23, r: [-92, 0, 17], ease: 'sine' }, { t: 28, r: [-114, 0, 17], ease: 'sine' },
        { t: 33, r: [-122, 0, 17], ease: 'sine' }, { t: 39, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'sine' }, { t: 4, r: [-8, 6, 0], ease: 'sine' },
        { t: 7, r: [-8, 18, 0], ease: 'quart' }, { t: 12, r: [-8, -2, 0], ease: 'linear' },
        { t: 13, r: [-8, -10, 0], ease: 'linear' }, { t: 14, r: [-8, -16.4, 0], ease: 'linear' },
        { t: 15, r: [-8, -22, 0], ease: 'snap' }, { t: 19, r: [-8, -24, 0], ease: 'sine' },
        { t: 23, r: [-8, -12, 0], ease: 'sine' }, { t: 28, r: [-8, -2, 0], ease: 'sine' },
        { t: 39, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'sine' }, { t: 4, r: [-20, 0, 0], ease: 'sine' },
        { t: 7, r: [-32, 0, 0], ease: 'quart' }, { t: 12, r: [-12, 0, 0], ease: 'linear' },
        { t: 13, r: [-4.8, 0, -3.2], ease: 'linear' }, { t: 14, r: [1, 0, -5.8], ease: 'linear' },
        { t: 15, r: [6, 0, -8], ease: 'snap' }, { t: 19, r: [8, 0, -9], ease: 'sine' },
        { t: 23, r: [-4, 0, -2], ease: 'sine' }, { t: 28, r: [-12, 0, 0], ease: 'sine' },
        { t: 39, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 7, r: [-39.8, -15.5, 27.3], ease: 'sine' },
        { t: 12, r: [-47, -16, 42.9], ease: 'sine' }, { t: 15, r: [-5.3, -109.6, -28.3], ease: 'sine' },
        { t: 19, r: [-1.8, -113.1, -31.8], ease: 'quad' }, { t: 27, r: [-44.9, -18.4, 28], ease: 'sine' },
        { t: 39, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 7, r: [-114.7, 0, -1], ease: 'sine' },
        { t: 12, r: [-114.8, 0, -1], ease: 'sine' }, { t: 15, r: [-66.5, 0, -1], ease: 'sine' },
        { t: 19, r: [-63, 0, -1], ease: 'quad' }, { t: 27, r: [-114.9, 0, -1], ease: 'sine' },
        { t: 39, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 7, r: [-18, -14, 10], ease: 'sine' },
        { t: 12, r: [-15.69, -16.64, 9.89], ease: 'sine' }, { t: 15, r: [-16, -4, 6], ease: 'sine' },
        { t: 19, r: [-15.78, -2.9, 5.56], ease: 'quad' }, { t: 27, r: [-18, -14, 10], ease: 'sine' },
        { t: 39, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 7, r: [32, 0, 0], ease: 'sine' },
        { t: 12, r: [20, 0, 0], ease: 'sine' }, { t: 15, r: [8, 0, 0], ease: 'sine' },
        { t: 19, r: [6.68, 0, 0], ease: 'quad' }, { t: 27, r: [30, 0, 0], ease: 'sine' },
        { t: 39, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 7, r: [-29.9, 2, 0], ease: 'sine' },
        { t: 12, r: [-18.1, 2, 0], ease: 'sine' }, { t: 15, r: [-7.7, 2, 0], ease: 'sine' },
        { t: 19, r: [-6.56, 2, 0], ease: 'quad' }, { t: 27, r: [-28.6, 2, 0], ease: 'sine' },
        { t: 39, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [7.8, 0, 0], ease: 'sine' },
        { t: 12, r: [4.2, 0, 0], ease: 'sine' }, { t: 15, r: [1.1, 0, 0], ease: 'sine' },
        { t: 19, r: [0.76, 0, 0], ease: 'quad' }, { t: 27, r: [7.4, 0, 0], ease: 'sine' },
        { t: 39, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [4.4, 0, 0], ease: 'sine' },
        { t: 12, r: [2.4, 0, 0], ease: 'sine' }, { t: 15, r: [0.6, 0, 0], ease: 'sine' },
        { t: 19, r: [0.4, 0, 0], ease: 'quad' }, { t: 27, r: [4.2, 0, 0], ease: 'sine' },
        { t: 39, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 3, r: [4, -0.34, -15.89], ease: 'sine' },
        { t: 7, r: [-78.6, -55, -70], ease: 'sine' }, { t: 12, r: [-79.8, 44.2, -0.1], ease: 'linear' },
        { t: 13, r: [-83.29, 31.47, 2.23], ease: 'linear' }, { t: 14, r: [-91.95, -0.14, 8], ease: 'linear' },
        { t: 15, r: [-105, -47.8, 16.7], ease: 'expo' }, { t: 19, r: [-110.2, -66.8, 20.17], ease: 'quad' },
        { t: 27, r: [-47.6, -13.4, -5.8], ease: 'sine' }, { t: 39, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 3, r: [52.87, 0, 0], ease: 'sine' },
        { t: 7, r: [40.3, 0, 0], ease: 'sine' }, { t: 12, r: [97.3, 0, 0], ease: 'linear' },
        { t: 13, r: [86.17, 0, 0], ease: 'linear' }, { t: 14, r: [58.55, 0, 0], ease: 'linear' },
        { t: 15, r: [16.9, 0, 0], ease: 'snap' }, { t: 19, r: [8.9, 0, 0], ease: 'sine' },
        { t: 27, r: [25.7, 0, 0], ease: 'sine' }, { t: 39, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 3, r: [-41, -3.37, 0], ease: 'sine' },
        { t: 7, r: [20, 0, 0], ease: 'sine' }, { t: 12, r: [28, 0, 0], ease: 'linear' },
        { t: 13, r: [28.55, 0, 0], ease: 'linear' }, { t: 14, r: [29.93, 0, 0], ease: 'linear' },
        { t: 15, r: [32, 0, 0], ease: 'snap' }, { t: 19, r: [40, 0, 0], ease: 'sine' },
        { t: 23, r: [30.7, 0, 0], ease: 'quad' }, { t: 27, r: [10, 0, 0], ease: 'sine' },
        { t: 39, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 3, r: [-6, 0, 0], ease: 'sine' },
        { t: 7, r: [-4.8, 0, 0], ease: 'sine' }, { t: 12, r: [-12, 0, 0], ease: 'linear' },
        { t: 13, r: [-7.02, 0, 0], ease: 'linear' }, { t: 14, r: [5.35, 0, 0], ease: 'linear' },
        { t: 15, r: [24, 0, 0], ease: 'snap' }, { t: 19, r: [32, 0, 0], ease: 'sine' },
        { t: 23, r: [31, 0, 0], ease: 'sine' }, { t: 27, r: [-8, 0, 0], ease: 'sine' },
        { t: 39, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7, r: [2.8, 0, 0], ease: 'sine' },
        { t: 12, r: [7, 0, 0], ease: 'sine' }, { t: 15, r: [-11, 0, 0], ease: 'sine' },
        { t: 19, r: [-12.98, 0, 0], ease: 'quad' }, { t: 23, r: [-15, 0, 0], ease: 'sine' },
        { t: 27, r: [6, 0, 0], ease: 'sine' }, { t: 39, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i20. The committed version: the leg keeps going through the target and the
  // fighter spends 180 degrees of root yaw getting back to a stance.
  'k.roundhouse': {
    name: 'Roundhouse',
    duration: 48, blendIn: 4, blendOut: 10,
    impact: { tick: 20, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 9, p: [0, -0.097, -0.04], ry: 16, ease: 'sine' },
      { t: 15, p: [0, -0.08, 0.06], ry: -40, ease: 'linear' },
      { t: 16, p: [0, -0.079, 0.064], ry: -45.35, ease: 'linear' },
      { t: 17, p: [0, -0.076, 0.077], ry: -59.35, ease: 'linear' },
      { t: 18, p: [0, -0.073, 0.1], ry: -76.65, ease: 'linear' },
      { t: 19, p: [0, -0.071, 0.134], ry: -90.65, ease: 'linear' },
      { t: 20, p: [0, -0.07, 0.18], ry: -96, ease: 'sine' },
      { t: 24, p: [0, -0.069, 0.193], ry: -100, ease: 'quad' },
      { t: 32, p: [0, -0.056, 0.16], ry: -168, ease: 'sine' },
      { t: 40, p: [0, -0.1, 0.14], ry: -180, ease: 'sine' },
      { t: 48, p: [0, -0.075, 0], ry: -180, ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [1.22, -33.8, 0.58], ease: 'sine' },
        { t: 9, r: [0.7, -38.3, -1.2], ease: 'sine' }, { t: 15, r: [0, -11.6, -3], ease: 'linear' },
        { t: 18, r: [-0.37, 4.51, -3.8], ease: 'linear' }, { t: 19, r: [-0.53, 11.35, -4.14], ease: 'linear' },
        { t: 20, r: [-0.7, 18.6, -4.5], ease: 'sine' }, { t: 24, r: [-0.78, 21.92, -4.66], ease: 'quad' },
        { t: 32, r: [1, 13.9, -2.7], ease: 'sine' }, { t: 40, r: [1.7, -17.4, 0], ease: 'sine' },
        { t: 48, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [2.82, 6.21, 2.1], ease: 'sine' },
        { t: 9, r: [1.4, 6, -2], ease: 'sine' }, { t: 15, r: [0, 4, -5], ease: 'linear' },
        { t: 18, r: [-0.75, 2.72, -6.33], ease: 'linear' }, { t: 19, r: [-1.07, 2.18, -6.9], ease: 'linear' },
        { t: 20, r: [-1.4, 1.6, -7.5], ease: 'sine' }, { t: 24, r: [-1.55, 1.34, -7.77], ease: 'quad' },
        { t: 32, r: [1.9, 2, -4.5], ease: 'sine' }, { t: 40, r: [3.4, 4.4, 0], ease: 'sine' },
        { t: 48, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [3.86, 7.28, 2.35], ease: 'sine' },
        { t: 9, r: [1.9, 7.1, -2.2], ease: 'sine' }, { t: 15, r: [0, 4.7, -5.6], ease: 'linear' },
        { t: 18, r: [-1.01, 3.21, -7.09], ease: 'linear' }, { t: 19, r: [-1.44, 2.57, -7.73], ease: 'linear' },
        { t: 20, r: [-1.9, 1.9, -8.4], ease: 'sine' }, { t: 24, r: [-2.11, 1.59, -8.71], ease: 'quad' },
        { t: 32, r: [2.6, 2.4, -5], ease: 'sine' }, { t: 40, r: [4.5, 5.2, 0], ease: 'sine' },
        { t: 48, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [3.86, 8.7, -0.31], ease: 'sine' },
        { t: 9, r: [1.9, 8.4, -5.6], ease: 'sine' }, { t: 15, r: [0, 5.5, -9.4], ease: 'linear' },
        { t: 18, r: [-1.01, 3.79, -11.11], ease: 'linear' }, { t: 19, r: [-1.44, 3.07, -11.83], ease: 'linear' },
        { t: 20, r: [-1.9, 2.3, -12.6], ease: 'sine' }, { t: 24, r: [-2.11, 1.95, -12.95], ease: 'quad' },
        { t: 32, r: [2.6, 2.8, -8.8], ease: 'sine' }, { t: 40, r: [4.5, 6.2, -3], ease: 'sine' },
        { t: 48, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 9, r: [0.7, 14.9, 0], ease: 'sine' },
        { t: 15, r: [1, 4.6, 0], ease: 'sine' }, { t: 20, r: [1.3, -6.6, 0], ease: 'sine' },
        { t: 24, r: [1.33, -7.83, 0], ease: 'quad' }, { t: 32, r: [0.6, -5.4, 0], ease: 'sine' },
        { t: 40, r: [0.3, 2.6, 0], ease: 'sine' }, { t: 48, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 9, r: [2.6, 25.9, 0], ease: 'sine' },
        { t: 15, r: [3, 6.8, 0], ease: 'sine' }, { t: 20, r: [3.4, -13.9, 0], ease: 'sine' },
        { t: 24, r: [3.44, -16.18, 0], ease: 'quad' }, { t: 32, r: [2.5, -11.7, 0], ease: 'sine' },
        { t: 40, r: [2.2, 3, 0], ease: 'sine' }, { t: 48, r: [2.5, 8, 0], ease: 'linear' }],
      // THE ONE CLIP WHOSE OFF-ARM WAS ALREADY DOING SOMETHING. Its shoulder
      // wraps the arm 152 degrees around the body through the spin recovery,
      // which is why it measured 43% of its own travel where a straight punch
      // measured 8. So this is an amplification, not a rewrite: the shoulder and
      // elbow arc are left exactly as authored and the three tracks that were
      // dead single keys -- clavicle, wrist, hand -- are given the same arc. The
      // clavicle is the lever that matters, because it is the root of the chain
      // and moves the whole arm relative to the chest rather than about the
      // shoulder; `loco.runFwd` is the only other clip in the library that keys
      // it, and it is the only other one that reads as having an arm of its own.
      clavicle_L: [{ t: 0, r: [0, -10, -4], ease: 'sine' }, { t: 9, r: [-10, -18, 6], ease: 'sine' },
        { t: 15, r: [-4, -6, 0], ease: 'expo' }, { t: 20, r: [14, 10, -12], ease: 'snap' },
        { t: 24, r: [17, 13, -14], ease: 'quad' }, { t: 32, r: [8, 16, -6], ease: 'sine' },
        { t: 40, r: [2, 10, -2], ease: 'sine' }, { t: 48, r: [0, -10, -4], ease: 'linear' }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 9, r: [-37.6, -10.7, -32.7], ease: 'sine' },
        { t: 15, r: [16.1, -29.2, -29.6], ease: 'sine' }, { t: 20, r: [67.4, 16.9, -45.1], ease: 'sine' },
        { t: 24, r: [70.9, 20.4, -46.8], ease: 'quad' }, { t: 32, r: [-13.1, 111.7, 25], ease: 'sine' },
        { t: 40, r: [-25.6, 152.4, 51], ease: 'sine' }, { t: 48, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 9, r: [-123.6, 0, 17], ease: 'sine' },
        { t: 15, r: [-152, 0, 17], ease: 'sine' }, { t: 24, r: [-155.12, 0, 17], ease: 'quad' },
        { t: 32, r: [-122.1, 0, 17], ease: 'sine' }, { t: 40, r: [-129.5, 0, 17], ease: 'sine' },
        { t: 48, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'sine' }, { t: 9, r: [-8, 10, 0], ease: 'sine' },
        { t: 15, r: [-8, 4, 0], ease: 'expo' }, { t: 20, r: [-8, -16, 0], ease: 'snap' },
        { t: 24, r: [-8, -20, 0], ease: 'quad' }, { t: 32, r: [-8, -8, 0], ease: 'sine' },
        { t: 40, r: [-8, 4, 0], ease: 'sine' }, { t: 48, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'sine' }, { t: 9, r: [-26, 0, 0], ease: 'sine' },
        { t: 15, r: [-18, 0, 0], ease: 'expo' }, { t: 20, r: [-2, 0, -5], ease: 'snap' },
        { t: 24, r: [2, 0, -7], ease: 'quad' }, { t: 32, r: [-10, 0, -2], ease: 'sine' },
        { t: 40, r: [-16, 0, 0], ease: 'sine' }, { t: 48, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 9, r: [-28.8, -23.4, 27.2], ease: 'sine' },
        { t: 15, r: [-52.5, -14.5, 47.6], ease: 'sine' }, { t: 20, r: [46.6, -88.4, 44.1], ease: 'sine' },
        { t: 24, r: [50.1, -91.9, 43.72], ease: 'quad' }, { t: 32, r: [8.7, -65.8, 82.2], ease: 'sine' },
        { t: 40, r: [6.6, -188.3, -61.3], ease: 'sine' }, { t: 48, r: [158, -180, -144], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 9, r: [-114.6, 0, -1], ease: 'sine' },
        { t: 15, r: [-114.8, 0, -1], ease: 'sine' }, { t: 20, r: [-56.1, 0, -1], ease: 'sine' },
        { t: 24, r: [-52.6, 0, -1], ease: 'quad' }, { t: 32, r: [-95.8, 0, -1], ease: 'sine' },
        { t: 40, r: [-145.1, 0, -1], ease: 'sine' }, { t: 48, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 9, r: [-18, -14, 10], ease: 'sine' },
        { t: 15, r: [-15.69, -16.64, 9.89], ease: 'sine' }, { t: 20, r: [-18, -4, 6], ease: 'sine' },
        { t: 24, r: [-18, -2.9, 5.56], ease: 'quad' }, { t: 32, r: [-12, -4, 6], ease: 'sine' },
        { t: 40, r: [-16, -14, 10], ease: 'sine' }, { t: 48, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 9, r: [34, 0, 0], ease: 'sine' },
        { t: 15, r: [22, 0, 0], ease: 'sine' }, { t: 20, r: [10, 0, 0], ease: 'sine' },
        { t: 24, r: [8.68, 0, 0], ease: 'quad' }, { t: 32, r: [20, 0, 0], ease: 'sine' },
        { t: 40, r: [34, 0, 0], ease: 'sine' }, { t: 48, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 9, r: [-31.6, 2, 0], ease: 'sine' },
        { t: 15, r: [-19.7, 2, 0], ease: 'sine' }, { t: 20, r: [-8.3, 2, 0], ease: 'sine' },
        { t: 24, r: [-7.05, 2, 0], ease: 'quad' }, { t: 32, r: [-24.9, 2, 0], ease: 'sine' },
        { t: 40, r: [-34.6, 2, 0], ease: 'sine' }, { t: 48, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [8.3, 0, 0], ease: 'sine' },
        { t: 15, r: [4.7, 0, 0], ease: 'sine' }, { t: 20, r: [1.3, 0, 0], ease: 'sine' },
        { t: 24, r: [0.93, 0, 0], ease: 'quad' }, { t: 32, r: [6.3, 0, 0], ease: 'sine' },
        { t: 40, r: [9.2, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [4.7, 0, 0], ease: 'sine' },
        { t: 15, r: [2.7, 0, 0], ease: 'sine' }, { t: 20, r: [0.7, 0, 0], ease: 'sine' },
        { t: 24, r: [0.48, 0, 0], ease: 'quad' }, { t: 32, r: [3.6, 0, 0], ease: 'sine' },
        { t: 40, r: [5.2, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 4, r: [3.04, 2.68, -25], ease: 'sine' },
        { t: 9, r: [-17.2, -46.1, -15.4], ease: 'sine' }, { t: 15, r: [-82.6, 52.5, 0.5], ease: 'linear' },
        { t: 18, r: [-77.75, 18.66, 17.67], ease: 'linear' }, { t: 19, r: [-73.61, -10.18, 32.3], ease: 'linear' },
        { t: 20, r: [-68.1, -48.6, 51.8], ease: 'snap' }, { t: 24, r: [-64.44, -56.6, 59.8], ease: 'sine' },
        { t: 27, r: [-63.96, -69.79, 64.28], ease: 'quad' }, { t: 32, r: [-1.1, 26.9, 59], ease: 'sine' },
        { t: 40, r: [2, 6, -13], ease: 'sine' }, { t: 48, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 4, r: [53.62, 0, 0], ease: 'sine' },
        { t: 9, r: [2, 0, 0], ease: 'sine' }, { t: 15, r: [90.5, 0, 0], ease: 'linear' },
        { t: 18, r: [64.96, 0, 0], ease: 'linear' }, { t: 19, r: [43.2, 0, 0], ease: 'linear' },
        { t: 20, r: [14.2, 0, 0], ease: 'snap' }, { t: 24, r: [6.2, 0, 0], ease: 'sine' },
        { t: 27, r: [11.8, 0, 0], ease: 'quad' }, { t: 32, r: [9.3, 0, 0], ease: 'sine' },
        { t: 40, r: [30, 0, 0], ease: 'sine' }, { t: 48, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 4, r: [-41, -3.37, 0], ease: 'sine' },
        { t: 9, r: [18, 0, 0], ease: 'sine' }, { t: 15, r: [26, 0, 0], ease: 'linear' },
        { t: 18, r: [28.01, 0, 0], ease: 'linear' }, { t: 19, r: [29.72, 0, 0], ease: 'linear' },
        { t: 20, r: [32, 0, 0], ease: 'snap' }, { t: 24, r: [40, 0, 0], ease: 'sine' },
        { t: 27, r: [30.4, 0, 0], ease: 'quad' }, { t: 32, r: [20, 0, 0], ease: 'sine' },
        { t: 40, r: [-49.6, -3, 0], ease: 'sine' }, { t: 48, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [-6, 0, 0], ease: 'sine' },
        { t: 9, r: [-4.8, 0, 0], ease: 'sine' }, { t: 15, r: [-12, 0, 0], ease: 'linear' },
        { t: 18, r: [0.05, 0, 0], ease: 'linear' }, { t: 19, r: [10.32, 0, 0], ease: 'linear' },
        { t: 20, r: [24, 0, 0], ease: 'snap' }, { t: 24, r: [32, 0, 0], ease: 'sine' },
        { t: 27, r: [31, 0, 0], ease: 'sine' }, { t: 32, r: [-8, 0, 0], ease: 'sine' },
        { t: 40, r: [-11.5, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [2.8, 0, 0], ease: 'sine' },
        { t: 15, r: [7, 0, 0], ease: 'sine' }, { t: 20, r: [-11, 0, 0], ease: 'sine' },
        { t: 24, r: [-12.98, 0, 0], ease: 'quad' }, { t: 27, r: [-15, 0, 0], ease: 'sine' },
        { t: 32, r: [6, 0, 0], ease: 'sine' }, { t: 40, r: [8.31, 0, 0], ease: 'sine' },
        { t: 48, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i24. Foot swings up past the head, hangs for two ticks at tick 19-21 — all
  // the readability is in that hang — then the heel drops on a straight line.
  'k.axeKick': {
    name: 'Axe Kick',
    duration: 48, blendIn: 4, blendOut: 10,
    impact: { tick: 19, bone: 'foot_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'linear' },
      { t: 1, p: [0, -0.075, 0], ease: 'linear' },
      { t: 2, p: [0, -0.076, 0], ease: 'linear' },
      { t: 3, p: [0, -0.077, 0], ease: 'linear' },
      { t: 4, p: [0, -0.079, 0], ease: 'linear' },
      { t: 5, p: [0, -0.081, 0], ease: 'linear' },
      { t: 6, p: [0, -0.083, 0], ease: 'linear' },
      { t: 7, p: [0, -0.086, 0.001], ease: 'linear' },
      { t: 8, p: [0, -0.088, 0.001], ease: 'linear' },
      { t: 9, p: [0, -0.089, 0.002], ease: 'linear' },
      { t: 10, p: [0, -0.091, 0.003], ease: 'linear' },
      { t: 11, p: [0, -0.092, 0.005], ease: 'linear' },
      { t: 12, p: [0, -0.092, 0.006], ease: 'linear' },
      { t: 13, p: [0, -0.091, 0.009], ease: 'linear' },
      { t: 14, p: [0, -0.087, 0.012], ease: 'linear' },
      { t: 15, p: [0, -0.083, 0.016], ease: 'linear' },
      { t: 16, p: [0, -0.077, 0.02], ease: 'linear' },
      { t: 17, p: [0, -0.072, 0.026], ease: 'linear' },
      { t: 18, p: [0, -0.069, 0.032], ease: 'linear' },
      { t: 19, p: [0, -0.068, 0.04], ease: 'sine' },
      { t: 21, p: [0, -0.065, 0.042], ease: 'linear' },
      { t: 24, p: [0, -0.174, 0.14], ease: 'sine' },
      { t: 28, p: [0, -0.186, 0.151], ease: 'quad' },
      { t: 36, p: [0, -0.133, 0.16], ease: 'sine' },
      { t: 48, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [2.01, -29.73, -0.5], ease: 'linear' },
        { t: 12, r: [0.99, -27.78, 0.01], ease: 'linear' }, { t: 17, r: [-1.26, -23.47, 1.13], ease: 'linear' },
        { t: 18, r: [-1.9, -22.25, 1.45], ease: 'linear' }, { t: 19, r: [-2.6, -20.9, 1.8], ease: 'sine' },
        { t: 21, r: [-2.81, -20.65, 1.87], ease: 'linear' }, { t: 24, r: [3.8, -19.7, 0.9], ease: 'sine' },
        { t: 28, r: [4.5, -19.57, 0.8], ease: 'quad' }, { t: 36, r: [2.2, -23.2, 0.6], ease: 'sine' },
        { t: 48, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [3.92, 5.34, -0.84], ease: 'linear' },
        { t: 12, r: [1.88, 5.2, 0.01], ease: 'linear' }, { t: 17, r: [-2.62, 4.89, 1.88], ease: 'linear' },
        { t: 18, r: [-3.89, 4.8, 2.41], ease: 'linear' }, { t: 19, r: [-5.3, 4.7, 3], ease: 'sine' },
        { t: 21, r: [-5.73, 4.68, 3.11], ease: 'linear' }, { t: 24, r: [7.7, 4.6, 1.5], ease: 'sine' },
        { t: 28, r: [9.13, 4.59, 1.34], ease: 'quad' }, { t: 36, r: [4.3, 4.9, 1], ease: 'sine' },
        { t: 48, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [5.29, 6.27, -0.95], ease: 'linear' },
        { t: 12, r: [2.57, 6.1, 0.01], ease: 'linear' }, { t: 17, r: [-3.43, 5.72, 2.13], ease: 'linear' },
        { t: 18, r: [-5.13, 5.62, 2.73], ease: 'linear' }, { t: 19, r: [-7, 5.5, 3.4], ease: 'sine' },
        { t: 21, r: [-7.56, 5.48, 3.53], ease: 'linear' }, { t: 24, r: [10.2, 5.4, 1.7], ease: 'sine' },
        { t: 28, r: [12.09, 5.39, 1.51], ease: 'quad' }, { t: 36, r: [5.8, 5.7, 1.1], ease: 'sine' },
        { t: 48, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [5.29, 7.52, -4.06], ease: 'linear' },
        { t: 12, r: [2.57, 7.29, -2.98], ease: 'linear' }, { t: 17, r: [-3.43, 6.79, -0.61], ease: 'linear' },
        { t: 18, r: [-5.13, 6.65, 0.06], ease: 'linear' }, { t: 19, r: [-7, 6.5, 0.8], ease: 'sine' },
        { t: 21, r: [-7.56, 6.47, 0.93], ease: 'linear' }, { t: 24, r: [10.2, 6.4, -1.1], ease: 'sine' },
        { t: 28, r: [12.09, 6.39, -1.31], ease: 'quad' }, { t: 36, r: [5.8, 6.8, -1.7], ease: 'sine' },
        { t: 48, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 12, r: [1.3, 4, 0], ease: 'sine' },
        { t: 19, r: [2.1, 3.4, 0], ease: 'sine' }, { t: 21, r: [2.19, 3.33, 0], ease: 'linear' },
        { t: 24, r: [-0.6, 3.1, 0], ease: 'sine' }, { t: 28, r: [-0.9, 3.07, 0], ease: 'quad' },
        { t: 36, r: [0.1, 4, 0], ease: 'sine' }, { t: 48, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 12, r: [3.4, 5.8, 0], ease: 'sine' },
        { t: 19, r: [4.3, 4.7, 0], ease: 'sine' }, { t: 21, r: [4.4, 4.58, 0], ease: 'linear' },
        { t: 24, r: [1.1, 4.1, 0], ease: 'sine' }, { t: 28, r: [0.75, 4.03, 0], ease: 'quad' },
        { t: 36, r: [1.9, 5.8, 0], ease: 'sine' }, { t: 48, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 12, r: [-20.2, 5.9, -21.9], ease: 'sine' },
        { t: 19, r: [-5.3, 45.6, 104.1], ease: 'sine' }, { t: 21, r: [-3.66, 49.1, 107.6], ease: 'linear' },
        { t: 24, r: [11.8, 2.6, -29.8], ease: 'sine' }, { t: 28, r: [13.68, -0.9, -33.3], ease: 'quad' },
        { t: 36, r: [-44.1, 5.7, -34.9], ease: 'sine' }, { t: 48, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 12, r: [-109.5, 0, 17], ease: 'sine' },
        { t: 19, r: [-95.1, 0, 17], ease: 'sine' }, { t: 21, r: [-93.52, 0, 17], ease: 'linear' },
        { t: 24, r: [-152, 0, 17], ease: 'sine' }, { t: 28, r: [-155.5, 0, 17], ease: 'quad' },
        { t: 36, r: [-124, 0, 17], ease: 'sine' }, { t: 41, r: [-120.92, 0, 17], ease: 'sine' }, { t: 48, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 12, r: [-23.3, -5.2, 23.4], ease: 'sine' },
        { t: 19, r: [-10.8, 4.1, 26.6], ease: 'sine' }, { t: 21, r: [-9.43, 5.12, 26.95], ease: 'linear' },
        { t: 24, r: [-7.9, 16.1, 19.1], ease: 'sine' }, { t: 28, r: [-7.58, 17.42, 18.28], ease: 'quad' },
        { t: 36, r: [-25.7, -5.5, 27.2], ease: 'sine' }, { t: 48, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 12, r: [-114.3, 0, -1], ease: 'sine' },
        { t: 19, r: [-113.9, 0, -1], ease: 'sine' }, { t: 21, r: [-113.86, 0, -1], ease: 'linear' },
        { t: 24, r: [-152, 0, -1], ease: 'sine' }, { t: 28, r: [-155.5, 0, -1], ease: 'quad' },
        { t: 36, r: [-145.5, 0, -1], ease: 'sine' }, { t: 48, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 4, r: [-26, 18.01, 7.57], ease: 'linear' },
        { t: 12, r: [-32.89, 13.77, 9.38], ease: 'linear' }, { t: 17, r: [-74.01, -11.56, 20.22], ease: 'linear' },
        { t: 18, r: [-90.58, -21.76, 24.59], ease: 'linear' }, { t: 19, r: [-111.1, -34.4, 30], ease: 'snap' },
        { t: 21, r: [-119.1, -42.4, 30], ease: 'sine' }, { t: 24, r: [-128.2, -52.56, 30], ease: 'sine' },
        { t: 28, r: [-71.1, 11.6, 25.67], ease: 'quad' }, { t: 31, r: [-61.2, 15.8, 23.5], ease: 'quad' },
        { t: 36, r: [-30, -16, 10], ease: 'sine' }, { t: 48, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 4, r: [53.2, 0, 0], ease: 'linear' },
        { t: 12, r: [49.06, 0, 0], ease: 'linear' }, { t: 17, r: [24.32, 0, 0], ease: 'linear' },
        { t: 18, r: [14.35, 0, 0], ease: 'linear' }, { t: 19, r: [2, 0, 0], ease: 'snap' },
        { t: 21, r: [-6, 0, 0], ease: 'sine' }, { t: 24, r: [46, 0, 0], ease: 'sine' },
        { t: 28, r: [49.5, 0, 0], ease: 'quad' }, { t: 31, r: [42.4, 0, 0], ease: 'quad' },
        { t: 36, r: [34, 0, 0], ease: 'sine' }, { t: 48, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 4, r: [1.04, 2.56, 0], ease: 'linear' },
        { t: 12, r: [-0.82, 2.35, 0], ease: 'linear' }, { t: 17, r: [-11.96, 1.11, 0], ease: 'linear' },
        { t: 18, r: [-16.44, 0.61, 0], ease: 'linear' }, { t: 19, r: [-22, 0, 0], ease: 'snap' },
        { t: 21, r: [-30, 0, 0], ease: 'sine' }, { t: 24, r: [24, 0, 0], ease: 'sine' },
        { t: 28, r: [27.5, 0, 0], ease: 'quad' }, { t: 31, r: [30.2, 0.2, 0], ease: 'quad' },
        { t: 36, r: [-21.8, 2, 0], ease: 'sine' }, { t: 48, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [-1.49, 0, 0], ease: 'linear' },
        { t: 12, r: [-0.94, 0, 0], ease: 'linear' }, { t: 17, r: [2.36, 0, 0], ease: 'linear' },
        { t: 18, r: [3.69, 0, 0], ease: 'linear' }, { t: 19, r: [5.33, 0, 0], ease: 'snap' },
        { t: 21, r: [14.33, 0, 0], ease: 'sine' }, { t: 24, r: [-22, 0, 0], ease: 'sine' },
        { t: 28, r: [-25.5, 0, 0], ease: 'quad' }, { t: 31, r: [-28, 0, 0], ease: 'sine' },
        { t: 36, r: [6, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 12, r: [-2.4, 0, 0], ease: 'sine' },
        { t: 19, r: [-2.66, 0, 0], ease: 'hold' }, { t: 21, r: [-6, 0, 0], ease: 'linear' },
        { t: 24, r: [12, 0, 0], ease: 'sine' }, { t: 28, r: [13.98, 0, 0], ease: 'quad' },
        { t: 31, r: [16, 0, 0], ease: 'sine' }, { t: 36, r: [-5, 0, 0], ease: 'sine' },
        { t: 48, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'sine' }, { t: 12, r: [4, 6, -13], ease: 'sine' },
        { t: 28, r: [5.43, 7.32, -13.11], ease: 'quad' }, { t: 36, r: [6, 6, -13], ease: 'sine' },
        { t: 48, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'sine' }, { t: 12, r: [18, 0, 0], ease: 'sine' },
        { t: 19, r: [10, 0, 0], ease: 'sine' }, { t: 21, r: [9.12, 0, 0], ease: 'linear' },
        { t: 24, r: [34, 0, 0], ease: 'sine' }, { t: 28, r: [36.64, 0, 0], ease: 'quad' },
        { t: 36, r: [28, 0, 0], ease: 'sine' }, { t: 48, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'sine' }, { t: 12, r: [-38, -3, 0], ease: 'sine' },
        { t: 19, r: [-28.9, -3, 0], ease: 'sine' }, { t: 21, r: [-27.9, -3, 0], ease: 'linear' },
        { t: 24, r: [-57.1, -3, 0], ease: 'sine' }, { t: 28, r: [-60.2, -3, 0], ease: 'quad' },
        { t: 36, r: [-51.9, -3, 0], ease: 'sine' }, { t: 48, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 12, r: [1.5, 0, 0], ease: 'sine' },
        { t: 19, r: [-1.2, 0, 0], ease: 'sine' }, { t: 21, r: [-1.5, 0, 0], ease: 'linear' },
        { t: 24, r: [7.2, 0, 0], ease: 'sine' }, { t: 28, r: [8.12, 0, 0], ease: 'quad' },
        { t: 36, r: [5.7, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 12, r: [0.9, 0, 0], ease: 'sine' },
        { t: 19, r: [-0.7, 0, 0], ease: 'sine' }, { t: 21, r: [-0.88, 0, 0], ease: 'linear' },
        { t: 24, r: [4.1, 0, 0], ease: 'sine' }, { t: 28, r: [4.63, 0, 0], ease: 'quad' },
        { t: 36, r: [3.2, 0, 0], ease: 'sine' }, { t: 48, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i16. Drops to a hand-planted crouch and scythes the rear leg through 140
  // degrees of root yaw at ankle height. Crushes highs by construction.
  //
  // That is what the comment always said; until now the data said otherwise.
  // Measured through the rig, the pelvis only ever fell to 626mm — a standing
  // fighter swinging a leg — the support knee held 112 degrees, and the "planted"
  // left hand sat at 1019mm, chest height, through the whole active window. Three
  // moves put a LOW hitbox on that hand.
  //
  // The pose below is solved rather than drawn. Every limb angle in the active
  // frames comes out of a bounded fit against explicit floor contacts, run key by
  // key and seeded from the key before so the tracks stay continuous: the support
  // sole, the sweeping toe and the planting wrist are each placed, and the joints
  // are whatever puts them there. The rig's own two-bone IK could not be used to
  // bake it — its pole vectors are model-space constants and this clip yaws the
  // root through 180 degrees, so the knee is forced to break toward model +Z
  // however the body is facing, and the solutions come back gimbal-twisted and
  // lerp through garbage. Measured after: pelvis 380mm at contact, support knee
  // 138 degrees, hand 134mm with the fingers at 62mm, and every contact within
  // 22mm of where it was asked for.
  //
  // Every track carries the same twelve tick stamps, including the root, and that
  // is load-bearing rather than tidy. With the root easing between 8.05 and 14.32
  // on its own stamps it plunged 127mm in the tick after the leg's key, and the
  // support boot went 94mm through the concrete waiting for the leg to catch up.
  // Sampled every tick through the rig, the support sole now holds 2-8mm above
  // the floor for the entire move; the sweeping toe dips 79mm once, at the tick
  // the leg is crossing 45 degrees per frame, which is a foot in flight.
  'k.sweep': {
    name: 'Sweep',
    duration: 38, blendIn: 4, blendOut: 9,
    impact: { tick: 17, bone: 'knee_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ry: 0, ease: 'quad' },
      { t: 2, p: [0, -0.1305, 0.005], ry: 0, ease: 'quart' },
      { t: 4, p: [0, -0.1861, 0.0099], ry: 0, ease: 'quart' },
      { t: 8.05, p: [0, -0.3, 0.02], ry: 0, ease: 'quart' },
      { t: 11, p: [0, -0.4078, 0.0357], ry: -18, ease: 'quad' },
      { t: 14.32, p: [0, -0.575, 0.06], ry: -46, ease: 'quad' },
      { t: 16.5, p: [0, -0.5862, 0.0779], ry: -88, ease: 'quad' },
      { t: 19, p: [0, -0.6, 0.1], ry: -140, ease: 'sine' },
      { t: 22, p: [0, -0.55, 0.1], ry: -168, ease: 'sine' },
      { t: 25, p: [0, -0.375, 0.09], ry: -174, ease: 'sine' },
      { t: 28, p: [0, -0.2, 0.08], ry: -180, ease: 'sine' },
      { t: 32, p: [0, -0.1568, 0.0524], ry: -180, ease: 'sine' },
      { t: 38, p: [0, -0.075, 0], ry: -180, ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 1, r: [0.06, -32.6, -0.34], ease: 'sine' },
        { t: 2, r: [2.24, -28.1, 0.22], ease: 'quart' }, { t: 4, r: [3.47, -28.39, 0.44], ease: 'quart' },
        { t: 8.05, r: [6, -29, 0.9], ease: 'quart' }, { t: 11, r: [5.61, -23.08, 1.14], ease: 'quad' },
        { t: 14.32, r: [5, -13.9, 1.5], ease: 'quad' }, { t: 16.5, r: [4.55, -10.28, 1.28], ease: 'quad' },
        { t: 17, r: [4.51, -9.92, 1.26], ease: 'quad' }, { t: 19, r: [4, -5.8, 1], ease: 'sine' },
        { t: 22, r: [4, -9, 1], ease: 'sine' }, { t: 25, r: [3.45, -14.35, 0.8], ease: 'sine' },
        { t: 28, r: [2.9, -19.7, 0.6], ease: 'sine' }, { t: 32, r: [2.24, -22.5, 0.39], ease: 'sine' },
        { t: 38, r: [1, -27.8, 0], ease: 'linear' }],
      // The trunk folds forward AND rolls onto the planting side. The roll is
      // what actually gets the hand down: the spine is only 450mm long, so
      // pitching it buys 50mm, while 30 degrees of roll drops the left shoulder
      // by 105mm because the shoulder sits 210mm off the spine axis.
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 1, r: [-1.3, 5.46, 1.83], ease: 'sine' },
        { t: 2, r: [4.39, 5.22, -0.99], ease: 'quart' }, { t: 4, r: [6.89, 5.25, -1.98], ease: 'quart' },
        { t: 8.05, r: [12, 5.3, -4], ease: 'quart' }, { t: 11, r: [14.35, 4.87, -5.96], ease: 'quad' },
        { t: 14.32, r: [18, 4.2, -9], ease: 'quad' }, { t: 16.5, r: [18.45, 3.89, -9.45], ease: 'quad' },
        { t: 17, r: [18.49, 3.86, -9.49], ease: 'quad' }, { t: 19, r: [19, 3.5, -10], ease: 'sine' },
        { t: 22, r: [17, 3.8, -9], ease: 'sine' }, { t: 25, r: [12, 4.2, -6], ease: 'sine' },
        { t: 28, r: [7, 4.6, -3], ease: 'sine' }, { t: 32, r: [5.24, 4.81, -1.96], ease: 'sine' },
        { t: 38, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 1, r: [-0.6, 6.36, 1.95], ease: 'sine' },
        { t: 2, r: [5.66, 6.15, -1.24], ease: 'quart' }, { t: 4, r: [8.72, 6.2, -2.47], ease: 'quart' },
        { t: 8.05, r: [15, 6.3, -5], ease: 'quart' }, { t: 11, r: [17.35, 5.75, -7.35], ease: 'quad' },
        { t: 14.32, r: [21, 4.9, -11], ease: 'quad' }, { t: 16.5, r: [21.45, 4.59, -11.45], ease: 'quad' },
        { t: 17, r: [21.49, 4.56, -11.49], ease: 'quad' }, { t: 19, r: [22, 4.2, -12], ease: 'sine' },
        { t: 22, r: [20, 4.5, -10], ease: 'sine' }, { t: 25, r: [14.5, 4.95, -6.5], ease: 'sine' },
        { t: 28, r: [9, 5.4, -3], ease: 'sine' }, { t: 32, r: [6.79, 5.64, -1.96], ease: 'sine' },
        { t: 38, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 1, r: [-1.4, 7.76, -0.52], ease: 'sine' },
        { t: 2, r: [5.42, 7.33, -3.74], ease: 'quart' }, { t: 4, r: [8.23, 7.35, -4.48], ease: 'quart' },
        { t: 8.05, r: [14, 7.4, -6], ease: 'quart' }, { t: 11, r: [15.96, 6.77, -8.74], ease: 'quad' },
        { t: 14.32, r: [19, 5.8, -13], ease: 'quad' }, { t: 16.5, r: [19.45, 5.4, -13.45], ease: 'quad' },
        { t: 17, r: [19.49, 5.36, -13.49], ease: 'quad' }, { t: 19, r: [20, 4.9, -14], ease: 'sine' },
        { t: 22, r: [18, 5.2, -12], ease: 'sine' }, { t: 25, r: [13, 5.8, -8], ease: 'sine' },
        { t: 28, r: [8, 6.4, -4], ease: 'sine' }, { t: 32, r: [6.13, 6.71, -3.65], ease: 'sine' },
        { t: 38, r: [2.6, 7.3, -3], ease: 'linear' }],
      // The head stays up and looking down the sweep while the trunk goes over.
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 2, r: [-0.16, 5.27, 0.49], ease: 'quart' }, { t: 4, r: [-0.93, 5.35, 0.99], ease: 'quart' }, { t: 8.05, r: [-2.5, 5.5, 2], ease: 'quart' },
        { t: 11, r: [-3.87, 4.01, 3.18], ease: 'quad' }, { t: 14.32, r: [-6, 1.7, 5], ease: 'quad' }, { t: 16.5, r: [-6.45, 0.76, 5], ease: 'quad' },
        { t: 19, r: [-7, -0.4, 5], ease: 'sine' }, { t: 22, r: [-6, 1, 4], ease: 'sine' }, { t: 25, r: [-3.5, 2.05, 2.5], ease: 'sine' },
        { t: 28, r: [-1, 3.1, 1], ease: 'sine' }, { t: 32, r: [-0.45, 3.83, 0.65], ease: 'sine' }, { t: 38, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 2, r: [1.39, 8.13, 0.74], ease: 'quart' }, { t: 4, r: [0.28, 8.25, 1.48], ease: 'quart' }, { t: 8.05, r: [-2, 8.5, 3], ease: 'quart' },
        { t: 11, r: [-4.35, 5.72, 4.57], ease: 'quad' }, { t: 14.32, r: [-8, 1.4, 7], ease: 'quad' }, { t: 16.5, r: [-8.45, -0.3, 7.45], ease: 'quad' },
        { t: 19, r: [-9, -2.4, 8], ease: 'sine' }, { t: 22, r: [-7, 0.5, 7], ease: 'sine' }, { t: 25, r: [-3.25, 2.3, 4.5], ease: 'sine' },
        { t: 28, r: [0.5, 4.1, 2], ease: 'sine' }, { t: 32, r: [1.19, 5.45, 1.31], ease: 'sine' }, { t: 38, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      // The planting arm: down to the floor by t16.5 and held there through the
      // strike, then whipped up and over with the body's own 180-degree unwind.
      // It carries a key at every stamp the legs and the root do, so the hand
      // cannot drift off the floor while the pelvis is still moving under it.
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 8.05, r: [-52.4, -38.9, -12.7], ease: 'quart' }, { t: 11, r: [-52.4, 5.9, 30.4], ease: 'quad' },
        { t: 14.32, r: [-49.6, -6.5, 26.6], ease: 'quad' }, { t: 16.5, r: [-62.2, -5.6, 38.2], ease: 'quad' }, { t: 19, r: [-61.4, -5.5, 37.5], ease: 'sine' },
        { t: 22, r: [-52.2, -1.7, 45.3], ease: 'sine' }, { t: 28, r: [149.4, 18.3, -128.9], ease: 'sine' }, { t: 38, r: [145, 180, -216], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 8.05, r: [-16.1, 0, 17], ease: 'quart' }, { t: 11, r: [-65.6, -6.5, 44.2], ease: 'quad' },
        { t: 14.32, r: [-65, -6.1, 43.3], ease: 'quad' }, { t: 16.5, r: [-32.4, 12.7, 26.1], ease: 'quad' }, { t: 19, r: [-34.4, 13.3, 31], ease: 'sine' },
        { t: 22, r: [-28.4, 19, 30.1], ease: 'sine' }, { t: 28, r: [-128.4, 0, 17], ease: 'sine' }, { t: 38, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 8.05, r: [-12.6, 17.6, 13.2], ease: 'quart' },
        { t: 14.32, r: [5.6, 182.5, 23.6], ease: 'sine' }, { t: 19, r: [72.9, 248.2, 142.9], ease: 'sine' },
        { t: 28, r: [182, 375.4, 124.1], ease: 'sine' }, { t: 38, r: [338, 360, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 8.05, r: [-152, 0, -1], ease: 'quart' },
        { t: 14.32, r: [-74.4, 0, -1], ease: 'sine' }, { t: 19, r: [-83.9, 0, -1], ease: 'sine' },
        { t: 28, r: [-144.7, 0, -1], ease: 'sine' }, { t: 38, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      // Sweeping leg: chambered behind the body at t14.32, scythed through to
      // 500mm in front by t19, carried across to the far side by t22.
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 1, r: [-36.5, 20.4, 16.47], ease: 'sine' },
        { t: 2, r: [-24.7, -13.5, -6.5], ease: 'quart' }, { t: 4, r: [-41, -21, -9.2], ease: 'quart' },
        { t: 8.05, r: [-53.9, -21.7, -9.7], ease: 'quart' }, { t: 11, r: [-35.9, -27.6, -44.3], ease: 'quad' },
        { t: 14.32, r: [-6.7, -32.1, -45], ease: 'quad' }, { t: 16.5, r: [-52.6, -69.2, -30.2], ease: 'quad' },
        { t: 17, r: [-57.39, -66.62, -29.33], ease: 'quad' }, { t: 19, r: [-112.5, -36.9, -19.3], ease: 'sine' },
        { t: 22, r: [-112.5, 0.6, -36.1], ease: 'sine' }, { t: 25, r: [-81.7, 8.9, -45], ease: 'sine' },
        { t: 28, r: [-64.7, -4.1, -23.1], ease: 'sine' }, { t: 32, r: [-46.1, -35.9, -21.7], ease: 'sine' },
        { t: 38, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 1, r: [31.6, -0.77, -0.95], ease: 'sine' },
        { t: 2, r: [51.8, 8, 8], ease: 'quart' }, { t: 4, r: [77.4, 8, 0.3], ease: 'quart' },
        { t: 8.05, r: [99.9, 8, -2.6], ease: 'quart' }, { t: 11, r: [118.9, -8, -5.5], ease: 'quad' },
        { t: 14.32, r: [102.9, -8, -8], ease: 'quad' }, { t: 16.5, r: [132.7, 7.7, 8], ease: 'quad' },
        { t: 17, r: [130.04, 6.55, 8], ease: 'quad' }, { t: 19, r: [99.4, -6.7, 8], ease: 'sine' },
        { t: 22, r: [80.8, -4.2, -4.5], ease: 'sine' }, { t: 25, r: [90, -8, -8], ease: 'sine' },
        { t: 28, r: [87.7, -8, 0], ease: 'sine' }, { t: 32, r: [74.3, -8, -5.3], ease: 'sine' },
        { t: 38, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 2, r: [75, 10, 8], ease: 'quart' }, { t: 4, r: [69.8, 10, -8], ease: 'quart' },
        { t: 8.05, r: [57.6, 10, -8], ease: 'quart' }, { t: 11, r: [26, 10, -2.7], ease: 'quad' }, { t: 14.32, r: [18.2, 10, 7.2], ease: 'quad' },
        { t: 16.5, r: [2.4, 4.9, 4.6], ease: 'quad' }, { t: 19, r: [11.9, 5.7, 6.7], ease: 'sine' }, { t: 22, r: [11.9, 5.2, 6.2], ease: 'sine' },
        { t: 25, r: [-8.8, 5.6, 5.8], ease: 'sine' }, { t: 28, r: [-30.1, 2.8, 6], ease: 'sine' }, { t: 32, r: [-34.9, 3, 6.4], ease: 'sine' },
        { t: 38, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 2, r: [25, 6, 6], ease: 'quart' }, { t: 4, r: [25, 6, 6], ease: 'quart' },
        { t: 8.05, r: [25, 6, 6], ease: 'quart' }, { t: 11, r: [24.7, 6, 6], ease: 'quad' }, { t: 14.32, r: [11.7, 6, 6], ease: 'quad' },
        { t: 16.5, r: [-2, 0.5, 4.9], ease: 'quad' }, { t: 19, r: [2.6, 5.9, 2.9], ease: 'sine' }, { t: 22, r: [9.4, 5.4, 2.8], ease: 'sine' },
        { t: 25, r: [-0.4, 5.3, 2.5], ease: 'sine' }, { t: 28, r: [-1.3, 4.2, 2.3], ease: 'sine' }, { t: 32, r: [-7.4, 5.1, 2.9], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 2, r: [-7, 0, 0], ease: 'quart' }, { t: 4, r: [-7, 0, 0], ease: 'quart' },
        { t: 8.05, r: [-7, 0, 0], ease: 'quart' }, { t: 11, r: [-7, 0, 0], ease: 'quad' }, { t: 14.32, r: [-7, 0, 0], ease: 'quad' },
        { t: 16.5, r: [-7, 0, 0], ease: 'quad' }, { t: 19, r: [-7, 0, 0], ease: 'sine' }, { t: 22, r: [-7, 0, 0], ease: 'sine' },
        { t: 25, r: [-7, 0, 0], ease: 'sine' }, { t: 28, r: [-7, 0, 0], ease: 'sine' }, { t: 32, r: [-7, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      // Support leg: the deep-bent one. 138 degrees of knee through the active
      // frames, sole flat on the floor the whole way.
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 2, r: [-28.5, 3.8, -2], ease: 'quart' }, { t: 4, r: [-42.9, -4, -12.6], ease: 'quart' },
        { t: 8.05, r: [-56.7, -8.8, -24], ease: 'quart' }, { t: 11, r: [-59.9, -5.6, -43.9], ease: 'quad' }, { t: 14.32, r: [-46.7, 13.2, -53.3], ease: 'quad' },
        { t: 16.5, r: [-41.6, 13.5, -54], ease: 'quad' }, { t: 19, r: [-36.4, 12.3, -54.9], ease: 'sine' }, { t: 22, r: [-46.5, 10, -43.3], ease: 'sine' },
        { t: 25, r: [-53.6, -3.1, -30.2], ease: 'sine' }, { t: 28, r: [-45.9, -15.7, -23.7], ease: 'sine' }, { t: 32, r: [-45.7, -27.8, -24.5], ease: 'sine' },
        { t: 38, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 2, r: [55.7, 2.7, 2.1], ease: 'quart' }, { t: 4, r: [79.5, 7.7, 6.4], ease: 'quart' },
        { t: 8.05, r: [100.6, 8, 7.5], ease: 'quart' }, { t: 11, r: [118.5, -3.9, 8], ease: 'quad' }, { t: 14.32, r: [137, 8, 8], ease: 'quad' },
        { t: 16.5, r: [137, 8, 7.9], ease: 'quad' }, { t: 19, r: [137.9, 8, 8], ease: 'sine' }, { t: 22, r: [136.2, -5.5, 6.3], ease: 'sine' },
        { t: 25, r: [114.2, -8, 5.1], ease: 'sine' }, { t: 28, r: [83.9, -3.2, 5.2], ease: 'sine' }, { t: 32, r: [74.7, -1.3, -3.2], ease: 'sine' },
        { t: 38, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 2, r: [-25.3, -1.9, 0.6], ease: 'quart' }, { t: 4, r: [-32.3, -1, 3.5], ease: 'quart' },
        { t: 8.05, r: [-42, -0.2, 6.8], ease: 'quart' }, { t: 11, r: [-37.9, -12.8, 2.6], ease: 'quad' }, { t: 14.32, r: [-41.7, -9.7, 5.3], ease: 'quad' },
        { t: 16.5, r: [-40.6, -9.3, 7.4], ease: 'quad' }, { t: 19, r: [-44.2, -8.6, 10.4], ease: 'sine' }, { t: 22, r: [-42.2, -7.5, 12.1], ease: 'sine' },
        { t: 25, r: [-45.4, -4.8, 7.7], ease: 'sine' }, { t: 28, r: [-36, -0.3, 7.6], ease: 'sine' }, { t: 32, r: [-31.2, 0, 6.5], ease: 'sine' },
        { t: 38, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 2, r: [-5.4, -0.1, -0.1], ease: 'quart' }, { t: 4, r: [-10.5, -0.9, -0.3], ease: 'quart' },
        { t: 8.05, r: [-9.5, 0.9, 0.3], ease: 'quart' }, { t: 11, r: [-12.8, -1.2, -0.3], ease: 'quad' }, { t: 14.32, r: [-18, -3.8, -2.2], ease: 'quad' },
        { t: 16.5, r: [-18, -6, -5.6], ease: 'quad' }, { t: 19, r: [-18, -6, -6], ease: 'sine' }, { t: 22, r: [-18, -5.3, -5.2], ease: 'sine' },
        { t: 25, r: [-11.8, -1.4, -3.8], ease: 'sine' }, { t: 28, r: [-8, -2, -3.7], ease: 'sine' }, { t: 32, r: [-8.4, -1.6, -3.7], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 2, r: [0, 0, 0], ease: 'quart' }, { t: 4, r: [0, 0, 0], ease: 'quart' },
        { t: 8.05, r: [0, 0, 0], ease: 'quart' }, { t: 11, r: [0, 0, 0], ease: 'quad' }, { t: 14.32, r: [0, 0, 0], ease: 'quad' },
        { t: 16.5, r: [0, 0, 0], ease: 'quad' }, { t: 19, r: [0, 0, 0], ease: 'sine' }, { t: 22, r: [0, 0, 0], ease: 'sine' },
        { t: 25, r: [0, 0, 0], ease: 'sine' }, { t: 28, r: [0, 0, 0], ease: 'sine' }, { t: 32, r: [0, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i12. Close range. The hands pull down as the knee comes up so the two
  // motions meet at the same point in space.
  'k.kneeStrike': {
    name: 'Knee Strike',
    duration: 28, blendIn: 3, blendOut: 7,
    impact: { tick: 12, bone: 'knee_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 7, p: [0, -0.097, 0.02], ease: 'linear' },
      { t: 8, p: [0, -0.097, 0.024], ease: 'linear' },
      { t: 9, p: [0, -0.097, 0.037], ease: 'linear' },
      { t: 10, p: [0, -0.098, 0.06], ease: 'linear' },
      { t: 11, p: [0, -0.098, 0.094], ease: 'linear' },
      { t: 12, p: [0, -0.098, 0.14], ease: 'sine' },
      { t: 15, p: [0, -0.098, 0.153], ease: 'quad' },
      { t: 20, p: [0, -0.092, 0.08], ease: 'sine' },
      { t: 28, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [0.55, -32.98, -0.17], ease: 'sine' },
        { t: 7, r: [0.5, -30.2, 0.3], ease: 'linear' }, { t: 10, r: [1.62, -19.05, 0.46], ease: 'linear' },
        { t: 11, r: [2.1, -14.32, 0.53], ease: 'linear' }, { t: 12, r: [2.6, -9.3, 0.6], ease: 'sine' },
        { t: 15, r: [2.83, -7, 0.63], ease: 'quad' }, { t: 20, r: [1.7, -23.2, 0], ease: 'sine' },
        { t: 28, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [0.95, 5.59, -0.28], ease: 'sine' },
        { t: 7, r: [1, 5.4, 0.5], ease: 'linear' }, { t: 10, r: [3.29, 4.55, 0.77], ease: 'linear' },
        { t: 11, r: [4.27, 4.19, 0.88], ease: 'linear' }, { t: 12, r: [5.3, 3.8, 1], ease: 'sine' },
        { t: 15, r: [5.77, 3.62, 1.06], ease: 'quad' }, { t: 20, r: [3.4, 4.9, 0], ease: 'sine' },
        { t: 28, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [1.37, 6.55, -0.31], ease: 'sine' },
        { t: 7, r: [1.3, 6.4, 0.6], ease: 'linear' }, { t: 10, r: [4.34, 5.39, 0.87], ease: 'linear' },
        { t: 11, r: [5.63, 4.96, 0.98], ease: 'linear' }, { t: 12, r: [7, 4.5, 1.1], ease: 'sine' },
        { t: 15, r: [7.63, 4.29, 1.16], ease: 'quad' }, { t: 20, r: [4.5, 5.7, 0], ease: 'sine' },
        { t: 28, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [1.37, 7.86, -3.36], ease: 'sine' },
        { t: 7, r: [1.3, 7.5, -2.4], ease: 'linear' }, { t: 10, r: [4.34, 6.33, -2.03], ease: 'linear' },
        { t: 11, r: [5.63, 5.83, -1.87], ease: 'linear' }, { t: 12, r: [7, 5.3, -1.7], ease: 'sine' },
        { t: 15, r: [7.63, 5.06, -1.62], ease: 'quad' }, { t: 20, r: [4.5, 6.8, -3], ease: 'sine' },
        { t: 28, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 7, r: [0.8, 5.8, 0], ease: 'sine' },
        { t: 12, r: [-0.1, 0.5, 0], ease: 'sine' }, { t: 15, r: [-0.2, -0.08, 0], ease: 'quad' },
        { t: 20, r: [0.3, 4, 0], ease: 'sine' }, { t: 28, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 7, r: [2.8, 9, 0], ease: 'sine' },
        { t: 12, r: [1.7, -0.8, 0], ease: 'sine' }, { t: 15, r: [1.58, -1.88, 0], ease: 'quad' },
        { t: 20, r: [2.2, 5.8, 0], ease: 'sine' }, { t: 28, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 7, r: [-24.7, 12.9, -12.5], ease: 'sine' },
        { t: 12, r: [-53.4, -65.6, -1.8], ease: 'sine' }, { t: 15, r: [-56.56, -69.1, -0.62], ease: 'quad' },
        { t: 20, r: [-40.9, 1.2, -33.8], ease: 'sine' }, { t: 28, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 7, r: [-109.8, 0, 17], ease: 'sine' },
        { t: 12, r: [-28.3, 0, 17], ease: 'sine' }, { t: 15, r: [-24.8, 0, 17], ease: 'quad' },
        { t: 20, r: [-123.8, 0, 17], ease: 'sine' }, { t: 28, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 7, r: [-34.1, -10.2, 23.8], ease: 'sine' },
        { t: 12, r: [-44, 38.4, -5.6], ease: 'sine' }, { t: 15, r: [-45.09, 41.9, -8.83], ease: 'quad' },
        { t: 20, r: [-23.7, -5.5, 32.7], ease: 'sine' }, { t: 28, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 7, r: [-114.6, 0, -1], ease: 'sine' },
        { t: 12, r: [-26.9, 0, -1], ease: 'sine' }, { t: 15, r: [-23.4, 0, -1], ease: 'quad' },
        { t: 20, r: [-145.5, 0, -1], ease: 'sine' }, { t: 28, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 7, r: [-18, -14, 10], ease: 'sine' },
        { t: 12, r: [-24, -10, 9], ease: 'sine' }, { t: 15, r: [-24.66, -9.56, 8.89], ease: 'quad' },
        { t: 20, r: [-18, -14, 10], ease: 'sine' }, { t: 28, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 7, r: [28, 0, 0], ease: 'sine' },
        { t: 12, r: [20, 0, 0], ease: 'sine' }, { t: 15, r: [19.12, 0, 0], ease: 'quad' },
        { t: 20, r: [28, 0, 0], ease: 'sine' }, { t: 28, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 7, r: [-26, 2, 0], ease: 'sine' },
        { t: 12, r: [-15, 2, 0], ease: 'sine' }, { t: 15, r: [-13.79, 2, 0], ease: 'quad' },
        { t: 20, r: [-27, 2, 0], ease: 'sine' }, { t: 28, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [6.6, 0, 0], ease: 'sine' },
        { t: 12, r: [3.3, 0, 0], ease: 'sine' }, { t: 15, r: [2.94, 0, 0], ease: 'quad' },
        { t: 20, r: [6.9, 0, 0], ease: 'sine' }, { t: 28, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [3.7, 0, 0], ease: 'sine' },
        { t: 12, r: [1.9, 0, 0], ease: 'sine' }, { t: 15, r: [1.7, 0, 0], ease: 'quad' },
        { t: 20, r: [3.9, 0, 0], ease: 'sine' }, { t: 28, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 3, r: [4, -7.24, -12.86], ease: 'sine' },
        { t: 7, r: [-22.8, -55, -20.4], ease: 'linear' }, { t: 10, r: [-51.76, -35.38, -15.38], ease: 'linear' },
        { t: 11, r: [-76.43, -18.67, -11.1], ease: 'linear' }, { t: 12, r: [-109.3, 3.6, -5.4], ease: 'snap' },
        { t: 15, r: [-126.3, 15.11, -2.45], ease: 'sine' }, { t: 18, r: [-74, -8, -9], ease: 'sine' },
        { t: 20, r: [-30.1, -38, -13], ease: 'sine' }, { t: 28, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 3, r: [36.35, 0, 0], ease: 'sine' },
        { t: 7, r: [34, 0, 0], ease: 'linear' }, { t: 10, r: [48.03, 0, 0], ease: 'linear' },
        { t: 11, r: [59.98, 0, 0], ease: 'linear' }, { t: 12, r: [75.9, 0, 0], ease: 'snap' },
        { t: 15, r: [83.9, 0, 0], ease: 'sine' }, { t: 18, r: [72, 0, 0], ease: 'sine' },
        { t: 20, r: [52, 0, 0], ease: 'sine' }, { t: 28, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 7, r: [16, 0, 0], ease: 'sine' },
        { t: 12, r: [30, 0, 0], ease: 'sine' }, { t: 15, r: [31.54, 0, 0], ease: 'quad' },
        { t: 18, r: [31.1, 0, 0], ease: 'quad' }, { t: 20, r: [8, 0, 0], ease: 'sine' },
        { t: 28, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [-12, 0, 0], ease: 'sine' },
        { t: 12, r: [24, 0, 0], ease: 'sine' }, { t: 15, r: [27.5, 0, 0], ease: 'quad' },
        { t: 18, r: [31, 0, 0], ease: 'sine' }, { t: 20, r: [-8, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [7, 0, 0], ease: 'sine' },
        { t: 12, r: [-11, 0, 0], ease: 'sine' }, { t: 15, r: [-12.98, 0, 0], ease: 'quad' },
        { t: 18, r: [-15, 0, 0], ease: 'sine' }, { t: 20, r: [6, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i16. Turns fully side-on — the pelvis blades to 60 degrees and the head
  // stays locked on the target — chambers the knee to the chest, then drives
  // the heel out along a straight line.
  'k.sideKick': {
    name: 'Side Kick',
    duration: 38, blendIn: 4, blendOut: 8,
    impact: { tick: 16, bone: 'foot_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 8, p: [0, -0.12, 0.02], ease: 'sine' },
      { t: 13, p: [0, -0.114, 0.04], ease: 'linear' },
      { t: 14, p: [0, -0.114, 0.068], ease: 'linear' },
      { t: 15, p: [0, -0.115, 0.136], ease: 'linear' },
      { t: 16, p: [0, -0.116, 0.24], ease: 'sine' },
      { t: 20, p: [0, -0.116, 0.254], ease: 'quad' },
      { t: 27, p: [0, -0.126, 0.16], ease: 'sine' },
      { t: 38, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [1.5, -21.8, 0.83], ease: 'sine' },
        { t: 8, r: [0.7, -48.7, -1.5], ease: 'sine' }, { t: 13, r: [0.2, -55.7, -2.7], ease: 'linear' },
        { t: 14, r: [-0.31, -56.93, -3.18], ease: 'linear' }, { t: 15, r: [-0.97, -58.53, -3.81], ease: 'linear' },
        { t: 16, r: [-1.7, -60.3, -4.5], ease: 'sine' }, { t: 20, r: [-1.91, -60.81, -4.7], ease: 'quad' },
        { t: 27, r: [1.4, -40.6, -0.9], ease: 'sine' }, { t: 38, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [3.38, 4.5, 2.1], ease: 'sine' },
        { t: 8, r: [1.4, 6.8, -2.5], ease: 'sine' }, { t: 13, r: [0.5, 7.4, -4.5], ease: 'linear' },
        { t: 14, r: [-0.54, 7.48, -5.3], ease: 'linear' }, { t: 15, r: [-1.9, 7.58, -6.34], ease: 'linear' },
        { t: 16, r: [-3.4, 7.7, -7.5], ease: 'sine' }, { t: 20, r: [-3.83, 7.73, -7.83], ease: 'quad' },
        { t: 27, r: [2.9, 6.2, -1.5], ease: 'sine' }, { t: 38, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [4.59, 5.26, 2.35], ease: 'sine' },
        { t: 8, r: [1.9, 8.1, -2.8], ease: 'sine' }, { t: 13, r: [0.6, 8.7, -5], ease: 'linear' },
        { t: 14, r: [-0.76, 8.81, -5.91], ease: 'linear' }, { t: 15, r: [-2.53, 8.95, -7.09], ease: 'linear' },
        { t: 16, r: [-4.5, 9.1, -8.4], ease: 'sine' }, { t: 20, r: [-5.06, 9.14, -8.77], ease: 'quad' },
        { t: 27, r: [3.8, 7.3, -1.7], ease: 'sine' }, { t: 38, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [4.59, 6.32, -0.31], ease: 'sine' },
        { t: 8, r: [1.9, 9.5, -6.2], ease: 'sine' }, { t: 13, r: [0.6, 10.3, -8.8], ease: 'linear' },
        { t: 14, r: [-0.76, 10.43, -9.82], ease: 'linear' }, { t: 15, r: [-2.53, 10.61, -11.14], ease: 'linear' },
        { t: 16, r: [-4.5, 10.8, -12.6], ease: 'sine' }, { t: 20, r: [-5.06, 10.86, -13.02], ease: 'quad' },
        { t: 27, r: [3.8, 8.7, -4.9], ease: 'sine' }, { t: 38, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 8, r: [0.7, 24.5, 0], ease: 'sine' },
        { t: 13, r: [0.9, 30.5, 0], ease: 'sine' }, { t: 16, r: [1.7, 33.7, 0], ease: 'sine' },
        { t: 20, r: [1.79, 34.05, 0], ease: 'quad' }, { t: 27, r: [0.4, 17.5, 0], ease: 'sine' },
        { t: 38, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 8, r: [2.6, 43.8, 0], ease: 'sine' },
        { t: 13, r: [2.9, 54.9, 0], ease: 'sine' }, { t: 16, r: [3.8, 60.9, 0], ease: 'sine' },
        { t: 20, r: [3.9, 61.56, 0], ease: 'quad' }, { t: 27, r: [2.3, 30.9, 0], ease: 'sine' },
        { t: 38, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 8, r: [21.8, -20.9, -29.8], ease: 'sine' },
        { t: 13, r: [34.4, -5.1, -19.9], ease: 'sine' }, { t: 16, r: [40, 6.4, -9.8], ease: 'sine' },
        { t: 20, r: [40.62, 7.67, -8.69], ease: 'quad' }, { t: 27, r: [-31.8, 5.9, -26.8], ease: 'sine' },
        { t: 38, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 8, r: [-152, 0, 17], ease: 'sine' },
        { t: 13, r: [-155.08, 0, 17], ease: 'sine' }, { t: 16, r: [-135.4, 0, 17], ease: 'sine' },
        { t: 20, r: [-133.57, 0, 17], ease: 'quad' }, { t: 27, r: [-123.8, 0, 17], ease: 'sine' },
        { t: 38, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 8, r: [-46, -12.7, 33.6], ease: 'sine' },
        { t: 13, r: [-16.6, 39.2, 46.7], ease: 'sine' }, { t: 16, r: [-5.4, -124.5, -51.7], ease: 'sine' },
        { t: 20, r: [-4.17, -128, -55.2], ease: 'quad' }, { t: 27, r: [-31.8, -0.1, 39.1], ease: 'sine' },
        { t: 38, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 8, r: [-114.8, 0, -1], ease: 'sine' },
        { t: 13, r: [-152, 0, -1], ease: 'sine' }, { t: 16, r: [-87.4, 0, -1], ease: 'sine' },
        { t: 20, r: [-83.9, 0, -1], ease: 'quad' }, { t: 27, r: [-145.5, 0, -1], ease: 'sine' },
        { t: 38, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 4, r: [-34.13, 13.17, -2], ease: 'sine' },
        { t: 8, r: [-59.1, 25.4, 57], ease: 'sine' }, { t: 13, r: [-66, 9.9, 70], ease: 'linear' },
        { t: 14, r: [-65.32, 7.92, 70], ease: 'linear' }, { t: 15, r: [-63.64, 3.01, 70], ease: 'linear' },
        { t: 16, r: [-61.1, -4.4, 70], ease: 'expo' }, { t: 20, r: [-54.62, -23.32, 70], ease: 'quad' },
        { t: 23, r: [-58.6, -3.7, 66.9], ease: 'quad' }, { t: 27, r: [-48.9, 35.2, 40.9], ease: 'sine' },
        { t: 38, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 4, r: [53.2, 0, 0], ease: 'sine' },
        { t: 8, r: [66, 0, 0], ease: 'sine' }, { t: 13, r: [88.1, 0, 0], ease: 'linear' },
        { t: 14, r: [76.18, 0, 0], ease: 'linear' }, { t: 15, r: [46.6, 0, 0], ease: 'linear' },
        { t: 16, r: [2, 0, 0], ease: 'snap' }, { t: 20, r: [-6, 0, 0], ease: 'sine' },
        { t: 23, r: [7.6, 0, 0], ease: 'quad' }, { t: 27, r: [20.7, 0, 0], ease: 'sine' },
        { t: 38, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 4, r: [-12, 2.47, 0], ease: 'sine' },
        { t: 8, r: [22, 0, 0], ease: 'sine' }, { t: 13, r: [26, 0, 0], ease: 'linear' },
        { t: 14, r: [26.55, 0, 0], ease: 'linear' }, { t: 15, r: [27.93, 0, 0], ease: 'linear' },
        { t: 16, r: [30, 0, 0], ease: 'snap' }, { t: 20, r: [38, 0, 0], ease: 'sine' },
        { t: 23, r: [28.7, 0, 0], ease: 'quad' }, { t: 27, r: [8, 0, 0], ease: 'sine' },
        { t: 38, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [-6, 0, 0], ease: 'sine' },
        { t: 8, r: [-4.8, 0, 0], ease: 'sine' }, { t: 13, r: [-12, 0, 0], ease: 'linear' },
        { t: 14, r: [-7.02, 0, 0], ease: 'linear' }, { t: 15, r: [5.35, 0, 0], ease: 'linear' },
        { t: 16, r: [24, 0, 0], ease: 'snap' }, { t: 20, r: [32, 0, 0], ease: 'sine' },
        { t: 23, r: [31, 0, 0], ease: 'sine' }, { t: 27, r: [-8, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [2.8, 0, 0], ease: 'sine' },
        { t: 13, r: [7, 0, 0], ease: 'sine' }, { t: 16, r: [-11, 0, 0], ease: 'sine' },
        { t: 20, r: [-12.98, 0, 0], ease: 'quad' }, { t: 23, r: [-15, 0, 0], ease: 'sine' },
        { t: 27, r: [6, 0, 0], ease: 'sine' }, { t: 38, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'sine' }, { t: 8, r: [4, 6, -13], ease: 'sine' },
        { t: 13, r: [5.43, 7.32, -13.11], ease: 'sine' }, { t: 16, r: [10, 4, -13], ease: 'sine' },
        { t: 20, r: [10.66, 3.78, -13], ease: 'quad' }, { t: 27, r: [4, 6, -13], ease: 'sine' },
        { t: 38, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'sine' }, { t: 8, r: [20, 0, 0], ease: 'sine' },
        { t: 13, r: [16, 0, 0], ease: 'sine' }, { t: 16, r: [10, 0, 0], ease: 'sine' },
        { t: 20, r: [9.34, 0, 0], ease: 'quad' }, { t: 27, r: [22, 0, 0], ease: 'sine' },
        { t: 38, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'sine' }, { t: 8, r: [-41.2, -3, 0], ease: 'sine' },
        { t: 13, r: [-37.2, -3, 0], ease: 'sine' }, { t: 16, r: [-36.4, -3, 0], ease: 'sine' },
        { t: 20, r: [-36.31, -3, 0], ease: 'quad' }, { t: 27, r: [-43.7, -3, 0], ease: 'sine' },
        { t: 38, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [2.5, 0, 0], ease: 'sine' },
        { t: 13, r: [1.3, 0, 0], ease: 'sine' }, { t: 16, r: [1, 0, 0], ease: 'sine' },
        { t: 20, r: [0.97, 0, 0], ease: 'quad' }, { t: 27, r: [3.2, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [1.4, 0, 0], ease: 'sine' },
        { t: 13, r: [0.7, 0, 0], ease: 'sine' }, { t: 16, r: [0.6, 0, 0], ease: 'sine' },
        { t: 20, r: [0.59, 0, 0], ease: 'quad' }, { t: 27, r: [1.8, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i22. Full 360 spinning back kick. The head snaps around on tick 9 and
  // stays locked on the target while the body catches up.
  //
  // THIS CLIP KICKS WITH THE RIGHT LEG AND EVERYTHING THAT USES IT SAYS LEFT.
  // Measured through the rig at the declared impact tick: foot_R travels 1.02m
  // from stance, foot_L travels 0.14m. hip_R reaches Z = -70 deg (fully abducted)
  // with knee_R straight at 2 deg, while the left leg stays under the body. The
  // right leg is unambiguously the kicking leg.
  //
  // Against that, four independent declarations all name the LEFT foot: this
  // clip's own `impact.bone` (foot_L), the hitbox anchor of all thirteen moves
  // that play it (foot_L + ankle_L, across all four archetypes), the `trail`
  // bone on ten of them (foot_L), and the input convention on nine (b+3 / bb+3,
  // where 3 is the left kick). So on every spin kick in the game the hit capsule
  // and the weapon ribbon sit on the planted pivot foot while the other leg
  // swings through the opponent. It is the single most-used mismatch found by a
  // limb audit of all 191 moves; the other 26 are one-off overrides.
  //
  // Not fixed here, and deliberately. The clip is internally CORRECT: the root
  // yaws -360, which turns the fighter toward its own right, and the leg that
  // trails a right-hand turn and comes around last is the right leg. Swapping
  // the leg tracks alone would make the kick fight the spin, and a full mirror
  // is barred because tick 0 and tick 45 are the shared STANCE, which is not
  // symmetric (hips -27.8 Y, shoulder_L -35/0/-36 against shoulder_R -22/0/+36),
  // so mirroring would pop every entry from and exit to idle. The correct repair
  // is one line per consumer in Moves.js — FOOT_L -> FOOT_R and trail 'foot_L'
  // -> 'foot_R' — which is not this directory's file. `impact.bone` is left at
  // foot_L to match those consumers; nothing reads it at runtime (only
  // `impact.tick` reaches `Fighter.retimeFor`), so it is documentation, and
  // changing it here would only hide the disagreement.
  'k.spinKick': {
    name: 'Spin Kick',
    duration: 45, blendIn: 4, blendOut: 10,
    // Was `foot_L`, the PLANTED foot: it travels 0.143m by the contact tick
    // while foot_R travels 1.017m, a factor of 7.1. All four moves that use
    // this clip anchor FOOT_R. This is why the clip has read as the file's
    // worst decelerator (contact/peak 0.50) since round 11 -- that number was
    // measured on the foot standing on the floor.
    //
    // The tick was 19, one past the peak of the swing. foot_R travels 38, 49,
    // 39 then 16cm on t16-t19, and its reach is furthest at t18. Contact-frame
    // speed 0.33 of peak at t19, 0.80 at t18.
    impact: { tick: 18, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 7.77, p: [0, -0.111, 0], ease: 'sine' },
      { t: 13.82, p: [0, -0.095, 0.04], ry: -160, ease: 'linear' },
      { t: 14, p: [0, -0.095, 0.04], ry: -160.29, ease: 'linear' },
      { t: 15, p: [0, -0.091, 0.046], ry: -172.02, ease: 'linear' },
      { t: 16, p: [0, -0.083, 0.063], ry: -196.94, ease: 'linear' },
      { t: 17, p: [0, -0.073, 0.094], ry: -226.16, ease: 'linear' },
      { t: 18, p: [0, -0.066, 0.139], ry: -249.26, ease: 'linear' },
      { t: 19, p: [0, -0.063, 0.2], ry: -258, ease: 'sine' },
      { t: 23, p: [0, -0.059, 0.214], ry: -262, ease: 'quad' },
      { t: 31, p: [0, -0.105, 0.14], ry: -360, ease: 'sine' },
      { t: 45, p: [0, -0.075, 0], ry: -360, ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [1.12, -33.8, 0.52], ease: 'sine' },
        { t: 7.77, r: [1, -17.4, 0], ease: 'sine' }, { t: 13.82, r: [0.7, 2.3, 0], ease: 'linear' },
        { t: 17, r: [0.59, -0.81, -1.12], ease: 'linear' }, { t: 18, r: [0.55, -2.11, -1.59], ease: 'linear' },
        { t: 19, r: [0.5, -3.5, -2.1], ease: 'sine' }, { t: 23, r: [0.48, -4.14, -2.33], ease: 'quad' },
        { t: 31, r: [1.7, -22, 0], ease: 'sine' }, { t: 45, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [2.15, 5.73, 0.98], ease: 'sine' },
        { t: 7.77, r: [1.9, 4.4, 0], ease: 'sine' }, { t: 13.82, r: [1.4, 2.9, 0], ease: 'linear' },
        { t: 17, r: [1.19, 3.11, -1.87], ease: 'linear' }, { t: 18, r: [1.1, 3.2, -2.66], ease: 'linear' },
        { t: 19, r: [1, 3.3, -3.5], ease: 'sine' }, { t: 23, r: [0.96, 3.34, -3.88], ease: 'quad' },
        { t: 31, r: [3.4, 4.8, 0], ease: 'sine' }, { t: 45, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [2.96, 6.72, 1.09], ease: 'sine' },
        { t: 7.77, r: [2.6, 5.2, 0], ease: 'sine' }, { t: 13.82, r: [1.9, 3.4, 0], ease: 'linear' },
        { t: 17, r: [1.58, 3.67, -2.09], ease: 'linear' }, { t: 18, r: [1.44, 3.78, -2.96], ease: 'linear' },
        { t: 19, r: [1.3, 3.9, -3.9], ease: 'sine' }, { t: 23, r: [1.23, 3.96, -4.33], ease: 'quad' },
        { t: 31, r: [4.5, 5.6, 0], ease: 'sine' }, { t: 45, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [2.96, 8.03, -1.74], ease: 'sine' },
        { t: 7.77, r: [2.6, 6.2, -3], ease: 'sine' }, { t: 13.82, r: [1.9, 4, -3], ease: 'linear' },
        { t: 17, r: [1.58, 4.37, -5.41], ease: 'linear' }, { t: 18, r: [1.44, 4.53, -6.42], ease: 'linear' },
        { t: 19, r: [1.3, 4.7, -7.5], ease: 'sine' }, { t: 23, r: [1.23, 4.78, -7.99], ease: 'quad' },
        { t: 31, r: [4.5, 6.7, -3], ease: 'sine' }, { t: 45, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 7.77, r: [0.6, -17, 0], ease: 'sine' },
        { t: 13.82, r: [0.7, -36, 0], ease: 'sine' }, { t: 19, r: [0.8, -15, 0], ease: 'sine' },
        { t: 23, r: [0.81, -12.69, 0], ease: 'quad' }, { t: 31, r: [0.3, 3.7, 0], ease: 'sine' },
        { t: 45, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 7.77, r: [2.5, -33.4, 0], ease: 'sine' },
        { t: 13.82, r: [2.6, -68.6, 0], ease: 'sine' }, { t: 19, r: [2.8, -29.5, 0], ease: 'sine' },
        { t: 23, r: [2.82, -26, 0], ease: 'quad' }, { t: 31, r: [2.2, 5.2, 0], ease: 'sine' },
        { t: 45, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 7.77, r: [12.4, -25.2, -21.5], ease: 'sine' },
        { t: 13.82, r: [182, -8.2, -80], ease: 'sine' }, { t: 19, r: [129.9, -104, -190.6], ease: 'sine' },
        { t: 23, r: [126.4, -107.5, -194.1], ease: 'quad' }, { t: 31, r: [138.5, -180.7, -214], ease: 'sine' },
        { t: 45, r: [145, -180, -216], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 7.77, r: [-152, 0, 17], ease: 'sine' },
        { t: 13.82, r: [-124.5, 0, 17], ease: 'sine' }, { t: 19, r: [-133.3, 0, 17], ease: 'sine' },
        { t: 23, r: [-134.27, 0, 17], ease: 'quad' }, { t: 31, r: [-123.8, 0, 17], ease: 'sine' },
        { t: 45, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 7.77, r: [-31.5, -18.9, 20.1], ease: 'sine' },
        { t: 13.82, r: [-151, 3.7, 84.7], ease: 'sine' }, { t: 19, r: [-63.3, -22.1, 97], ease: 'sine' },
        { t: 23, r: [-59.8, -24.94, 98.35], ease: 'quad' }, { t: 31, r: [-23.2, -6.1, 32.7], ease: 'sine' },
        { t: 45, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 7.77, r: [-114.6, 0, -1], ease: 'sine' },
        { t: 13.82, r: [-109.9, 0, -1], ease: 'sine' }, { t: 19, r: [-91.2, 0, -1], ease: 'sine' },
        { t: 23, r: [-89.14, 0, -1], ease: 'quad' }, { t: 31, r: [-145.4, 0, -1], ease: 'sine' },
        { t: 45, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 4, r: [-46, 14.48, 11.84], ease: 'sine' },
        { t: 7.77, r: [-14, -18, 12], ease: 'sine' }, { t: 13.82, r: [-18, -14, 10], ease: 'linear' },
        { t: 17, r: [-16.65, -11.3, 9.33], ease: 'linear' }, { t: 18, r: [-15.52, -9.04, 8.76], ease: 'linear' },
        { t: 19, r: [-14, -6, 8], ease: 'expo' }, { t: 23, r: [-5.27, 11.46, 3.64], ease: 'quad' },
        { t: 31, r: [-18, -14, 10], ease: 'sine' }, { t: 45, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 4, r: [49.84, 0, 0], ease: 'sine' },
        { t: 7.77, r: [34, 0, 0], ease: 'sine' }, { t: 13.82, r: [26, 0, 0], ease: 'linear' },
        { t: 17, r: [21.95, 0, 0], ease: 'linear' }, { t: 18, r: [18.56, 0, 0], ease: 'linear' },
        { t: 19, r: [14, 0, 0], ease: 'snap' }, { t: 23, r: [6, 0, 0], ease: 'sine' },
        { t: 31, r: [36, 0, 0], ease: 'sine' }, { t: 45, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 4, r: [-0.42, 2, 0], ease: 'sine' },
        { t: 7.77, r: [-35.7, 2, 0], ease: 'sine' }, { t: 13.82, r: [-24.5, 2, 0], ease: 'linear' },
        { t: 17, r: [-21.9, 2, 0], ease: 'linear' }, { t: 18, r: [-19.72, 2, 0], ease: 'linear' },
        { t: 19, r: [-16.8, 2, 0], ease: 'snap' }, { t: 23, r: [-8.8, 2, 0], ease: 'sine' },
        { t: 31, r: [-34.5, 2, 0], ease: 'sine' }, { t: 45, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [-1.06, 0, 0], ease: 'sine' },
        { t: 7.77, r: [9.5, 0, 0], ease: 'sine' }, { t: 13.82, r: [6.1, 0, 0], ease: 'linear' },
        { t: 17, r: [5.32, 0, 0], ease: 'linear' }, { t: 18, r: [4.67, 0, 0], ease: 'linear' },
        { t: 19, r: [3.8, 0, 0], ease: 'snap' }, { t: 23, r: [3.02, 0, 0], ease: 'sine' },
        { t: 31, r: [9.2, 0, 0], ease: 'sine' }, { t: 45, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7.77, r: [5.4, 0, 0], ease: 'sine' },
        { t: 13.82, r: [3.5, 0, 0], ease: 'sine' }, { t: 19, r: [2.2, 0, 0], ease: 'sine' },
        { t: 23, r: [2.06, 0, 0], ease: 'quad' }, { t: 31, r: [5.2, 0, 0], ease: 'sine' },
        { t: 45, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'sine' }, { t: 7.77, r: [2, 8, -13], ease: 'sine' },
        { t: 13.82, r: [-42, -14.5, 9.8], ease: 'sine' }, { t: 19, r: [26.6, -12.3, -70], ease: 'sine' },
        { t: 23, r: [30.1, -12.06, -73.5], ease: 'quad' }, { t: 26, r: [40.5, -9.9, -83.2], ease: 'quad' },
        { t: 31, r: [2, 6, -13], ease: 'sine' }, { t: 45, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'sine' }, { t: 7.77, r: [30, 0, 0], ease: 'sine' },
        { t: 13.82, r: [60.9, 0, 0], ease: 'sine' }, { t: 19, r: [2, 0, 0], ease: 'sine' },
        { t: 23, r: [-1.5, 0, 0], ease: 'quad' }, { t: 26, r: [11, 0, 0], ease: 'quad' },
        { t: 31, r: [32, 0, 0], ease: 'sine' }, { t: 45, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'sine' }, { t: 7.77, r: [-48.9, -3, 0], ease: 'sine' },
        { t: 13.82, r: [18, 0, 0], ease: 'sine' }, { t: 19, r: [28, 0, 0], ease: 'sine' },
        { t: 23, r: [29.1, 0, 0], ease: 'quad' }, { t: 26, r: [22.1, -0.3, 0], ease: 'quad' },
        { t: 31, r: [-51.4, -3, 0], ease: 'sine' }, { t: 45, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7.77, r: [-4.8, 0, 0], ease: 'sine' },
        { t: 13.82, r: [-12, 0, 0], ease: 'sine' }, { t: 19, r: [24, 0, 0], ease: 'sine' },
        { t: 23, r: [27.5, 0, 0], ease: 'quad' }, { t: 26, r: [31, 0, 0], ease: 'sine' },
        { t: 31, r: [-8, 0, 0], ease: 'sine' }, { t: 45, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 7.77, r: [2.8, 0, 0], ease: 'sine' },
        { t: 13.82, r: [7, 0, 0], ease: 'sine' }, { t: 19, r: [-11, 0, 0], ease: 'sine' },
        { t: 23, r: [-12.98, 0, 0], ease: 'quad' }, { t: 26, r: [-15, 0, 0], ease: 'sine' },
        { t: 31, r: [6, 0, 0], ease: 'sine' }, { t: 45, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i18. Leaves the ground on tick 12 and lands on tick 36. The root carries
  // the whole arc; the apex pose extends kicking leg and body together.
  'k.jumpKick': {
    name: 'Jump Kick',
    duration: 45, blendIn: 4, blendOut: 9,
    impact: { tick: 17, bone: 'foot_R' },
    // The arc is a real ballistic solve, not a drawing of one. It used to hold
    // 0.50 / 0.52 / 0.522 across ticks 15 to 21 and then DECELERATE into the
    // landing — measured, the second difference of the fall ran -0.020, 0.000,
    // +0.020, +0.020 — which is the clearest possible tell that a hang time was
    // decided rather than integrated. Four separate ticks moved under 6mm at the
    // top; the body simply stopped in the air.
    //
    // What replaces it has four phases and one continuous velocity through all
    // of them: an anticipation dip that arrives at the crouch with zero speed,
    // a leg extension at a constant +0.0267 m/tick^2, free flight at a constant
    // -0.0085 m/tick^2 from take-off at t11.33 to touchdown at t35, and a
    // landing absorb that sheds exactly the speed the fall built. Flight keys
    // sit on every tick because the sampler is piecewise linear: at two-tick
    // spacing the sampled acceleration alternates zero and double, and the
    // measurement this was authored against would have shown that instead of a
    // constant. The z track is carried on the same keys and re-fitted to a
    // monotone decay, because it stalled too — 0.4619, 0.4665, 0.4711 across
    // three ticks of the old flight.
    //
    // Fighter also flies this move on real physics (`props.airborne`, v=4.6 at
    // moveTick 4). A parabola added to a parabola is a parabola, so the two now
    // compose; a plateau added to a parabola never could.
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quart' }, { t: 7.56, p: [0, -0.235, -0.02], ease: 'linear' }, { t: 8, p: [0, -0.2324, -0.0107], ease: 'linear' },
      { t: 9, p: [0, -0.2073, 0.0106], ease: 'linear' }, { t: 10, p: [0, -0.1556, 0.0318], ease: 'linear' }, { t: 11, p: [0, -0.0771, 0.053], ease: 'linear' },
      { t: 11.33, p: [0, -0.0454, 0.06], ease: 'linear' }, { t: 12, p: [0, 0.0201, 0.1095], ease: 'linear' }, { t: 13, p: [0, 0.1108, 0.1782], ease: 'linear' },
      { t: 14, p: [0, 0.193, 0.241], ease: 'linear' }, { t: 15, p: [0, 0.2666, 0.2981], ease: 'linear' }, { t: 16, p: [0, 0.3318, 0.3497], ease: 'linear' },
      { t: 17, p: [0, 0.3885, 0.3961], ease: 'linear' }, { t: 18, p: [0, 0.4366, 0.4377], ease: 'linear' }, { t: 19, p: [0, 0.4763, 0.4747], ease: 'linear' },
      { t: 20, p: [0, 0.5074, 0.5073], ease: 'linear' }, { t: 21, p: [0, 0.5301, 0.5359], ease: 'linear' }, { t: 22, p: [0, 0.5442, 0.5606], ease: 'linear' },
      { t: 23, p: [0, 0.5499, 0.5818], ease: 'linear' }, { t: 24, p: [0, 0.547, 0.5998], ease: 'linear' }, { t: 25, p: [0, 0.5357, 0.6148], ease: 'linear' },
      { t: 26, p: [0, 0.5158, 0.627], ease: 'linear' }, { t: 27, p: [0, 0.4875, 0.6368], ease: 'linear' }, { t: 28, p: [0, 0.4506, 0.6445], ease: 'linear' },
      { t: 29, p: [0, 0.4053, 0.6502], ease: 'linear' }, { t: 30, p: [0, 0.3514, 0.6543], ease: 'linear' }, { t: 31, p: [0, 0.2891, 0.6571], ease: 'linear' },
      { t: 32, p: [0, 0.2182, 0.6588], ease: 'linear' }, { t: 33, p: [0, 0.1389, 0.6596], ease: 'linear' }, { t: 34, p: [0, 0.051, 0.66], ease: 'linear' },
      { t: 35, p: [0, -0.0454, 0.66], ease: 'linear' }, { t: 36, p: [0, -0.128, 0.66], ease: 'linear' }, { t: 37, p: [0, -0.1831, 0.66], ease: 'linear' },
      { t: 38, p: [0, -0.2107, 0.66], ease: 'linear' }, { t: 38.5, p: [0, -0.2141, 0.66], ease: 'quad' }, { t: 45, p: [0, -0.075, 0.66], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [0.84, -33.8, 0.28], ease: 'sine' },
        { t: 7.56, r: [3.1, -26.7, 0.3], ease: 'quart' }, { t: 11.33, r: [0.5, -23.2, 0.3], ease: 'quad' },
        { t: 15.11, r: [0.2, -11.6, -0.9], ease: 'quart' }, { t: 17, r: [1.7, -2.3, -1.2], ease: 'sine' },
        { t: 21, r: [1.87, -1.28, -1.23], ease: 'quad' }, { t: 29, r: [2.4, -15.1, -0.3], ease: 'quad' },
        { t: 35, r: [3.6, -24.4, 0], ease: 'sine' }, { t: 45, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [1.48, 5.73, 0.56], ease: 'sine' },
        { t: 7.56, r: [6.2, 5.1, 0.5], ease: 'quart' }, { t: 11.33, r: [1, 4.9, 0.5], ease: 'quad' },
        { t: 15.11, r: [0.5, 4, -1.5], ease: 'quart' }, { t: 17, r: [3.4, 3.3, -2], ease: 'sine' },
        { t: 21, r: [3.72, 3.22, -2.06], ease: 'quad' }, { t: 29, r: [4.8, 4.2, -0.5], ease: 'quad' },
        { t: 35, r: [7.2, 5, 0], ease: 'sine' }, { t: 45, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [2.07, 6.74, 0.62], ease: 'sine' },
        { t: 7.56, r: [8.3, 6.1, 0.6], ease: 'quart' }, { t: 11.33, r: [1.3, 5.7, 0.6], ease: 'quad' },
        { t: 15.11, r: [0.6, 4.7, -1.7], ease: 'quart' }, { t: 17, r: [4.5, 3.8, -2.2], ease: 'sine' },
        { t: 21, r: [4.93, 3.7, -2.26], ease: 'quad' }, { t: 29, r: [6.4, 5, -0.6], ease: 'quad' },
        { t: 35, r: [9.6, 5.8, 0], ease: 'sine' }, { t: 45, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [2.07, 8.08, -2.27], ease: 'sine' },
        { t: 7.56, r: [8.3, 7.2, -2.4], ease: 'quart' }, { t: 11.33, r: [1.3, 6.8, -2.4], ease: 'quad' },
        { t: 15.11, r: [0.6, 5.5, -4.9], ease: 'quart' }, { t: 17, r: [4.5, 4.5, -5.6], ease: 'sine' },
        { t: 21, r: [4.93, 4.39, -5.68], ease: 'quad' }, { t: 29, r: [6.4, 5.9, -3.6], ease: 'quad' },
        { t: 35, r: [9.6, 6.9, -3], ease: 'sine' }, { t: 45, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quart' }, { t: 7.56, r: [-0.3, 4.9, 0], ease: 'quart' },
        { t: 11.33, r: [0.8, 4, 0], ease: 'quad' }, { t: 15.11, r: [0.9, 1.1, 0], ease: 'quart' },
        { t: 17, r: [0.3, -1.3, 0], ease: 'sine' }, { t: 21, r: [0.23, -1.56, 0], ease: 'quad' },
        { t: 29, r: [0, 2, 0], ease: 'quad' }, { t: 35, r: [-0.5, 4.3, 0], ease: 'sine' },
        { t: 45, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quart' }, { t: 7.56, r: [1.4, 7.4, 0], ease: 'quart' },
        { t: 11.33, r: [2.8, 5.8, 0], ease: 'quad' }, { t: 15.11, r: [2.9, 0.3, 0], ease: 'quart' },
        { t: 17, r: [2.2, -4.1, 0], ease: 'sine' }, { t: 21, r: [2.12, -4.58, 0], ease: 'quad' },
        { t: 29, r: [1.8, 1.9, 0], ease: 'quad' }, { t: 35, r: [1.2, 6.3, 0], ease: 'sine' },
        { t: 45, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quart' }, { t: 7.56, r: [-5.9, -12.7, -34.4], ease: 'quart' },
        { t: 11.33, r: [-28, 9.7, -13.7], ease: 'quad' }, { t: 15.11, r: [-11.8, -57.4, -39.8], ease: 'quart' },
        { t: 17, r: [-17.5, -55.4, -31.5], ease: 'sine' }, { t: 21, r: [-18.13, -55.18, -30.59], ease: 'quad' },
        { t: 29, r: [-44.5, 11.7, -5.5], ease: 'quad' }, { t: 35, r: [-52.5, 8.9, -25.8], ease: 'sine' },
        { t: 45, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quart' }, { t: 7.56, r: [-136.4, 0, 17], ease: 'quart' },
        { t: 11.33, r: [-109.8, 0, 17], ease: 'quad' }, { t: 15.11, r: [-152, 0, 17], ease: 'quart' },
        { t: 21, r: [-155.5, 0, 17], ease: 'quad' }, { t: 29, r: [-110.2, 0, 17], ease: 'quad' },
        { t: 35, r: [-124.2, 0, 17], ease: 'sine' }, { t: 45, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      // The counter-swing used to sit still from t8 to t16 and then cover 165
      // degrees in the two ticks to contact — 86 deg/tick authored, which is
      // fast enough to teleport before any playback scaling is applied. The
      // t13.22 and t15.11 keys sit on the arc so the swing builds out of the
      // chamber at an even 25-31 deg/tick. The chamber itself and the contact
      // pose are untouched: the hold was dead time, not anticipation.
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quart' }, { t: 7.56, r: [-5.3, 8.8, 22.3], ease: 'quart' },
        { t: 11.33, r: [-31, -13.3, 22.2], ease: 'quad' }, { t: 13.22, r: [-58.1, 14.6, 54.1], ease: 'quad' },
        { t: 15.11, r: [-101.1, 18.9, 100.9], ease: 'quart' },
        { t: 17, r: [-138.4, -13, 143.9], ease: 'sine' }, { t: 21, r: [-141.9, -12.02, 147.4], ease: 'quad' },
        { t: 29, r: [-40.8, -26.1, 13], ease: 'quad' }, { t: 35, r: [-35.6, -11.9, 23], ease: 'sine' },
        { t: 45, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quart' }, { t: 7.56, r: [-135.9, 0, -1], ease: 'quart' },
        { t: 11.33, r: [-114.5, 0, -1], ease: 'quad' }, { t: 15.11, r: [-112.15, 0, -1], ease: 'quart' },
        { t: 17, r: [-84.8, 0, -1], ease: 'sine' }, { t: 21, r: [-81.53, 0, -1], ease: 'quad' },
        { t: 29, r: [-115, 0, -1], ease: 'quad' }, { t: 35, r: [-145.8, 0, -1], ease: 'sine' },
        { t: 45, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quart' }, { t: 7.56, r: [-16, -16, 13], ease: 'quart' },
        { t: 11.33, r: [-30, -14, 11], ease: 'quad' }, { t: 15.11, r: [-72.2, 3.9, 23.6], ease: 'quart' },
        { t: 17, r: [-88.1, 5.2, 11.1], ease: 'sine' }, { t: 21, r: [-89.85, 5.34, 9.73], ease: 'quad' },
        { t: 29, r: [-40, -14, 11], ease: 'quad' }, { t: 35, r: [-18, -16, 13], ease: 'sine' },
        { t: 36, r: [-15.1, -14.4, 7.8], ease: 'sine' }, { t: 37, r: [-14.4, -15.6, 15.4], ease: 'sine' }, { t: 38.5, r: [-12.6, -16.7, 18.5], ease: 'sine' }, { t: 40, r: [-13.8, -15.8, 18.1], ease: 'sine' }, { t: 42, r: [-15.2, -14.3, 11], ease: 'sine' },
        { t: 45, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quart' }, { t: 7.56, r: [62, 0, 0], ease: 'quart' },
        { t: 11.33, r: [46, 0, 0], ease: 'quad' }, { t: 15.11, r: [55.2, 0, 0], ease: 'quart' },
        { t: 17, r: [2, 0, 0], ease: 'sine' }, { t: 21, r: [-1.5, 0, 0], ease: 'quad' },
        { t: 29, r: [44, 0, 0], ease: 'quad' }, { t: 35, r: [58, 0, 0], ease: 'sine' },
        { t: 36, r: [58.2, -1.3, -1.2], ease: 'sine' }, { t: 37, r: [63.7, 0.1, 1.3], ease: 'sine' }, { t: 38.5, r: [65.3, 1, 2.7], ease: 'sine' }, { t: 40, r: [65.3, 0.5, -0.3], ease: 'sine' }, { t: 42, r: [59.1, -0.2, -2.8], ease: 'sine' },
        { t: 45, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quart' }, { t: 7.56, r: [-61.3, 2, 0], ease: 'quart' },
        { t: 11.33, r: [-4, 2, 0], ease: 'quad' }, { t: 15.11, r: [20, 0, 0], ease: 'quart' },
        { t: 17, r: [30, 0, 0], ease: 'sine' }, { t: 21, r: [31.1, 0, 0], ease: 'quad' },
        { t: 24, r: [28.8, 0.2, 0], ease: 'quad' }, { t: 29, r: [-4, 2, 0], ease: 'quad' },
        { t: 35, r: [-56.2, 2, 0], ease: 'sine' },
        { t: 36, r: [-44.4, 0.6, -0.3], ease: 'sine' }, { t: 37, r: [-47.2, 1.6, 0.4], ease: 'sine' }, { t: 38.5, r: [-48.4, 2.2, 0.9], ease: 'sine' }, { t: 40, r: [-47.4, 1.7, 0.6], ease: 'sine' }, { t: 42, r: [-43.2, 0.8, 0.2], ease: 'sine' },
        { t: 45, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 7.56, r: [-4.8, 0, 0], ease: 'quart' },
        { t: 11.33, r: [-5.33, 0, 0], ease: 'quad' }, { t: 15.11, r: [-12, 0, 0], ease: 'quart' },
        { t: 17, r: [24, 0, 0], ease: 'sine' }, { t: 21, r: [27.5, 0, 0], ease: 'quad' },
        { t: 24, r: [31, 0, 0], ease: 'sine' }, { t: 29, r: [-8, 0, 0], ease: 'quad' },
        { t: 35, r: [-11.5, 0, 0], ease: 'sine' },
        { t: 36, r: [-2.1, -1.1, -0.3], ease: 'sine' }, { t: 37, r: [-3.3, -0.7, -0.2], ease: 'sine' }, { t: 38.5, r: [-4.1, -0.4, -0.1], ease: 'sine' }, { t: 40, r: [-3.2, -0.7, -0.2], ease: 'sine' }, { t: 42, r: [-0.7, -1.2, -0.3], ease: 'sine' },
        { t: 45, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 7.56, r: [2.8, 0, 0], ease: 'quart' },
        { t: 11.33, r: [3.11, 0, 0], ease: 'quad' }, { t: 15.11, r: [7, 0, 0], ease: 'quart' },
        { t: 17, r: [-11, 0, 0], ease: 'sine' }, { t: 21, r: [-12.98, 0, 0], ease: 'quad' },
        { t: 24, r: [-15, 0, 0], ease: 'sine' }, { t: 29, r: [6, 0, 0], ease: 'quad' },
        { t: 35, r: [8.31, 0, 0], ease: 'sine' }, { t: 45, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 4, r: [-4.13, 5.42, -10.94], ease: 'sine' },
        { t: 7.56, r: [-10, 6, -15], ease: 'quart' }, { t: 11.33, r: [4, 6, -13], ease: 'quad' },
        { t: 15.11, r: [-1.7, -53.4, -22.4], ease: 'quart' }, { t: 17, r: [-26.4, -46.8, -15.8], ease: 'snap' },
        { t: 21, r: [-34.4, -44.65, -13.65], ease: 'sine' }, { t: 29, r: [-16, 6, -13], ease: 'quad' },
        { t: 35, r: [-8, 6, -15], ease: 'sine' }, { t: 36, r: [-9.7, 4.9, -8.3], ease: 'sine' },
        { t: 37, r: [-1.6, 4.9, -12.4], ease: 'sine' }, { t: 38.5, r: [-1.6, 4.9, -16.6], ease: 'sine' },
        { t: 40, r: [-2.4, 4.8, -16.1], ease: 'sine' }, { t: 42, r: [-6.4, 4.3, -10.9], ease: 'sine' },
        { t: 45, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 4, r: [57.09, 0, 0], ease: 'sine' },
        { t: 7.56, r: [60, 0, 0], ease: 'quart' }, { t: 11.33, r: [20, 0, 0], ease: 'quad' },
        { t: 15.11, r: [2, 0, 0], ease: 'quart' }, { t: 17, r: [1.83, 0, 0], ease: 'snap' },
        { t: 21, r: [-6.17, 0, 0], ease: 'sine' }, { t: 29, r: [52, 0, 0], ease: 'quad' },
        { t: 35, r: [56, 0, 0], ease: 'sine' }, { t: 36, r: [54.7, 1.6, 2.4], ease: 'sine' },
        { t: 37, r: [55.5, 0.8, 1.3], ease: 'sine' }, { t: 38.5, r: [59.1, 0.6, 0.8], ease: 'sine' },
        { t: 40, r: [59.1, 0.9, 2.6], ease: 'sine' }, { t: 42, r: [55, 1.6, 4.3], ease: 'sine' },
        { t: 45, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 4, r: [-41, -3.47, 0], ease: 'sine' },
        { t: 7.56, r: [-62, -3, 0], ease: 'quart' }, { t: 11.33, r: [26, 0, 0], ease: 'quad' },
        { t: 15.11, r: [24, 0, 0], ease: 'quart' }, { t: 17, r: [18, 0, 0], ease: 'snap' },
        { t: 21, r: [10, 0, 0], ease: 'sine' }, { t: 29, r: [12, 0, 0], ease: 'quad' },
        { t: 35, r: [-62, -3, 0], ease: 'sine' }, { t: 36, r: [-51.7, -1.8, 1], ease: 'sine' },
        { t: 37, r: [-55.4, -2.6, 0.7], ease: 'sine' }, { t: 38.5, r: [-56.2, -2.9, 0.8], ease: 'sine' },
        { t: 40, r: [-54.9, -2.6, 1.2], ease: 'sine' }, { t: 42, r: [-49.1, -1.7, 1.7], ease: 'sine' },
        { t: 45, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [3.92, 0, 0], ease: 'sine' },
        { t: 7.56, r: [8.7, 0, 0], ease: 'quart' }, { t: 11.33, r: [-14, 0, 0], ease: 'quad' },
        { t: 15.11, r: [-16.5, 0, 0], ease: 'quart' }, { t: 17, r: [-14, 0, 0], ease: 'snap' },
        { t: 21, r: [-11.75, 0, 0], ease: 'sine' }, { t: 29, r: [-13.5, 0, 0], ease: 'quad' },
        { t: 35, r: [8.7, 0, 0], ease: 'sine' }, { t: 36, r: [8.1, -0.1, 0], ease: 'sine' },
        { t: 37, r: [3.3, -1.1, -0.4], ease: 'sine' }, { t: 38.5, r: [1.6, -1.7, -0.5], ease: 'sine' },
        { t: 40, r: [1.4, -1.8, -0.5], ease: 'sine' }, { t: 42, r: [3.1, -1.6, -0.5], ease: 'sine' },
        { t: 45, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 7.56, r: [4.9, 0, 0], ease: 'quart' },
        { t: 11.33, r: [-9, 0, 0], ease: 'quad' }, { t: 15.11, r: [-10.53, 0, 0], ease: 'quart' },
        { t: 17, r: [-8.7, 0, 0], ease: 'sine' }, { t: 21, r: [-8.67, 0, 0], ease: 'quad' },
        { t: 29, r: [-7.6, 0, 0], ease: 'quad' }, { t: 35, r: [4.9, 0, 0], ease: 'sine' },
        { t: 45, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i16. Front snap straight up the middle — the toe travels from the floor to
  // above the fighter's own head in three ticks.
  'k.launcherKick': {
    name: 'Launcher Kick',
    duration: 40, blendIn: 4, blendOut: 9,
    impact: { tick: 16, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 8, p: [0, -0.151, -0.02], ease: 'sine' },
      { t: 13, p: [0, -0.094, 0.06], ease: 'linear' },
      { t: 16, p: [0, -0.075, 0.14], ease: 'sine' },
      { t: 20, p: [0, -0.073, 0.149], ease: 'quad' },
      { t: 28, p: [0, -0.091, 0.1], ease: 'sine' },
      { t: 40, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [1.9, -31.69, -0.08], ease: 'sine' },
        { t: 8, r: [2.4, -29, 0.3], ease: 'sine' }, { t: 13, r: [1.2, -25.5, 0.6], ease: 'linear' },
        { t: 16, r: [-2.2, -13.9, 0.3], ease: 'sine' }, { t: 20, r: [-2.57, -12.62, 0.27], ease: 'quad' },
        { t: 28, r: [1.9, -22, 0.3], ease: 'sine' }, { t: 40, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [3.64, 5.48, -0.14], ease: 'sine' },
        { t: 8, r: [4.8, 5.3, 0.5], ease: 'sine' }, { t: 13, r: [2.4, 5.1, 1], ease: 'linear' },
        { t: 16, r: [-4.3, 4.2, 0.5], ease: 'sine' }, { t: 20, r: [-5.04, 4.1, 0.45], ease: 'quad' },
        { t: 28, r: [3.8, 4.8, 0.5], ease: 'sine' }, { t: 40, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [4.95, 6.44, -0.17], ease: 'sine' },
        { t: 8, r: [6.4, 6.3, 0.6], ease: 'sine' }, { t: 13, r: [3.2, 6, 1.1], ease: 'linear' },
        { t: 16, r: [-5.8, 4.9, 0.6], ease: 'sine' }, { t: 20, r: [-6.79, 4.78, 0.54], ease: 'quad' },
        { t: 28, r: [5.1, 5.6, 0.6], ease: 'sine' }, { t: 40, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [4.95, 7.72, -3.17], ease: 'sine' },
        { t: 8, r: [6.4, 7.4, -2.4], ease: 'sine' }, { t: 13, r: [3.2, 7, -1.7], ease: 'linear' },
        { t: 16, r: [-5.8, 5.8, -2.4], ease: 'sine' }, { t: 20, r: [-6.79, 5.67, -2.48], ease: 'quad' },
        { t: 28, r: [5.1, 6.7, -2.4], ease: 'sine' }, { t: 40, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 8, r: [0, 5.5, 0], ease: 'sine' },
        { t: 13, r: [0.5, 4.6, 0], ease: 'linear' }, { t: 16, r: [1.9, 1.7, 0], ease: 'sine' },
        { t: 20, r: [2.05, 1.38, 0], ease: 'quad' }, { t: 28, r: [0.2, 3.7, 0], ease: 'sine' },
        { t: 40, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 8, r: [1.8, 8.5, 0], ease: 'sine' },
        { t: 13, r: [2.4, 6.9, 0], ease: 'linear' }, { t: 16, r: [4.1, 1.4, 0], ease: 'sine' },
        { t: 20, r: [4.29, 0.8, 0], ease: 'quad' }, { t: 28, r: [2, 5.2, 0], ease: 'sine' },
        { t: 40, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 8, r: [-37.9, 21.5, -7], ease: 'sine' },
        { t: 13, r: [-18.1, -41.5, -49.1], ease: 'linear' }, { t: 16, r: [36.4, -50.8, -21.1], ease: 'sine' },
        { t: 20, r: [39.9, -51.82, -18.02], ease: 'quad' }, { t: 28, r: [-43, 2.9, -34.6], ease: 'sine' },
        { t: 40, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 8, r: [-110.3, 0, 17], ease: 'sine' },
        { t: 13, r: [-152, 0, 17], ease: 'linear' }, { t: 20, r: [-155.5, 0, 17], ease: 'quad' },
        { t: 28, r: [-123.9, 0, 17], ease: 'sine' }, { t: 40, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'sine' }, { t: 8, r: [-46, -15.8, 12.7], ease: 'sine' },
        { t: 13, r: [-36.5, -13.2, 17.5], ease: 'linear' }, { t: 16, r: [43.7, 32.3, 21.9], ease: 'sine' },
        { t: 20, r: [47.2, 35.8, 22.38], ease: 'quad' }, { t: 28, r: [-24.2, -6.1, 30], ease: 'sine' },
        { t: 40, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'sine' }, { t: 8, r: [-114.9, 0, -1], ease: 'sine' },
        { t: 13, r: [-114.7, 0, -1], ease: 'linear' }, { t: 16, r: [-152, 0, -1], ease: 'sine' },
        { t: 20, r: [-155.5, 0, -1], ease: 'quad' }, { t: 28, r: [-145.5, 0, -1], ease: 'sine' },
        { t: 40, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 8, r: [-14, -16, 12], ease: 'sine' },
        { t: 13, r: [-18, -14, 10], ease: 'linear' }, { t: 16, r: [-10, -8, 8], ease: 'sine' },
        { t: 20, r: [-9.12, -7.34, 7.78], ease: 'quad' }, { t: 28, r: [-18, -14, 10], ease: 'sine' },
        { t: 40, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 8, r: [48, 0, 0], ease: 'sine' },
        { t: 13, r: [26, 0, 0], ease: 'linear' }, { t: 16, r: [8, 0, 0], ease: 'sine' },
        { t: 20, r: [6.02, 0, 0], ease: 'quad' }, { t: 28, r: [26, 0, 0], ease: 'sine' },
        { t: 40, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 8, r: [-49.7, 2, 0], ease: 'sine' },
        { t: 13, r: [-24.9, 2, 0], ease: 'linear' }, { t: 16, r: [-12.6, 2, 0], ease: 'sine' },
        { t: 20, r: [-11.25, 2, 0], ease: 'quad' }, { t: 28, r: [-25.5, 2, 0], ease: 'sine' },
        { t: 40, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [13.7, 0, 0], ease: 'sine' },
        { t: 13, r: [6.3, 0, 0], ease: 'linear' }, { t: 16, r: [2.6, 0, 0], ease: 'sine' },
        { t: 20, r: [2.19, 0, 0], ease: 'quad' }, { t: 28, r: [6.5, 0, 0], ease: 'sine' },
        { t: 40, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [7.8, 0, 0], ease: 'sine' },
        { t: 13, r: [3.6, 0, 0], ease: 'linear' }, { t: 16, r: [1.5, 0, 0], ease: 'sine' },
        { t: 20, r: [1.27, 0, 0], ease: 'quad' }, { t: 28, r: [3.7, 0, 0], ease: 'sine' },
        { t: 40, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 4, r: [4, -4.91, -13.45], ease: 'sine' },
        { t: 8, r: [-6, 6, -14], ease: 'sine' }, { t: 13, r: [-76.8, 10.6, 12.4], ease: 'linear' },
        { t: 16, r: [-133.6, -16.4, 1.9], ease: 'expo' }, { t: 20, r: [-151.42, -24.87, -1.39], ease: 'quad' },
        { t: 24, r: [-110.7, -12.3, 1.5], ease: 'quad' }, { t: 28, r: [-38.2, 2.1, 1.1], ease: 'sine' },
        { t: 40, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 4, r: [57.04, 0, 0], ease: 'sine' },
        { t: 8, r: [46, 0, 0], ease: 'sine' }, { t: 13, r: [86.7, 0, 0], ease: 'linear' },
        { t: 16, r: [2, 0, 0], ease: 'snap' }, { t: 20, r: [-6, 0, 0], ease: 'sine' },
        { t: 24, r: [19.6, 0, 0], ease: 'quad' }, { t: 28, r: [26.5, 0, 0], ease: 'sine' },
        { t: 40, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 4, r: [-41, -3.36, 0], ease: 'sine' },
        { t: 8, r: [-57.2, -3, 0], ease: 'sine' }, { t: 13, r: [26, 0, 0], ease: 'linear' },
        { t: 16, r: [34, 0, 0], ease: 'snap' }, { t: 20, r: [42, 0, 0], ease: 'sine' },
        { t: 24, r: [27.1, 0, 0], ease: 'quad' }, { t: 28, r: [6, 0, 0], ease: 'sine' },
        { t: 40, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [-6, 0, 0], ease: 'sine' },
        { t: 8, r: [-4.8, 0, 0], ease: 'sine' }, { t: 13, r: [-12, 0, 0], ease: 'linear' },
        { t: 16, r: [24, 0, 0], ease: 'snap' }, { t: 20, r: [32, 0, 0], ease: 'sine' },
        { t: 24, r: [31, 0, 0], ease: 'sine' }, { t: 28, r: [-8, 0, 0], ease: 'sine' },
        { t: 40, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 8, r: [2.8, 0, 0], ease: 'sine' },
        { t: 13, r: [7, 0, 0], ease: 'linear' }, { t: 16, r: [-11, 0, 0], ease: 'sine' },
        { t: 20, r: [-12.98, 0, 0], ease: 'quad' }, { t: 24, r: [-15, 0, 0], ease: 'sine' },
        { t: 28, r: [6, 0, 0], ease: 'sine' }, { t: 40, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i20. A short hop onto a grounded opponent: knee to the chest at the top,
  // then the whole mass comes down through the heel.
  'k.stomp': {
    name: 'Stomp',
    duration: 42, blendIn: 4, blendOut: 9,
    impact: { tick: 20, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quart' },
      { t: 8, p: [0, -0.163, 0], ease: 'linear' },
      { t: 9, p: [0, -0.159, 0], ease: 'linear' },
      { t: 10, p: [0, -0.097, 0], ease: 'linear' },
      { t: 11, p: [0, 0.094, 0.001], ease: 'linear' },
      { t: 12, p: [0, 0.156, 0.004], ease: 'linear' },
      { t: 13, p: [0, 0.16, 0.011], ease: 'linear' },
      { t: 14, p: [0, 0.151, 0.023], ease: 'linear' },
      { t: 15, p: [0, 0.13, 0.042], ease: 'linear' },
      { t: 16, p: [0, 0.109, 0.071], ease: 'linear' },
      { t: 17, p: [0, 0.1, 0.114], ease: 'linear' },
      { t: 18, p: [0, 0.04, 0.174], ease: 'linear' },
      { t: 19, p: [0, -0.08, 0.254], ease: 'linear' },
      { t: 20, p: [0, -0.14, 0.36], ease: 'sine' },
      { t: 24, p: [0, -0.154, 0.362], ease: 'quad' },
      { t: 32, p: [0, -0.105, 0.36], ease: 'sine' },
      { t: 42, p: [0, -0.075, 0.36], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [0.27, -30.71, 0], ease: 'sine' },
        { t: 8, r: [2.6, -25.5, 0], ease: 'linear' }, { t: 13, r: [1.2, -24.51, 0], ease: 'linear' },
        { t: 17, r: [1.9, -21.44, 0], ease: 'linear' }, { t: 18, r: [2.39, -20.27, 0], ease: 'linear' },
        { t: 19, r: [2.96, -18.93, 0], ease: 'linear' }, { t: 20, r: [3.6, -17.4, 0], ease: 'sine' },
        { t: 24, r: [3.79, -17.15, 0], ease: 'quad' }, { t: 32, r: [2.2, -23.2, 0], ease: 'sine' },
        { t: 42, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [0.42, 5.42, 0], ease: 'sine' },
        { t: 8, r: [5.3, 5.1, 0], ease: 'linear' }, { t: 13, r: [2.4, 5.01, 0], ease: 'linear' },
        { t: 17, r: [3.8, 4.75, 0], ease: 'linear' }, { t: 18, r: [4.78, 4.65, 0], ease: 'linear' },
        { t: 19, r: [5.91, 4.53, 0], ease: 'linear' }, { t: 20, r: [7.2, 4.4, 0], ease: 'sine' },
        { t: 24, r: [7.57, 4.38, 0], ease: 'quad' }, { t: 32, r: [4.3, 4.9, 0], ease: 'sine' },
        { t: 42, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [0.64, 6.35, 0], ease: 'sine' },
        { t: 8, r: [7, 6, 0], ease: 'linear' }, { t: 13, r: [3.2, 5.9, 0], ease: 'linear' },
        { t: 17, r: [5.1, 5.6, 0], ease: 'linear' }, { t: 18, r: [6.4, 5.48, 0], ease: 'linear' },
        { t: 19, r: [7.9, 5.35, 0], ease: 'linear' }, { t: 20, r: [9.6, 5.2, 0], ease: 'sine' },
        { t: 24, r: [10.09, 5.18, 0], ease: 'quad' }, { t: 32, r: [5.8, 5.7, 0], ease: 'sine' },
        { t: 42, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [0.64, 7.61, -3], ease: 'sine' },
        { t: 8, r: [7, 7, -3], ease: 'linear' }, { t: 13, r: [3.2, 6.9, -3], ease: 'linear' },
        { t: 17, r: [5.1, 6.6, -3], ease: 'linear' }, { t: 18, r: [6.4, 6.48, -3], ease: 'linear' },
        { t: 19, r: [7.9, 6.35, -3], ease: 'linear' }, { t: 20, r: [9.6, 6.2, -3], ease: 'sine' },
        { t: 24, r: [10.09, 6.18, -3], ease: 'quad' }, { t: 32, r: [5.8, 6.8, -3], ease: 'sine' },
        { t: 42, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quart' }, { t: 8, r: [-0.1, 4.6, 0], ease: 'quart' },
        { t: 13, r: [0.5, 3.7, 0], ease: 'sine' }, { t: 17, r: [0.2, 3.1, 0], ease: 'sine' },
        { t: 20, r: [-0.5, 2.6, 0], ease: 'sine' }, { t: 24, r: [-0.58, 2.55, 0], ease: 'quad' },
        { t: 32, r: [0.1, 4, 0], ease: 'sine' }, { t: 42, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quart' }, { t: 8, r: [1.7, 6.9, 0], ease: 'quart' },
        { t: 13, r: [2.4, 5.2, 0], ease: 'sine' }, { t: 17, r: [2, 4.1, 0], ease: 'sine' },
        { t: 20, r: [1.2, 3, 0], ease: 'sine' }, { t: 24, r: [1.11, 2.88, 0], ease: 'quad' },
        { t: 32, r: [1.9, 5.8, 0], ease: 'sine' }, { t: 42, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quart' }, { t: 8, r: [-41.6, 19.5, -4.7], ease: 'quart' },
        { t: 13, r: [96.5, 117.2, -7.3], ease: 'sine' }, { t: 17, r: [29.8, 109.4, 34.7], ease: 'sine' },
        { t: 20, r: [-1.8, -11.6, -30.2], ease: 'sine' }, { t: 24, r: [-5.28, -15.1, -33.7], ease: 'quad' },
        { t: 32, r: [-43.9, 3.1, -32], ease: 'sine' }, { t: 42, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quart' }, { t: 8, r: [-110.3, 0, 17], ease: 'quart' },
        { t: 13, r: [-102.7, 0, 17], ease: 'sine' }, { t: 17, r: [-137.4, 0, 17], ease: 'sine' },
        { t: 20, r: [-141.8, 0, 17], ease: 'sine' }, { t: 24, r: [-142.28, 0, 17], ease: 'quad' },
        { t: 32, r: [-123.9, 0, 17], ease: 'sine' }, { t: 42, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quart' }, { t: 8, r: [-46.6, -19.6, 11.7], ease: 'quart' },
        { t: 13, r: [-98.7, -42.6, 168], ease: 'sine' }, { t: 17, r: [-122.1, -36.5, 165.5], ease: 'sine' },
        { t: 20, r: [-174.8, -176.4, 207], ease: 'sine' }, { t: 24, r: [-178.3, -179.9, 210.5], ease: 'quad' },
        { t: 32, r: [-206.4, -172.5, 210.5], ease: 'sine' }, { t: 42, r: [-202, -180, 216], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quart' }, { t: 8, r: [-115, 0, -1], ease: 'quart' },
        { t: 13, r: [-106.2, 0, -1], ease: 'sine' }, { t: 17, r: [-130.4, 0, -1], ease: 'sine' },
        { t: 20, r: [-141.5, 0, -1], ease: 'sine' }, { t: 24, r: [-142.72, 0, -1], ease: 'quad' },
        { t: 32, r: [-145.5, 0, -1], ease: 'sine' }, { t: 42, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quart' }, { t: 8, r: [-16, -16, 12], ease: 'quart' },
        { t: 13, r: [-58, -12, 11], ease: 'sine' }, { t: 17, r: [-70, -12, 11], ease: 'sine' },
        { t: 20, r: [-48, -12, 11], ease: 'sine' }, { t: 24, r: [-44.5, -12, 11], ease: 'quad' },
        { t: 27, r: [-33.3, -12.4, 11], ease: 'quad' }, { t: 32, r: [-24, -16, 11], ease: 'sine' },
        { t: 42, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quart' }, { t: 8, r: [52, 0, 0], ease: 'quart' },
        { t: 13, r: [76, 0, 0], ease: 'sine' }, { t: 17, r: [62, 0, 0], ease: 'sine' },
        { t: 20, r: [58, 0, 0], ease: 'sine' }, { t: 24, r: [54, 0, 0], ease: 'quad' },
        { t: 27, r: [46, 0, 0], ease: 'quad' }, { t: 32, r: [40, 0, 0], ease: 'sine' },
        { t: 42, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quart' }, { t: 8, r: [-51.8, 2, 0], ease: 'quart' },
        { t: 13, r: [-4, 2, 0], ease: 'sine' }, { t: 17, r: [-18, 0, 0], ease: 'sine' },
        { t: 20, r: [20, 0, 0], ease: 'sine' }, { t: 24, r: [23.5, 0, 0], ease: 'quad' },
        { t: 27, r: [23.2, 0.2, 0], ease: 'quad' }, { t: 32, r: [-36.7, 2, 0], ease: 'sine' },
        { t: 42, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 8, r: [4.8, 0, 0], ease: 'quart' },
        { t: 13, r: [5.33, 0, 0], ease: 'sine' }, { t: 17, r: [12, 0, 0], ease: 'sine' },
        { t: 20, r: [-22, 0, 0], ease: 'sine' }, { t: 24, r: [-25.5, 0, 0], ease: 'quad' },
        { t: 27, r: [-28, 0, 0], ease: 'sine' }, { t: 32, r: [6, 0, 0], ease: 'sine' },
        { t: 42, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 8, r: [-2.4, 0, 0], ease: 'quart' },
        { t: 13, r: [-2.66, 0, 0], ease: 'sine' }, { t: 17, r: [-6, 0, 0], ease: 'sine' },
        { t: 20, r: [12, 0, 0], ease: 'sine' }, { t: 24, r: [13.98, 0, 0], ease: 'quad' },
        { t: 27, r: [16, 0, 0], ease: 'sine' }, { t: 32, r: [-5, 0, 0], ease: 'sine' },
        { t: 42, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 4, r: [-4.24, -9.36, -11.72], ease: 'sine' },
        { t: 8, r: [-8, 6, -14], ease: 'linear' }, { t: 13, r: [-46, 6, -13.97], ease: 'linear' },
        { t: 17, r: [-34, 6, -13.68], ease: 'linear' }, { t: 18, r: [-32.06, 6, -13.52], ease: 'linear' },
        { t: 19, r: [-29.44, 6, -13.3], ease: 'linear' }, { t: 20, r: [-26, 6, -13], ease: 'expo' },
        { t: 24, r: [-6, 6, -13], ease: 'quad' }, { t: 32, r: [-6, 6, -13], ease: 'sine' },
        { t: 42, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 4, r: [38, 0, 0], ease: 'sine' },
        { t: 8, r: [50, 0, 0], ease: 'linear' }, { t: 13, r: [80, 0, 0], ease: 'linear' },
        { t: 17, r: [74, 0, 0], ease: 'linear' }, { t: 18, r: [73.03, 0, 0], ease: 'linear' },
        { t: 19, r: [71.72, 0, 0], ease: 'linear' }, { t: 20, r: [70, 0, 0], ease: 'snap' },
        { t: 24, r: [58.9, 0, 0], ease: 'sine' }, { t: 32, r: [42, 0, 0], ease: 'sine' },
        { t: 42, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 4, r: [-41, -3.56, 0], ease: 'sine' },
        { t: 8, r: [-59.2, -3, 0], ease: 'linear' }, { t: 13, r: [16, -2.91, 0], ease: 'linear' },
        { t: 17, r: [14, -2.05, 0], ease: 'linear' }, { t: 18, r: [13.03, -1.55, 0], ease: 'linear' },
        { t: 19, r: [11.72, -0.88, 0], ease: 'linear' }, { t: 20, r: [10, 0, 0], ease: 'snap' },
        { t: 24, r: [2, 0, 0], ease: 'sine' }, { t: 32, r: [-53.6, -3, 0], ease: 'sine' },
        { t: 42, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4, r: [3.61, 0, 0], ease: 'sine' },
        { t: 8, r: [7.9, 0, 0], ease: 'linear' }, { t: 13, r: [-14, 0, 0], ease: 'linear' },
        { t: 17, r: [-16.41, 0, 0], ease: 'linear' }, { t: 18, r: [-15.56, 0, 0], ease: 'linear' },
        { t: 19, r: [-14.41, 0, 0], ease: 'linear' }, { t: 20, r: [-12.9, 0, 0], ease: 'snap' },
        { t: 24, r: [-11.54, 0, 0], ease: 'sine' }, { t: 32, r: [6.2, 0, 0], ease: 'sine' },
        { t: 42, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 8, r: [4.5, 0, 0], ease: 'quart' },
        { t: 13, r: [-8.3, 0, 0], ease: 'sine' }, { t: 17, r: [-8, 0, 0], ease: 'sine' },
        { t: 20, r: [-7.3, 0, 0], ease: 'sine' }, { t: 24, r: [-7.22, 0, 0], ease: 'quad' },
        { t: 32, r: [3.5, 0, 0], ease: 'sine' }, { t: 42, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i7 from the air, and that is the whole reason this clip exists. Falcon Dive
  // used to borrow `k.jumpKick`, whose blow lands on tick 17, and asked the
  // runtime to play its wind-up at 2.57x — past the 1.38x clamp, so the hitbox
  // opened with the boot still folded under the chassis and the foot 746mm from
  // where the clip says contact is. A dive kick is not a fast vault kick either:
  // it starts already airborne, so there is no crouch and no launch, and the
  // spear travels DOWN and forward rather than out.
  //
  // Tick 0 is therefore the air-hold pose from `loco.jumpAir` rather than the
  // shared STANCE — this move can only be entered from a jump, and blending it
  // out of a standing guard is what would pop. The last key IS the stance, so
  // the landing still returns to idle cleanly.
  //
  // Three ticks of chamber, two of release, and the strike leaves on a 'snap'
  // that only the driving leg carries: at i7 there is room for exactly one tick
  // of readable anticipation, and spending it on the whole body would blur the
  // tell instead of sharpening it.
  'k.diveKick': {
    name: 'Falcon Dive',
    duration: 34, blendIn: 3, blendOut: 8,
    impact: { tick: 7, bone: 'foot_R' },
    root: [
      { t: 0, p: [0, 0.09, 0], ease: 'quad' },
      { t: 3, p: [0, 0.1, 0.02], ease: 'linear' },
      { t: 4, p: [0, 0.07, 0.033], ease: 'linear' },
      { t: 5, p: [0, 0.04, 0.066], ease: 'linear' },
      { t: 6, p: [0, 0.015, 0.115], ease: 'linear' },
      { t: 7, p: [0, -0.01, 0.18], ease: 'sine' },
      { t: 9, p: [0, -0.02, 0.22], ease: 'quad' },
      { t: 13, p: [0, 0.02, 0.24], ease: 'cubic' },
      { t: 19, p: [0, -0.167, 0.25], ease: 'cubic' },
      { t: 26, p: [0, -0.093, 0.24], ease: 'sine' },
      { t: 34, p: [0, -0.075, 0.24], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [-1, -27.8, 1], ease: 'quad' }, { t: 2, r: [-5.76, -31.1, 1.28], ease: 'sine' },
        { t: 3, r: [-8, -24, 2], ease: 'linear' }, { t: 5, r: [2.45, -20.52, 1.13], ease: 'linear' },
        { t: 6, r: [9, -18.34, 0.58], ease: 'linear' }, { t: 7, r: [16, -16, 0], ease: 'sine' },
        { t: 9, r: [19, -14, 0], ease: 'quad' }, { t: 13, r: [10, -20, 0], ease: 'cubic' },
        { t: 19, r: [15, -24, 0], ease: 'cubic' }, { t: 26, r: [4, -26.5, 0], ease: 'sine' },
        { t: 34, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [-0.1, 5.2, 0], ease: 'quad' }, { t: 2, r: [-2.65, 5.82, 0], ease: 'sine' },
        { t: 3, r: [-5, 4.5, 0], ease: 'linear' }, { t: 5, r: [1.09, 3.85, 0], ease: 'linear' },
        { t: 6, r: [4.91, 3.44, 0], ease: 'linear' }, { t: 7, r: [9, 3, 0], ease: 'sine' },
        { t: 9, r: [10.5, 2.8, 0], ease: 'quad' }, { t: 13, r: [6, 4, 0], ease: 'cubic' },
        { t: 19, r: [9, 4.8, 0], ease: 'cubic' }, { t: 26, r: [3, 5, 0], ease: 'sine' },
        { t: 34, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [0.6, 6.1, 0], ease: 'quad' }, { t: 2, r: [-2.31, 6.83, 0], ease: 'sine' },
        { t: 3, r: [-4, 5, 0], ease: 'linear' }, { t: 5, r: [2.53, 4.35, 0], ease: 'linear' },
        { t: 6, r: [6.62, 3.94, 0], ease: 'linear' }, { t: 7, r: [11, 3.5, 0], ease: 'sine' },
        { t: 9, r: [12.5, 3.2, 0], ease: 'quad' }, { t: 13, r: [7, 4.6, 0], ease: 'cubic' },
        { t: 19, r: [10, 5.6, 0], ease: 'cubic' }, { t: 26, r: [4, 5.9, 0], ease: 'sine' },
        { t: 34, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [-0.4, 5.3, -2], ease: 'quad' }, { t: 2, r: [-3.59, 5.94, -1.44], ease: 'sine' },
        { t: 3, r: [-6, 4, -2], ease: 'linear' }, { t: 5, r: [1.4, 3.56, -2.87], ease: 'linear' },
        { t: 6, r: [6.04, 3.29, -3.42], ease: 'linear' }, { t: 7, r: [11, 3, -4], ease: 'sine' },
        { t: 9, r: [12.5, 2.8, -4.3], ease: 'quad' }, { t: 13, r: [7, 4.4, -3.4], ease: 'cubic' },
        { t: 19, r: [10, 6, -3], ease: 'cubic' }, { t: 26, r: [4, 6.8, -3], ease: 'sine' },
        { t: 34, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [2.6, 5.2, 0], ease: 'quad' }, { t: 3, r: [4, 4, 0], ease: 'quart' },
        { t: 5, r: [-1, 2, 0], ease: 'quad' }, { t: 7, r: [-6, 1, 0], ease: 'sine' },
        { t: 9, r: [-7, 0.8, 0], ease: 'quad' }, { t: 13, r: [-3, 3, 0], ease: 'cubic' },
        { t: 19, r: [-6, 4.4, 0], ease: 'cubic' }, { t: 26, r: [-1, 4.8, 0], ease: 'sine' },
        { t: 34, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [5.5, 9, 0], ease: 'quad' }, { t: 3, r: [8, 7, 0], ease: 'quart' },
        { t: 5, r: [-1, 4, 0], ease: 'quad' }, { t: 7, r: [-9, 2, 0], ease: 'sine' },
        { t: 9, r: [-10.5, 1.6, 0], ease: 'quad' }, { t: 13, r: [-4, 5, 0], ease: 'cubic' },
        { t: 19, r: [-9, 6, 0], ease: 'cubic' }, { t: 26, r: [-1, 7, 0], ease: 'sine' },
        { t: 34, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -6, 2], ease: 'quad' }, { t: 7, r: [0, -9, -3], ease: 'cubic' },
        { t: 19, r: [0, -11, -5], ease: 'sine' }, { t: 34, r: [0, -10, -4], ease: 'linear' }],
      // Both arms rip back through the strike and are thrown forward again to
      // catch the landing, which is the only counterweight an airborne fighter
      // has: nothing below the pelvis is in contact to brace against.
      shoulder_L: [{ t: 0, r: [-42, 0, -10], ease: 'quad' }, { t: 3, r: [-52, -6, -16], ease: 'quart' },
        { t: 5, r: [-58, -10, -20], ease: 'quad' }, { t: 7, r: [-64, -14, -24], ease: 'sine' },
        { t: 9, r: [-66, -15, -25], ease: 'quad' }, { t: 13, r: [-52, -8, -24], ease: 'cubic' },
        { t: 19, r: [-24, -14, -30], ease: 'cubic' }, { t: 26, r: [-38, -4, -38], ease: 'sine' },
        { t: 34, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-74, 0, 16], ease: 'quad' }, { t: 3, r: [-88, 0, 16], ease: 'quart' },
        { t: 5, r: [-96, 0, 16], ease: 'quad' }, { t: 7, r: [-104, 0, 16], ease: 'sine' },
        { t: 9, r: [-107, 0, 16], ease: 'quad' }, { t: 13, r: [-96, 0, 16], ease: 'cubic' },
        { t: 19, r: [-108, 0, 17], ease: 'cubic' }, { t: 26, r: [-118, 0, 17], ease: 'sine' },
        { t: 34, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 7, r: [-22, 0, -4], ease: 'sine' },
        { t: 19, r: [-8, 0, 3], ease: 'cubic' }, { t: 34, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 6, -2], ease: 'quad' }, { t: 7, r: [0, 9, 3], ease: 'cubic' },
        { t: 19, r: [0, 10, 5], ease: 'sine' }, { t: 34, r: [0, 8, 4], ease: 'linear' }],
      shoulder_R: [{ t: 0, r: [-32, 0, 10], ease: 'quad' }, { t: 3, r: [-44, 6, 16], ease: 'quart' },
        { t: 5, r: [-50, 10, 20], ease: 'quad' }, { t: 7, r: [-56, 14, 24], ease: 'sine' },
        { t: 9, r: [-58, 15, 25], ease: 'quad' }, { t: 13, r: [-46, 6, 22], ease: 'cubic' },
        { t: 19, r: [-16, 12, 30], ease: 'cubic' }, { t: 26, r: [-26, 3, 38], ease: 'sine' },
        { t: 34, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-90, 0, -8], ease: 'quad' }, { t: 3, r: [-104, 0, -8], ease: 'quart' },
        { t: 5, r: [-112, 0, -8], ease: 'quad' }, { t: 7, r: [-120, 0, -8], ease: 'sine' },
        { t: 9, r: [-124, 0, -8], ease: 'quad' }, { t: 13, r: [-110, 0, -8], ease: 'cubic' },
        { t: 19, r: [-124, 0, -1], ease: 'cubic' }, { t: 26, r: [-138, 0, -1], ease: 'sine' },
        { t: 34, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 7, r: [-22, 0, 4], ease: 'sine' },
        { t: 19, r: [-8, 0, -3], ease: 'cubic' }, { t: 34, r: [-14, 0, 0], ease: 'linear' }],
      // Trailing leg. It folds back as the spear leaves so the silhouette is a
      // straight line from the trailing knee through the driving boot.
      hip_L: [{ t: 0, r: [-57.4, -0.7, 11], ease: 'quad' }, { t: 3, r: [-40, -2, 11], ease: 'quart' },
        { t: 5, r: [-24, -2, 11], ease: 'quad' }, { t: 7, r: [-8, -2, 11], ease: 'sine' },
        { t: 9, r: [-4, -2, 11], ease: 'quad' }, { t: 13, r: [-30, 2, 11], ease: 'cubic' },
        { t: 19, r: [-62.5, -5.6, 11], ease: 'cubic' }, { t: 26, r: [-46, 6, 11], ease: 'sine' },
        { t: 34, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [88.1, 0, 0], ease: 'quad' }, { t: 3, r: [72, 0, 0], ease: 'quart' },
        { t: 5, r: [50, 0, 0], ease: 'quad' }, { t: 7, r: [40, 0, 0], ease: 'sine' },
        { t: 9, r: [36, 0, 0], ease: 'quad' }, { t: 13, r: [62, 0, 0], ease: 'cubic' },
        { t: 19, r: [89.3, 0, 0], ease: 'cubic' }, { t: 26, r: [58, 0, 0], ease: 'sine' },
        { t: 34, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-8.7, 1.2, 0], ease: 'quad' }, { t: 3, r: [-14, 1, 0], ease: 'quart' }, { t: 5, r: [-24, 1, 0], ease: 'quad' },
        { t: 7, r: [-34, 1, 0], ease: 'sine' }, { t: 9, r: [-38, 1, 0], ease: 'quad' }, { t: 13, r: [-22, 1.4, 0], ease: 'cubic' },
        { t: 19, r: [-24.3, 3.2, 0], ease: 'cubic' }, { t: 26, r: [-12, 2, 0], ease: 'sine' }, { t: 34, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 13, r: [-4, 0, 0], ease: 'cubic' }, { t: 19, r: [16, 0, 0], ease: 'cubic' },
        { t: 26, r: [4, 0, 0], ease: 'sine' }, { t: 34, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 13, r: [2.2, 0, 0], ease: 'cubic' }, { t: 19, r: [-7, 0, 0], ease: 'cubic' },
        { t: 26, r: [-2, 0, 0], ease: 'sine' }, { t: 34, r: [0, 0, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 13, r: [-4, 0, 0], ease: 'cubic' },
        { t: 19, r: [16, 0, 0], ease: 'cubic' }, { t: 26, r: [4, 0, 0], ease: 'sine' },
        { t: 34, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 13, r: [2.2, 0, 0], ease: 'cubic' },
        { t: 19, r: [-7, 0, 0], ease: 'cubic' }, { t: 26, r: [-2, 0, 0], ease: 'sine' },
        { t: 34, r: [0, 0, 0], ease: 'linear' }],
      // The spear. Chambered high on t3, released on t5 with a 'snap' that no
      // other track carries, locked out at contact on t7 and three degrees past
      // it on t9 — the knee hyperextends into the blow instead of stopping dead
      // on it.
      hip_R: [{ t: 0, r: [-31.3, -4.3, -12], ease: 'quad' }, { t: 2, r: [-28.3, -0.46, -11.72], ease: 'sine' },
        { t: 3, r: [-68, -8, -13], ease: 'linear' }, { t: 5, r: [-60.53, -10.87, -13], ease: 'linear' },
        { t: 6, r: [-52.51, -13.96, -13], ease: 'linear' }, { t: 7, r: [-42, -18, -13], ease: 'snap' },
        { t: 9, r: [-51.25, -19.85, -13], ease: 'sine' }, { t: 13, r: [-46, -8, -13], ease: 'cubic' },
        { t: 19, r: [-32.3, 5, -12], ease: 'cubic' }, { t: 26, r: [-16, -4, -12], ease: 'sine' },
        { t: 34, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [74.8, 0, 0], ease: 'quad' }, { t: 2, r: [85.2, 0, 0], ease: 'sine' },
        { t: 3, r: [104, 0, 0], ease: 'linear' }, { t: 5, r: [74.71, 0, 0], ease: 'linear' },
        { t: 6, r: [43.23, 0, 0], ease: 'linear' }, { t: 7, r: [2, 0, 0], ease: 'snap' },
        { t: 9, r: [-7.25, 0, 0], ease: 'sine' }, { t: 13, r: [58, 0, 0], ease: 'cubic' },
        { t: 19, r: [95.4, 0, 0], ease: 'cubic' }, { t: 26, r: [56, 0, 0], ease: 'sine' },
        { t: 34, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-19.3, 1.4, 0], ease: 'quad' }, { t: 2, r: [-25.7, 1.6, 0], ease: 'sine' },
        { t: 3, r: [-30, 1, 0], ease: 'linear' }, { t: 5, r: [-13.92, 0.71, 0], ease: 'linear' },
        { t: 6, r: [3.36, 0.4, 0], ease: 'linear' }, { t: 7, r: [26, 0, 0], ease: 'snap' },
        { t: 9, r: [37, 0, 0], ease: 'sine' }, { t: 13, r: [-24, 0, 0], ease: 'cubic' },
        { t: 19, r: [-58.4, -12.1, 0], ease: 'cubic' }, { t: 26, r: [-32.1, -3, 0], ease: 'sine' },
        { t: 34, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 2, r: [-3.92, 0, 0], ease: 'sine' },
        { t: 3, r: [-6, 0, 0], ease: 'linear' }, { t: 5, r: [-0.26, 0, 0], ease: 'linear' },
        { t: 6, r: [5.91, 0, 0], ease: 'linear' }, { t: 7, r: [14, 0, 0], ease: 'snap' },
        { t: 9, r: [22, 0, 0], ease: 'sine' }, { t: 13, r: [4, 0, 0], ease: 'cubic' },
        { t: 19, r: [22, 0, 0], ease: 'cubic' }, { t: 26, r: [6, 0, 0], ease: 'sine' },
        { t: 34, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 3, r: [2.6, 0, 0], ease: 'quart' }, { t: 5, r: [-2, 0, 0], ease: 'snap' },
        { t: 7, r: [-6, 0, 0], ease: 'sine' }, { t: 9, r: [-8, 0, 0], ease: 'quad' }, { t: 13, r: [-2, 0, 0], ease: 'cubic' },
        { t: 19, r: [-10, 0, 0], ease: 'cubic' }, { t: 26, r: [-1.1, 0, 0], ease: 'sine' }, { t: 34, r: [0, 0, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 3, r: [-6, 0, 0], ease: 'quart' },
        { t: 5, r: [4, 0, 0], ease: 'snap' }, { t: 7, r: [14, 0, 0], ease: 'sine' },
        { t: 9, r: [18, 0, 0], ease: 'quad' }, { t: 13, r: [4, 0, 0], ease: 'cubic' },
        { t: 19, r: [22, 0, 0], ease: 'cubic' }, { t: 26, r: [6, 0, 0], ease: 'sine' },
        { t: 34, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 3, r: [2.6, 0, 0], ease: 'quart' },
        { t: 5, r: [-2, 0, 0], ease: 'snap' }, { t: 7, r: [-6, 0, 0], ease: 'sine' },
        { t: 9, r: [-8, 0, 0], ease: 'quad' }, { t: 13, r: [-2, 0, 0], ease: 'cubic' },
        { t: 19, r: [-10, 0, 0], ease: 'cubic' }, { t: 26, r: [-3, 0, 0], ease: 'sine' },
        { t: 34, r: [0, 0, 0], ease: 'linear' }],
    },
  },
};

// ---------------------------------------------------------------------------
// Overlapping action. `whip` (see the long note in ./reactions.js) pushes each
// joint's keys later as you walk down the kinetic chain, so the pelvis leads
// and the fist arrives last. On an attack it pivots on the clip's own
// `impact.tick`, which it pins with a real key first, so the contact pose comes
// out bit-identical — measured at 0.00mm, and `check.mjs`'s worst anchor ratio
// does not move.
//
// W is per clip and chosen by sweep: the largest whip that improved the
// head-lag centroid and the chain's monotonicity while regressing NOTHING in
// the round-11 guard — contact-speed-over-peak, follow-through past contact,
// worst single-tick hurtbox travel, wind-up silhouette retreat, and the tick-0
// and final stance match.
//
// That gate is why only 5 of 13 striking clips here are whipped. The rest —
//   k.midKick, k.highKick, k.roundhouse, k.axeKick, k.kneeStrike,
//   k.sideKick, k.spinKick, k.launcherKick
// — failed it at every W. Most failed on `carry`: past the pivot a delay is the
// same thing as holding the contact pose longer, so chain order and follow-
// through pull against each other, and follow-through wins where they collide.
// Their negative lag is in the RECOVERY POSE and wants re-posing, not re-timing.
// ---------------------------------------------------------------------------
const WHIP = {
  'k.lowKick': 6,
  'k.sweep': 6,
  'k.jumpKick': 2,
  'k.stomp': 5,
  'k.diveKick': 6,
};
for (const id in WHIP) whip(KICK_CLIPS[id], WHIP[id], { pivot: KICK_CLIPS[id].impact.tick });

// ---------------------------------------------------------------------------
// PROXIMAL LEAD. See the note above `lead` in reactions.js for the measurement
// and the mechanism, and the note above `LEAD` in punches.js for what the
// round-29 re-sweep changed. Budgets here moved most of any file, for one
// reason: the chain being scored used to be the ARM.
//
// A kick's kinetic chain is hips -> hip -> knee -> ankle -> foot. The metric
// walked hips -> spine -> clavicle -> shoulder -> elbow -> wrist instead, on
// all twelve of these clips, so every concordance number round 28 quoted for a
// kick described the limb that is not kicking. `lead`'s own chain has the same
// hole from the other side: LEAD_CHAIN contains no leg bone, so on a kick the
// operator advances exactly ONE of the five links. Chain variants that include
// `hip` and `knee` were swept alongside the budgets and one clip takes one.
//
// The tip is now the move's hitbox anchor. On k.stomp that changes it from the
// HAND to the foot, and on k.jumpKick from foot_L to foot_R -- the wrong leg.
// ---------------------------------------------------------------------------

/** Pelvis, thigh and shin lead; the shin and foot cover the last ticks. */
const FLOOR_LEAD_R = { hips: 1.0, hip_R: 0.70, knee_R: 0.45 };

const LEAD = {
  'k.lowKick': [0.25],        // was 8
  'k.midKick': [0.5],         // was 5
  'k.highKick': [1.5],        // was 5
  'k.roundhouse': [0.25],     // was 6
  'k.axeKick': [0.25],        // was 6
  'k.kneeStrike': [0.25],     // was 4
  'k.sideKick': [0.25],       // was 4
  'k.jumpKick': [0.25],       // was 5
  'k.launcherKick': [3],      // was 5
  'k.stomp': [0.25],          // was 0
  'k.diveKick': [1, FLOOR_LEAD_R],  // was 1.25 on the torso chain
  // 'k.sweep'    0.90 concordance and hips at 7% of peak at contact with no
  //              operator at all -- the second best-ordered chain of the 34.
  // 'k.spinKick' 0.95, the best. Round 28 gave both a budget and read them as
  //              failures; they were being scored along the ARM.
};
for (const id in LEAD) lead(KICK_CLIPS[id], LEAD[id][0], { pivot: KICK_CLIPS[id].impact.tick, chain: LEAD[id][1] });

// ---------------------------------------------------------------------------
// VELOCITY CARRY. See the note above `carry` in idle.js. Five clips are absent.
// k.midKick, k.highKick and k.roundhouse all pivot on a planted support foot,
// and smoothing the spin moves velocity into the span where that foot is down:
// worst planted-foot slide 157 -> 187, 153 -> 179 and 190 -> 230 mm/tick. That
// is the rubric's "floaty feet" bought with the rubric's "linear interpolation",
// which is not a trade. k.sweep and k.kneeStrike lose chain ordering, k.jumpKick
// loses both.
// ---------------------------------------------------------------------------
const CARRY = {
  'k.lowKick': 2, 'k.axeKick': 2, 'k.sideKick': 2, 'k.launcherKick': 2,
  'k.stomp': 2, 'k.diveKick': 2,
};
for (const id in CARRY) carry(KICK_CLIPS[id], { N: CARRY[id], pins: [KICK_CLIPS[id].impact.tick] });

// ---------------------------------------------------------------------------
// SAGITTAL LEAN. See the long note above `sagittal` in ./idle.js.
//
// THIS SET IS THE POINT OF THAT OPERATOR. `contrapposto` reached 77 of 92 clips
// and NONE of the thirteen kicks, because a stance-solved leg compensation moves
// a foot at -104 deg of hip flex by 60-210 mm. `sagittal` never keys `hips`, so
// every bone from the pelvis down is bit-identical here — measured, 0.0000 mm on
// hips, both hips, knees, ankles, feet and toes at every tick of every clip — and
// a kick's hitbox lives on a foot or a knee, so the whole torso is free at the
// contact tick.
//
// Sign is not chosen: where the clip already commits >= 3 deg of on-screen lean
// the operator amplifies it, and where it does not the torso counterbalances the
// sagittal travel of whichever limb the rig says actually swings.
//
// Amount is the largest the gate sweep accepted, targeting 18 deg of on-screen
// lean at the contact tick under the fight camera. What it bought, measured at
// each clip's own `impact.tick`, with the striking-anchor movement beside it:
//
//   k.midKick      -0.4 ->  -17.7 deg   anchor 0.000 mm   ratio 1.00 -> 1.00
//   k.lowKick       0.6 ->  -17.8       anchor 0.000      1.00 -> 1.00
//   k.sideKick      7.1 ->   18.1       anchor 0.000      1.00 -> 1.00
//   k.highKick     -8.0 ->  -17.6       anchor 0.000      1.00 -> 1.00
//   k.launcherKick -9.0 ->  -17.6       anchor 0.000      1.00 -> 1.00
//   k.jumpKick      4.8 ->   17.9       anchor 0.000      0.61 -> 0.61
//   k.kneeStrike    6.3 ->   17.4       anchor 0.000      0.99 -> 0.99
//   k.axeKick     -12.6 ->  -17.3       anchor 0.000      1.00 -> 1.00
//
// FIVE KICKS TAKE NOTHING AND EACH FOR A NAMED REASON. `k.sweep` (-25 deg) and
// `k.diveKick` (+24) are already past the target on their own. The other three
// are blocked by their own move data rather than by the rig: `k.roundhouse`,
// `k.spinKick` and `k.stomp` each declare a HAND box alongside the foot box
// (`foot_R,ankle_R,hand_R,wrist_R` for the roundhouse), and a hand is carried by
// the chest — so the smallest amount on the sweep already moves a declared
// striking anchor 47, 631 and 262 mm. That is the 1 mm gate doing its job, and
// it is worth knowing that those three "kicks" can hit with a fist.
// ---------------------------------------------------------------------------
const SAGITTAL_TABLE = {
  'k.axeKick': -6, 'k.highKick': -10, 'k.jumpKick': 14, 'k.kneeStrike': 12,
  'k.launcherKick': -10, 'k.lowKick': -22, 'k.midKick': -18, 'k.sideKick': 30,
};
for (const id in SAGITTAL_TABLE) sagittal(KICK_CLIPS[id], SAGITTAL_TABLE[id]);

for (const id in KICK_CLIPS) validateClip(KICK_CLIPS[id], BONE_NAMES);

export default KICK_CLIPS;

// ---------------------------------------------------------------------------
// THE OFF-ARM. The measurement, the instruments and the full before/after table
// are written up at the foot of punches.js; this is the half that lives here.
//
// Four kicks were re-authored. What they had in common was the defect: measured
// in the CHEST's own frame -- which removes the torso carry and is the only
// honest read of what an arm is doing -- k.midKick's whole left arm lived inside
// a 103 x 69 x 155mm box for the entire kick, the smallest envelope of any
// attack in the library, and k.highKick and k.roundhouse both parked the hand at
// chest-local (~205, -53, 86) at their contact tick, ten millimetres apart. A
// mid, a high and a spinning kick shared one upper-body silhouette.
//
// WHAT A KICK'S OFF-ARM IS FOR. A round kick squares the pelvis off one planted
// foot and carries the turn in the root's `ry` track: 10 degrees on k.lowKick, 58
// on k.midKick, 70 on k.highKick, 96 on k.roundhouse. Something has to pay for
// that angular momentum and the only mass available is this arm. So all four
// wind UP and across on the chamber and are thrown DOWN and wide as the shin
// arrives -- one family, four amplitudes, deliberately proportional to the yaw
// each clip actually commits:
//
//   clip           chest-local y at the throw   own% before -> after
//   k.lowKick               -202                    42% -> 66%
//   k.midKick               -341                     7% -> 63%
//   k.highKick              -389, and z -279          19% -> 64%
//   k.roundhouse            amplified in place       43% -> 50%
//
// k.lowKick is the smallest on purpose. A lead-leg snap that threw the arm as
// hard as a high round kick would read as the same move at a different height,
// which is the defect one level up from the one being fixed.
//
// k.roundhouse is an AMPLIFICATION, not a rewrite. It was the one clip whose
// off-arm was already doing something -- its shoulder wraps the arm 152 degrees
// around the body through the spin recovery, which is why it measured 43% where
// a straight punch measured 8. Its shoulder and elbow arc is left exactly as
// authored and only the three tracks that were dead single keys -- clavicle,
// wrist, hand -- are given the same arc.
//
// EVERY FOOT IS BIT-IDENTICAL. Only left-arm-chain bones are touched and no
// anchor descends from any of them: foot_R measures 469.2 / 5221.6 / 6093.6 /
// 7063.1mm on the four clips before and after, and the foot_R half of
// `offhandspread.mjs` is unchanged digit for digit against a pristine checkout.
//
// ONE CONSTRAINT BOUND AND IS RECORDED WHERE IT BINDS. k.highKick's off-hand
// crossed 680mm in the single tick that also spins the body 20 degrees of yaw,
// over the 60cm-per-tick limit the header of punches.js sets. See the note above
// its `clavicle_L` track: flattening the ease was not enough and it took two
// interpolated linear keys, which is how the striking limbs in this file are
// keyed through their own drive anyway.
// ---------------------------------------------------------------------------
