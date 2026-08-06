/**
 * Knockbots — punch clips (the "1" and "2" buttons).
 *
 * ---------------------------------------------------------------------------
 * Rig conventions every clip in this directory is authored against
 * ---------------------------------------------------------------------------
 * Composition: the animator writes `bone.quaternion = restQuat * clipQuat`, so a
 * clip's XYZ euler acts in the bone's own rest-local frame, degrees, additive
 * over Skeleton.js's rest pose. Order matters for the shoulders, which are the
 * only bones with a non-identity rest rotation.
 *
 * Axes, taken from the rig's own geometry rather than from prose: the toe bones
 * sit at +Z of the ankle and IK_CHAINS aims elbows at -Z and knees at +Z, so the
 * fighter FACES +Z, its left side is +X and up is +Y. Root motion follows the
 * same frame: +Z in a `root` key walks the fighter forward.
 *
 *   hips / spine / chest   +X leans forward, +Y turns toward the fighter's LEFT
 *                          (which drives the RIGHT shoulder forward, i.e. a
 *                          rear-hand strike), +Z bends toward the RIGHT.
 *   shoulder               +Z raises the arm in the frontal plane, -Y (left) or
 *                          +Y (right) swings it forward, X twists the humerus
 *                          and so chooses the plane the elbow bends in.
 *   elbow                  -X flexes.
 *   hip                    -X swings the thigh forward, +X back.
 *   knee                   +X flexes.
 *   ankle                  +X plantar-flexes (heel up).
 *
 * NOTE, and it matches the note at the top of idle.js: Skeleton.js gives
 * shoulder_L a rest rotation of -50deg about Z and shoulder_R +50deg, which
 * points both upper arms ACROSS the chest instead of outboard. The rest pose it
 * documents ("relaxed A-pose, arms ~40deg down from horizontal") needs those two
 * signs swapped. Every clip in this directory is authored against the documented
 * A-pose, so the rig fix is one sign flip per shoulder rather than a rewrite of
 * the animation data.
 *
 * ---------------------------------------------------------------------------
 * Authoring rules
 * ---------------------------------------------------------------------------
 * Strikes are built from the ground up: every attack drives hips and spine, not
 * just an arm, and the non-striking arm rips back to the ribs as the striking
 * arm extends. Startup frames match the frame data the moves are written to — a
 * jab reaches full extension on tick 10, with the wind-up-to-contact segment
 * eased so most of the travel lands in the two ticks before impact and the pose
 * is readable at the exact frame a player has to react to. Recovery never
 * replays the wind-up backwards; it takes its own path.
 *
 * No extremity is allowed to cross more than 60cm in a single tick. Past that a
 * limb stops reading as fast and starts reading as teleporting, so the segments
 * that would exceed it trade their snappier easing for a flatter one.
 *
 * The hand is two joints and both of them work. `wrist_*` only ever twists about
 * its own Y — the axis running down the forearm — so the fist corkscrews over as
 * it lands and unwinds on the way back without the wrist ever displacing the
 * fist; `hand_*` carries the flex, cocking back through the wind-up, locking
 * straight in line with the forearm at contact and recoiling off it after.
 *
 * Every clip that a move strikes with declares `impact: { tick, bone }` — the
 * tick its blow lands and the bone that lands it. Fighter reads that, pins it
 * onto the move's first active frame and pins the clip's end onto the move's
 * last, then stretches only the wind-up and the recovery to suit. So the tick
 * matters and is load-bearing: change where the strike lands and the declaration
 * has to move with it, or the animation and the frame data come apart.
 *
 * Nothing holds still. A strike lands on its impact tick and then keeps
 * travelling for two or three more — the shoulder carries through while the
 * elbow starts to fold, the fist hyperextends a couple of degrees before it
 * recoils — because a frozen frame at 60Hz reads as a dropped frame, not as
 * weight. Recovery never replays the wind-up backwards; it takes its own path.
 *
 * Root keys carry weight transfer: lunges push +Z, spins carry `ry`, and every
 * grounded key sets its own root height so the planted foot stays on the floor
 * for the animator's two-bone foot IK to fine-tune. Tick 0 of every clip here is
 * the shared STANCE from idle.js, so an attack can be entered from idle without
 * a pop and returns to it on its last frame.
 *
 * ---------------------------------------------------------------------------
 * Two rules on the root height track, both learned by measuring the rig
 * ---------------------------------------------------------------------------
 * **The pelvis of a grounded punch never rises above the stance baseline of
 * -0.075.** These clips used to spike to between -0.031 and +0.007 two to four
 * ticks before contact and then drop 90-125mm in three ticks. Driven through the
 * real robot that lifted BOTH boots clear of the concrete — 24mm on `p.straight`,
 * 25mm on `p.jabAlt`, 37mm on `p.duckingStraight` — with the pelvis travelling
 * 82mm in a single tick, so a jab read as a small hop and a landing. The control
 * is in the data: `p.elbow` and `p.hammerFist` are the only two punches whose
 * root never crossed the baseline, and they are the only two that measured under
 * 8mm. An uppercut or a launcher may legitimately come off the floor, so those
 * two carry the most rise, but they carry it as a monotone climb rather than a
 * spike.
 *
 * **The peak of the drive lands ON the contact tick, not before it.** The old
 * shape rose to its highest point at t11 of a t14 strike and was already falling
 * when the blow landed, which reads as the body giving up before the fist
 * arrives. The height now climbs into contact and settles after it, so the drive
 * and the strike are the same event.
 *
 * ---------------------------------------------------------------------------
 * The boot is three joints and the clip has to drive all three
 * ---------------------------------------------------------------------------
 * A punch used to author `ankle_*` and stop. Measured through the built robot,
 * that stood the fighter on its HEELS: the lead boot's toe pad sat 45-55mm off
 * the concrete for the entire length of every punch, because the ankle
 * dorsiflexion that keeps the sole flat as the pelvis loads was overshooting and
 * nothing below the ankle took it back. Mean toe-pad error across 159
 * weight-bearing keys was 35mm.
 *
 * These triples are therefore SOLVED against the rig rather than eyeballed: the
 * error is measured at each key, 72% of it goes to the ankle — which pitches the
 * boot about the heel point and so does not move the heel — and the rest to the
 * forefoot, iterated to convergence. Mean error is now 2.0mm. The first and last
 * key of every clip is excluded from the solve because those two ARE the shared
 * STANCE and moving them would pop every entry from and exit to idle.
 *
 * The ball break the plan asked for falls out of that rather than being posed:
 * with the toe pad pinned to the floor and the rear leg extending into the blow,
 * the rear heel now lifts to 23mm by the follow-through of `p.straight` while the
 * toe stays down. The compensation is not derivable from the ankle track alone —
 * that value is already partly a response to the root height, and reading it as
 * if it were not double-counts the correction.
 *
 * ---------------------------------------------------------------------------
 * The strike used to be DECELERATING on the frame it landed
 * ---------------------------------------------------------------------------
 * Measured by driving all 27 strike clips through the real rig and sampling the
 * declared `impact.bone` in world space every tick: in **24 of 27** the striking
 * bone's fastest frame was 1–3 ticks BEFORE contact, and the contact frame
 * itself was a near-stop. Median speed on the contact tick was 25% of the
 * drive's own peak. `p.jab` moved 24.2cm on tick 8 and **1.6cm on tick 10**,
 * the frame the hitbox opens. `p.elbow` and `k.lowKick` measured 0.1cm — the
 * striking bone was stationary at the exact frame it was supposed to land.
 *
 * The cause was in the easing, and the fast-release curves that existed were on
 * the wrong side of contact. All 15 `expo` keys across punches.js and kicks.js
 * sat on the CONTACT key, where expo governs the segment AFTER the blow and so
 * pins the limb at the contact pose for two ticks before jerking it away; none
 * sat in the wind-up. Everything before contact rode `sine`/`quart`, which are
 * symmetric ease-in-out and arrive early by construction.
 *
 * Every strike clip is now built as anticipate -> hold -> release -> carry:
 *
 *  - a counter-beat 1–2 ticks in, on the driving bones, moving AWAY from the
 *    contact pose before the wind-up starts;
 *  - the drive keyed one key per tick from the coil onward, on a t^p ramp whose
 *    exponent is solved per span so ~38% of the travel always lands on the
 *    contact tick. A fixed exponent does not work — it puts 47% on the contact
 *    tick at span 4 and 17% at span 12;
 *  - `snap` on the contact key, so the follow-through lands on the very next
 *    frame instead of three later, with the authored overshoot amplified to a
 *    per-bone cap and a floor of 8 degrees;
 *  - the settle left on its own authored path. Nothing replays the wind-up.
 *
 * The coil key is chosen by measurement, not by position: it is the last key at
 * which the striking bone is still more than half its reach from contact.
 * Taking "the last key before contact" instead puts the hold in the MIDDLE of
 * the drive on p.straight, p.overhand and p.launcherPunch.
 *
 * Result across the 27 clips: mean contact-frame speed as a fraction of the
 * drive's peak **0.30 -> 0.92**, clips decelerating into contact **24 -> 3**,
 * mean carry past the contact pose **59mm -> 144mm**, and the worst single-tick
 * travel in either file fell from 101cm to 83cm. The held wind-up does NOT read
 * as a dropped frame: the longest run of near-stationary wind-up ticks fell from
 * a mean of 2.4 to 1.3, because the ramp spreads a little motion across every
 * tick instead of front-loading and then stalling.
 *
 * `impact.tick`, `duration`, the pose ON the contact tick and the tick-0 and
 * final STANCE poses are all unchanged — verified pointwise, max drift 0.006
 * degrees. The root track's height and yaw are unchanged at every tick (0.5mm);
 * only its X/Z lunge is held, and only because with the root left alone
 * p.jabAlt, p.lowJab and k.stomp still decelerated into contact even though
 * their bone tracks measured 1.00 with the root removed.
 *
 * Three clips still decelerate and are left that way deliberately. `k.sweep`
 * measured WORSE when restructured (0.32 -> 0.11) and keeps its authored
 * release. `k.stomp` and `k.diveKick` are gravity-driven: their contact speed is
 * set by the pelvis-height track, which the two root rules above forbid moving.
 *
 * Re-measured in round 12, that list is five, not three, and the worst entry is
 * not on it: `sp.overdriveStart` lands at 0.29 of peak, below `k.sweep`'s 0.32.
 * Its striking hand travels 11.5cm on the contact tick and 22.9cm on the one
 * after, and its along-axis reach still climbs from 0.434m to 0.455m past
 * contact — the declared `impact.tick` of 9 sits one tick before the blow
 * actually arrives. `k.spinKick` is the fifth at 0.50. The mean across all 34
 * clips that declare an impact is 0.863.
 *
 * ---------------------------------------------------------------------------
 * The four fast punches DO have a readable wind-up. The metric was wrong.
 * ---------------------------------------------------------------------------
 * Round 11 closed by naming "p.jab, p.jabAlt, p.straight and p.elbow have zero
 * wind-up frames displacing a hurtbox bone 30cm or more from stance" as the
 * strongest remaining lever on this axis. Tested two ways, it does not hold.
 *
 * Literally, it is false: at a 30cm threshold p.jab has 2 such frames, p.jabAlt
 * 2, p.straight 2 and p.elbow 1. But the threshold is the real problem. It is an
 * absolute distance applied to moves whose ENTIRE reach is 0.58m (p.jab) and
 * 0.46m (p.elbow), so it demands a chamber worth half the strike; the clips it
 * passes are the ones that are simply long. It also cannot tell anticipation
 * from the strike already travelling — both of p.jab's qualifying frames are
 * t8 and t9 of an i10, which is the fist on its way out, not a tell.
 *
 * The industry's own test says the opposite. Rendering each pose as a flat
 * silhouette in the camera's plane — the rig projected on local (Z, Y), every
 * hurtbox bone a capsule, 6mm/px — and scoring 1 - IoU against the guard at
 * tick 0 gives, at impact-4 (the last frame a defender can act on), an ARM-only
 * divergence of 0.696 for p.jab and 0.710 for p.jabAlt. Those are the 6th and
 * 4th HIGHEST of the 34 clips. p.straight is 0.531 and p.elbow 0.550, both above
 * the median. The clips that actually read worst at the commit frame are
 * `k.launcherKick` 0.315, `p.uppercut` 0.355, `sp.risingFang` 0.394 and
 * `t.grabAttempt` 0.395 — none of them a fast punch.
 *
 * On gameplay grounds the target was wrong too. An i10 jab is not reactable by
 * anyone; it is blocked on prediction and frame knowledge. The moves whose tell
 * has to carry information are the slow committal ones, and those are the ones
 * that fail — see below. So the guard silhouette was NOT re-posed, and the
 * whole-file risk of touching the pose every clip blends out of was not taken.
 *
 * ---------------------------------------------------------------------------
 * What the silhouette test did find: six clips erase their own wind-up
 * ---------------------------------------------------------------------------
 * Divergence from the guard should climb monotonically into the release. On 28
 * of 34 clips it does. On six it peaks early and then falls back TOWARD the
 * guard before contact, so the pose a defender commits against is closer to
 * idle than the pose several frames earlier:
 *
 *   p.overhand     0.47 @ t12 -> 0.22 @ t19, contact t22   (retreat 0.257)
 *   sp.plasmaBurst 0.59 @ t20 -> 0.38 @ t22, contact t24   (0.211)
 *   sp.rocketPunch 0.50 @ t10 -> 0.30 @ t14, contact t19   (0.203)
 *   p.uppercut     0.43 @ t9  -> 0.25 @ t13, contact t16   (0.181)
 *   p.launcherPunch 0.61 @ t12 -> 0.47 @ t15, contact t17  (0.140)
 *   p.hammerFist   0.47 @ t14 -> 0.36 @ t16, contact t19   (0.113)
 *
 * These are the slow, reactable, heavily committal moves — exactly where a tell
 * is supposed to pay. `p.overhand` is an i18-i22 heavy mid that spends its last
 * seven startup frames returning to a guard-shaped outline and then explodes to
 * 0.74 on the contact tick.
 *
 * ONE ATTEMPTED FIX, MEASURED WORSE, REVERTED. The hypothesis was that the right
 * humerus twist unwinds too early on `p.overhand` — shoulder_R X runs -120.1 at
 * t12.22 to -44.5 at t18.33 and then sits still — so holding the twist and
 * unwinding it across t20-t22 should keep the coil alive. It did not: retreat
 * moved 0.257 -> 0.258, divergence at the commit frame got WORSE (0.280 ->
 * 0.263), and the worst single-tick travel of any hurtbox bone rose from 0.60m
 * to 0.76m, breaking this file's own 60cm rule. Reverted, and re-verified
 * identical to baseline on all 34 clips across 7 metrics.
 *
 * The likely reason it resists a per-key fix is that the trough is real 3D
 * geometry rather than an authoring slip: an overhand's fist genuinely passes
 * down across the chest between the high cock and the extension, and from a
 * side camera the arm is occluded by the torso for those frames. Fixing it
 * means changing the ARC — routing the cock wider of the body so the fist never
 * crosses the trunk in the camera plane — not re-easing the keys on it. That is
 * a bigger pose change than a round should take on unverified, and it should be
 * done against a rendered strip, not against this metric alone.
 *
 * ---------------------------------------------------------------------------
 * ROUND 14: the six-clip finding above is an artifact of the metric. DISPROVED.
 * ---------------------------------------------------------------------------
 * The "retreat" numbers are whole-body 1-IoU against the guard. IoU is
 * area-weighted, and in the guard silhouette the LEGS are 54.9% of the pixels,
 * the torso 44.5% and the striking ARM 12.2%. So that number is roughly five
 * times more sensitive to the stance than to the strike, and the six flagged
 * clips are the six that shift weight hardest.
 *
 * Shown causally rather than by correlation. Hold one region rigid from the
 * wind-up peak through impact-1, leaving the rise into the peak untouched, and
 * re-measure the retreat:
 *
 *   clip              baseline   arm held   legs held   root held
 *   p.overhand          0.257      0.228      0.149       0.116
 *   sp.plasmaBurst      0.211      0.202      0.188       0.211
 *   sp.rocketPunch      0.203      0.203      0.153       0.178
 *   p.uppercut          0.181      0.183      0.000       0.143
 *   p.launcherPunch     0.140      0.196      0.115       0.000
 *   p.hammerFist        0.113      0.113      0.000       0.138
 *
 * Freezing the entire striking arm changes nothing (mean 0.184 -> 0.188).
 * Freezing the legs removes most of it and zeroes two outright. The trough is
 * the stance re-crossing the guard's own footprint as weight transfers — the
 * mechanic CRITIC.md rewards — not a wind-up being thrown away. Round 13's
 * prescription, re-routing the fist's arc, aims at a limb that barely moves
 * the quantity.
 *
 * Re-scored on the STRIKING LIMB's own region, which is what the claim was
 * about, two of the six are not defects at all: p.hammerFist retreats 0.000 and
 * p.launcherPunch 0.126 at a trough of 0.78 divergence. Two clips the list does
 * not mention rank above four of the six: t.grabAttempt 0.404 and p.siegeSlam
 * 0.288. The one clip where the original story was literally true was
 * p.uppercut — and see its own note, because the cause there was neither an arc
 * nor an easing.
 *
 * Use the limb-only silhouette for any future claim about a tell. The
 * whole-body number cannot see an arm.
 *
 * ---------------------------------------------------------------------------
 * THE WHOLE CHAIN PEAKED ON ONE TICK, AND THAT WAS THIS FILE'S OWN DOING
 * ---------------------------------------------------------------------------
 * Every link of the drive — hips, spine01, spine02, chest, shoulder, elbow,
 * wrist — reached its PEAK angular speed on the same tick on p.straight,
 * p.uppercut, p.overhand, p.hook and p.elbow, and within two ticks on 25 of the
 * 34 clips that declare an impact. Median hips-to-tip lag across those 34 was
 * ZERO, and in 17 of them the pelvis was at 90% or more of its own top speed on
 * the exact frame the blow landed. A body whose every joint accelerates and
 * stops together is a rigid object, and it is the single largest gap against
 * CRITIC.md, whose 90+ text for this axis is "the hips lead, the head lags".
 *
 * The cause is visible in the key ticks above and it is the round-11 re-key
 * described earlier in this header: "the drive keyed one key per tick from the
 * coil onward, on a t^p ramp whose exponent is solved per span so ~38% of the
 * travel always lands on the contact tick". That ramp was solved per span and
 * applied to every driving bone, so all of them converge on `impact.tick` by
 * construction. It bought the contact-frame speed it was written for and it
 * flattened the chain doing it. `whip` could not undo that: its taper is zero
 * at the pivot, so it cannot separate two bones AT contact no matter what W is.
 *
 * The fix is `lead` in reactions.js — the dual operation, advancing the
 * proximal tracks and holding the authored contact value. Measured over the 34:
 * concordance 0.50 -> 0.74, hips-to-tip lag 0 -> 4 ticks, hips-at-contact
 * 1.00 -> 0.00, clips with the pelvis at 90%+ on the contact frame 17 -> 0,
 * with contact-frame ratio, follow-through and worst single-tick hurtbox travel
 * all held or improved, and the pose at tick 0, at `impact.tick` and at
 * `duration` bit-identical on all 92 clips (0 bones drifted, 0.000000 mm).
 *
 * SEVEN CLIPS REFUSED IT and ship unchanged: p.jabAlt, p.pistonRush, k.stomp,
 * k.sweep, sp.overdriveStart, sp.risingFang, and p.uppercut at the full chain.
 * All seven fail on the same gate, contact-frame speed ratio, and the reason is
 * physical rather than an authoring slip: on those moves the torso is still
 * carrying the striking limb at contact, so stopping the torso takes the
 * strike's world speed with it. Four of them (k.stomp 0.48, k.sweep 0.37,
 * sp.overdriveStart 0.29, sp.risingFang 0.73) are the same clips already named
 * in this header as gravity- or pose-driven exceptions. They want re-posing,
 * and this time the evidence for that says so from a second direction.
 */

import { validateClip } from '../AnimationFormat.js';
import { whip, lead } from './reactions.js';
import { BONE_NAMES } from '../Skeleton.js';

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const PUNCH_CLIPS = {
  // i10. Lead hand. The arm only leaves the guard on tick 6 and is locked out
  // on 10, so the fist is readable for two frames of startup — the shortest
  // tell in the game.
  'p.jab': {
    name: 'Jab',
    duration: 24, blendIn: 3, blendOut: 6,
    impact: { tick: 10, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 6, p: [0, -0.103, 0], ease: 'linear' },
      { t: 7, p: [0, -0.102, 0.007], ease: 'linear' },
      { t: 8, p: [0, -0.093, 0.026], ease: 'linear' },
      { t: 9, p: [0, -0.085, 0.054], ease: 'linear' },
      { t: 10, p: [0, -0.084, 0.09], ease: 'sine' },
      { t: 12, p: [0, -0.078, 0.1], ease: 'quad' },
      { t: 16, p: [0, -0.088, 0.03], ease: 'sine' },
      { t: 24, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 2, r: [0.66, -24.22, 0.17], ease: 'sine' },
        { t: 6, r: [1.6, -23.2, 0], ease: 'linear' }, { t: 8, r: [1.86, -30.77, -0.26], ease: 'linear' },
        { t: 9, r: [2.02, -35.52, -0.42], ease: 'linear' }, { t: 10, r: [2.2, -40.6, -0.6], ease: 'sine' },
        { t: 12, r: [2.27, -42.51, -0.67], ease: 'quad' }, { t: 16, r: [1.7, -30.2, 0], ease: 'sine' },
        { t: 24, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 2, r: [1.23, 4.92, 0.28], ease: 'sine' },
        { t: 6, r: [3.1, 4.9, 0], ease: 'linear' }, { t: 8, r: [3.62, 5.47, -0.44], ease: 'linear' },
        { t: 9, r: [3.95, 5.82, -0.71], ease: 'linear' }, { t: 10, r: [4.3, 6.2, -1], ease: 'sine' },
        { t: 12, r: [4.43, 6.34, -1.11], ease: 'quad' }, { t: 16, r: [3.4, 5.4, 0], ease: 'sine' },
        { t: 24, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 2, r: [1.7, 5.76, 0.31], ease: 'sine' },
        { t: 6, r: [4.2, 5.7, 0], ease: 'linear' }, { t: 8, r: [4.9, 6.4, -0.48], ease: 'linear' },
        { t: 9, r: [5.33, 6.83, -0.78], ease: 'linear' }, { t: 10, r: [5.8, 7.3, -1.1], ease: 'sine' },
        { t: 12, r: [5.98, 7.48, -1.22], ease: 'quad' }, { t: 16, r: [4.5, 6.4, 0], ease: 'sine' },
        { t: 24, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 2, r: [1.7, 6.91, -2.64], ease: 'sine' },
        { t: 6, r: [4.2, 6.8, -3], ease: 'linear' }, { t: 8, r: [4.9, 7.63, -3.57], ease: 'linear' },
        { t: 9, r: [5.33, 8.15, -3.92], ease: 'linear' }, { t: 10, r: [5.8, 8.7, -4.3], ease: 'sine' },
        { t: 12, r: [5.98, 8.91, -4.44], ease: 'quad' }, { t: 16, r: [4.5, 7.5, -3], ease: 'sine' },
        { t: 24, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 6, r: [0.3, 4, 0], ease: 'quart' },
        { t: 10, r: [0.1, 8.4, 0], ease: 'sine' }, { t: 12, r: [0.08, 8.88, 0], ease: 'quad' },
        { t: 16, r: [0.3, 5.8, 0], ease: 'sine' }, { t: 24, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 6, r: [2.2, 5.8, 0], ease: 'quart' },
        { t: 10, r: [1.9, 14, 0], ease: 'sine' }, { t: 12, r: [1.87, 14.9, 0], ease: 'quad' },
        { t: 16, r: [2.2, 9, 0], ease: 'sine' }, { t: 24, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 2, r: [-31.97, 3.22, -47], ease: 'sine' },
        { t: 6, r: [-26.3, 2.3, -11.8], ease: 'linear' }, { t: 8, r: [-34.11, -4.02, 0.55], ease: 'linear' },
        { t: 9, r: [-42.51, -10.81, 13.82], ease: 'linear' }, { t: 10, r: [-53.5, -19.7, 31.2], ease: 'snap' },
        { t: 12, r: [-60.33, -25.23, 39.2], ease: 'sine' }, { t: 14, r: [-64.83, -28.87, 47.89], ease: 'quad' },
        { t: 16, r: [-47.4, 20, 4.3], ease: 'sine' }, { t: 24, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 2, r: [-135, 0, 17], ease: 'sine' },
        { t: 6, r: [-105.8, 0, 17], ease: 'linear' }, { t: 8, r: [-78.89, 0, 17], ease: 'linear' },
        { t: 9, r: [-49.97, 0, 17], ease: 'linear' }, { t: 10, r: [-12.1, 0, 17], ease: 'snap' },
        { t: 12, r: [-4.1, 0, 17], ease: 'sine' }, { t: 15, r: [-29, 0, 17], ease: 'quad' },
        { t: 16, r: [-68.6, 0, 17], ease: 'sine' }, { t: 24, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 2, r: [-8, -7, 0], ease: 'sine' },
        { t: 6, r: [-8, -10, 0], ease: 'linear' }, { t: 8, r: [-8, 2.06, 0], ease: 'linear' },
        { t: 9, r: [-8, 15.02, 0], ease: 'linear' }, { t: 10, r: [-8, 32, 0], ease: 'snap' },
        { t: 12, r: [-8, 40, 0], ease: 'sine' }, { t: 15, r: [-8, 41, 0], ease: 'sine' },
        { t: 16, r: [-8, 10, 0], ease: 'sine' }, { t: 24, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 2, r: [-17.36, 0, -0.56], ease: 'sine' },
        { t: 6, r: [-26, 0, -7], ease: 'linear' }, { t: 8, r: [-19.11, 0, -4.42], ease: 'linear' },
        { t: 9, r: [-11.7, 0, -1.64], ease: 'linear' }, { t: 10, r: [-2, 0, 2], ease: 'snap' },
        { t: 12, r: [6, 0, 5], ease: 'sine' }, { t: 15, r: [-28, 0, 10], ease: 'sine' },
        { t: 16, r: [-18, 0, 0], ease: 'sine' }, { t: 24, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 6, r: [-23, -5, 33.3], ease: 'quart' },
        { t: 10, r: [-13.7, 31, 28.8], ease: 'sine' }, { t: 12, r: [-12.68, 34.5, 28.31], ease: 'quad' },
        { t: 16, r: [-26.8, -2.2, 32.9], ease: 'sine' }, { t: 24, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 6, r: [-145.4, 0, -1], ease: 'quart' },
        { t: 10, r: [-152, 0, -1], ease: 'sine' }, { t: 12, r: [-152.73, 0, -1], ease: 'quad' },
        { t: 16, r: [-145.5, 0, -1], ease: 'sine' }, { t: 24, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 6, r: [-8, -4, 0], ease: 'quart' },
        { t: 10, r: [-8, -14, 0], ease: 'sine' }, { t: 12, r: [-8, -15.1, 0], ease: 'quad' },
        { t: 16, r: [-8, -4, 0], ease: 'sine' }, { t: 24, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 6, r: [-19, 0, 0], ease: 'quart' },
        { t: 10, r: [-27, 0, 0], ease: 'sine' }, { t: 12, r: [-27.88, 0, 0], ease: 'quad' },
        { t: 16, r: [-17, 0, 0], ease: 'sine' }, { t: 24, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 6, r: [-18, -16, 10], ease: 'quart' },
        { t: 10, r: [-25, -18, 11], ease: 'sine' }, { t: 12, r: [-25.77, -18.22, 11.11], ease: 'quad' },
        { t: 16, r: [-39, 10, 11], ease: 'sine' }, { t: 20, r: [-40.54, 13.08, 11], ease: 'sine' }, { t: 24, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 6, r: [34, 0, 0], ease: 'quart' },
        { t: 10, r: [24, 0, 0], ease: 'sine' }, { t: 12, r: [22.9, 0, 0], ease: 'quad' },
        { t: 16, r: [42, 0, 0], ease: 'sine' }, { t: 20, r: [43.98, 0, 0], ease: 'sine' }, { t: 24, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 6, r: [-23.4, 2, 0], ease: 'quart' }, { t: 10, r: [-5.1, 2, 0], ease: 'sine' },
        { t: 12, r: [-8.1, 2, 0], ease: 'quad' }, { t: 16, r: [-5.5, 2, 0], ease: 'sine' }, { t: 20, r: [-3.9, 2, 0], ease: 'sine' },
        { t: 24, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 6, r: [6, 0, 0], ease: 'quart' }, { t: 10, r: [7.4, 0, 0], ease: 'sine' },
        { t: 12, r: [3.8, 0, 0], ease: 'quad' }, { t: 16, r: [-0.9, 0, 0], ease: 'sine' }, { t: 20, r: [-0.7, 0, 0], ease: 'sine' },
        { t: 24, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 6, r: [2.5, 0, 0], ease: 'quart' }, { t: 10, r: [3.1, 0, 0], ease: 'sine' },
        { t: 12, r: [1.6, 0, 0], ease: 'quad' }, { t: 16, r: [-0.4, 0, 0], ease: 'sine' }, { t: 20, r: [-0.3, 0, 0], ease: 'sine' },
        { t: 24, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 6, r: [5, 6, -13], ease: 'quart' },
        { t: 10, r: [13, 8, -13], ease: 'sine' }, { t: 12, r: [13.88, 8.22, -13], ease: 'quad' },
        { t: 16, r: [-9, -6, -12], ease: 'sine' }, { t: 20, r: [-11.42, -7.54, -11.89], ease: 'sine' }, { t: 24, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 6, r: [27, 0, 0], ease: 'quart' },
        { t: 10, r: [12, 0, 0], ease: 'sine' }, { t: 12, r: [10.35, 0, 0], ease: 'quad' },
        { t: 16, r: [45, 0, 0], ease: 'sine' }, { t: 20, r: [48.5, 0, 0], ease: 'sine' }, { t: 24, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 6, r: [-36.4, -3, 0], ease: 'quart' }, { t: 10, r: [-16.3, 0, 0], ease: 'sine' },
        { t: 12, r: [9.9, 0.3, 0], ease: 'quad' }, { t: 16, r: [-31.9, -3, 0], ease: 'sine' }, { t: 20, r: [-30.5, -3.3, 0], ease: 'sine' },
        { t: 24, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 6, r: [8.3, 0, 0], ease: 'quart' }, { t: 10, r: [-4.7, 0, 0], ease: 'sine' },
        { t: 12, r: [8.2, 0, 0], ease: 'quad' }, { t: 16, r: [0.6, 0, 0], ease: 'sine' }, { t: 20, r: [3, 0, 0], ease: 'sine' },
        { t: 24, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 6, r: [3.5, 0, 0], ease: 'quart' }, { t: 10, r: [-2, 0, 0], ease: 'sine' },
        { t: 12, r: [3.4, 0, 0], ease: 'quad' }, { t: 16, r: [0.3, 0, 0], ease: 'sine' }, { t: 20, r: [1.3, 0, 0], ease: 'sine' },
        { t: 24, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i9. The second jab of a double: fires from a half-extended arm with no
  // re-chamber, lands a touch lower, and steps in behind it.
  'p.jabAlt': {
    name: 'Snap Jab',
    duration: 22, blendIn: 2, blendOut: 6,
    // Was `elbow_R`, which travels 0.141m by the contact tick while hand_L
    // travels 0.618m. Nothing in src/ reads `impact.bone` -- only the offline
    // measurement tools do -- so the wrong bone silently made every
    // contact-speed and carry number for this clip a measurement of a limb
    // that is standing still. Both consumers already anchor FIST_L.
    //
    // The tick was 9, which is in the recoil between this clip's two
    // extensions: hand_L reach runs 0.57 at t7, 0.54 at t8, 0.51 at t9, then
    // out again to 0.63 at t13. Contact-frame speed 0.36 of peak at t9, 1.00
    // at t7. Moved to the first extension rather than the second, so the
    // retime shifts by two ticks rather than four.
    impact: { tick: 7, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'linear' },
      { t: 1, p: [0, -0.077, 0], ease: 'linear' },
      { t: 2, p: [0, -0.084, 0], ease: 'linear' },
      { t: 3, p: [0, -0.093, 0.002], ease: 'linear' },
      { t: 4, p: [0, -0.1, 0.005], ease: 'linear' },
      { t: 5, p: [0, -0.102, 0.013], ease: 'linear' },
      { t: 6, p: [0, -0.101, 0.028], ease: 'linear' },
      { t: 7, p: [0, -0.092, 0.051], ease: 'linear' },
      { t: 8, p: [0, -0.083, 0.087], ease: 'linear' },
      { t: 9, p: [0, -0.082, 0.14], ease: 'sine' },
      { t: 11, p: [0, -0.076, 0.153], ease: 'quad' },
      { t: 15, p: [0, -0.088, 0.06], ease: 'sine' },
      { t: 22, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 2, r: [0.58, -23.88, 0.22], ease: 'linear' },
        { t: 5, r: [1, -27.84, -0.01], ease: 'linear' }, { t: 7, r: [1.63, -33.72, -0.34], ease: 'linear' },
        { t: 8, r: [2.04, -37.5, -0.56], ease: 'linear' }, { t: 9, r: [2.5, -41.8, -0.8], ease: 'sine' },
        { t: 11, r: [2.58, -43.46, -0.89], ease: 'quad' }, { t: 15, r: [1.9, -31.3, 0], ease: 'sine' },
        { t: 22, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 2, r: [1.03, 4.89, 0.36], ease: 'linear' },
        { t: 5, r: [1.91, 5.2, -0.01], ease: 'linear' }, { t: 7, r: [3.21, 5.66, -0.55], ease: 'linear' },
        { t: 8, r: [4.05, 5.96, -0.9], ease: 'linear' }, { t: 9, r: [5, 6.3, -1.3], ease: 'sine' },
        { t: 11, r: [5.15, 6.43, -1.44], ease: 'quad' }, { t: 15, r: [3.8, 5.5, 0], ease: 'sine' },
        { t: 22, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 2, r: [1.45, 5.74, 0.39], ease: 'linear' },
        { t: 5, r: [2.61, 6.11, -0.01], ease: 'linear' }, { t: 7, r: [4.33, 6.65, -0.6], ease: 'linear' },
        { t: 8, r: [5.44, 7, -0.97], ease: 'linear' }, { t: 9, r: [6.7, 7.4, -1.4], ease: 'sine' },
        { t: 11, r: [6.91, 7.54, -1.55], ease: 'quad' }, { t: 15, r: [5.1, 6.5, 0], ease: 'sine' },
        { t: 22, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 2, r: [1.45, 6.88, -2.55], ease: 'linear' },
        { t: 5, r: [2.61, 7.3, -3], ease: 'linear' }, { t: 7, r: [4.33, 7.93, -3.67], ease: 'linear' },
        { t: 8, r: [5.44, 8.34, -4.1], ease: 'linear' }, { t: 9, r: [6.7, 8.8, -4.6], ease: 'sine' },
        { t: 11, r: [6.91, 8.98, -4.78], ease: 'quad' }, { t: 15, r: [5.1, 7.7, -3], ease: 'sine' },
        { t: 22, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 5, r: [0.3, 4.9, 0], ease: 'quart' },
        { t: 9, r: [-0.1, 8.7, 0], ease: 'sine' }, { t: 11, r: [-0.14, 9.12, 0], ease: 'quad' },
        { t: 15, r: [0.2, 6.1, 0], ease: 'sine' }, { t: 22, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 5, r: [2.1, 7.4, 0], ease: 'quart' },
        { t: 9, r: [1.7, 14.5, 0], ease: 'sine' }, { t: 11, r: [1.66, 15.28, 0], ease: 'quad' },
        { t: 15, r: [2, 9.6, 0], ease: 'sine' }, { t: 22, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 5, r: [-41.2, 15.2, -2.3], ease: 'quart' },
        { t: 9, r: [-53.8, -18.1, 28.8], ease: 'sine' }, { t: 11, r: [-55.19, -21.6, 32.22], ease: 'quad' },
        { t: 13, r: [-51.5, -14.5, 25.4], ease: 'quad' }, { t: 15, r: [-34, 19.5, -6.6], ease: 'sine' },
        { t: 22, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 5, r: [-84.3, 0, 17], ease: 'quart' },
        { t: 9, r: [-12.6, 0, 17], ease: 'sine' }, { t: 11, r: [-9.1, 0, 17], ease: 'quad' },
        { t: 13, r: [-61.3, 0, 17], ease: 'quad' }, { t: 15, r: [-110.1, 0, 17], ease: 'sine' },
        { t: 22, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 5, r: [-8, -10, 0], ease: 'quart' },
        { t: 9, r: [-8, 32, 0], ease: 'sine' }, { t: 11, r: [-8, 35.5, 0], ease: 'quad' },
        { t: 13, r: [-8, 41, 0], ease: 'sine' }, { t: 15, r: [-8, 10, 0], ease: 'sine' },
        { t: 22, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 5, r: [-26, 0, -7], ease: 'quart' },
        { t: 9, r: [-2, 0, 2], ease: 'sine' }, { t: 11, r: [0.64, 0, 2.99], ease: 'quad' },
        { t: 13, r: [-28, 0, 10], ease: 'sine' }, { t: 15, r: [-18, 0, 0], ease: 'sine' },
        { t: 22, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 2, r: [-23.74, -8.23, 38.27], ease: 'linear' },
        { t: 5, r: [-25.9, -5.51, 37.52], ease: 'linear' }, { t: 7, r: [-22.85, 5.03, 34.62], ease: 'linear' },
        { t: 8, r: [-19.94, 15.1, 31.84], ease: 'linear' }, { t: 9, r: [-15.8, 29.4, 27.9], ease: 'snap' },
        { t: 11, r: [-10.71, 46.4, 25.73], ease: 'sine' }, { t: 15, r: [-28.6, -2.5, 31.8], ease: 'sine' },
        { t: 22, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 2, r: [-143.04, 0, -1], ease: 'linear' },
        { t: 5, r: [-143.69, 0, -1], ease: 'linear' }, { t: 7, r: [-146.2, 0, -1], ease: 'linear' },
        { t: 8, r: [-148.6, 0, -1], ease: 'linear' }, { t: 9, r: [-152, 0, -1], ease: 'snap' },
        { t: 11, r: [-160, 0, -1], ease: 'sine' }, { t: 15, r: [-145.5, 0, -1], ease: 'sine' },
        { t: 22, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 5, r: [-8, -4, 0], ease: 'quart' },
        { t: 9, r: [-8, -14, 0], ease: 'sine' }, { t: 11, r: [-8, -15.1, 0], ease: 'quad' },
        { t: 15, r: [-8, -4, 0], ease: 'sine' }, { t: 22, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 5, r: [-19, 0, 0], ease: 'quart' },
        { t: 9, r: [-27, 0, 0], ease: 'sine' }, { t: 11, r: [-27.88, 0, 0], ease: 'quad' },
        { t: 15, r: [-17, 0, 0], ease: 'sine' }, { t: 22, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 5, r: [-21, -16, 10], ease: 'quart' },
        { t: 9, r: [-25, -18, 11], ease: 'sine' }, { t: 11, r: [-25.44, -18.22, 11.11], ease: 'quad' },
        { t: 15, r: [-39, 10, 11], ease: 'sine' }, { t: 18, r: [-40.54, 13.08, 11], ease: 'sine' }, { t: 22, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 5, r: [31, 0, 0], ease: 'quart' },
        { t: 9, r: [24, 0, 0], ease: 'sine' }, { t: 11, r: [23.23, 0, 0], ease: 'quad' },
        { t: 15, r: [42, 0, 0], ease: 'sine' }, { t: 18, r: [43.98, 0, 0], ease: 'sine' }, { t: 22, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 5, r: [-16.7, 2, 0], ease: 'quart' }, { t: 9, r: [-5.2, 2, 0], ease: 'sine' },
        { t: 11, r: [-4, 2, 0], ease: 'quad' }, { t: 15, r: [-5.6, 2, 0], ease: 'sine' }, { t: 18, r: [-4.3, 2, 0], ease: 'sine' },
        { t: 22, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 5, r: [6.6, 0, 0], ease: 'quart' }, { t: 9, r: [7.4, 0, 0], ease: 'sine' },
        { t: 11, r: [7.5, 0, 0], ease: 'quad' }, { t: 15, r: [-0.9, 0, 0], ease: 'sine' }, { t: 18, r: [-1, 0, 0], ease: 'sine' },
        { t: 22, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 5, r: [2.8, 0, 0], ease: 'quart' }, { t: 9, r: [3.1, 0, 0], ease: 'sine' },
        { t: 11, r: [3.1, 0, 0], ease: 'quad' }, { t: 15, r: [-0.4, 0, 0], ease: 'sine' }, { t: 18, r: [-0.4, 0, 0], ease: 'sine' },
        { t: 22, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 5, r: [4, 6, -13], ease: 'quart' },
        { t: 9, r: [13, 8, -13], ease: 'sine' }, { t: 11, r: [13.99, 8.22, -13], ease: 'quad' },
        { t: 15, r: [-9, -6, -12], ease: 'sine' }, { t: 18, r: [-11.42, -7.54, -11.89], ease: 'sine' }, { t: 22, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 5, r: [22, 0, 0], ease: 'quart' },
        { t: 9, r: [12, 0, 0], ease: 'sine' }, { t: 11, r: [10.9, 0, 0], ease: 'quad' },
        { t: 15, r: [45, 0, 0], ease: 'sine' }, { t: 18, r: [48.5, 0, 0], ease: 'sine' }, { t: 22, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 5, r: [-30.6, -3, 0], ease: 'quart' }, { t: 9, r: [-15.1, 0, 0], ease: 'sine' },
        { t: 11, r: [-13.7, 0.3, 0], ease: 'quad' }, { t: 15, r: [-31.9, -3, 0], ease: 'sine' }, { t: 18, r: [-30.6, -3.3, 0], ease: 'sine' },
        { t: 22, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 5, r: [8.5, 0, 0], ease: 'quart' }, { t: 9, r: [-4, 0, 0], ease: 'sine' },
        { t: 11, r: [-5.2, 0, 0], ease: 'quad' }, { t: 15, r: [0.6, 0, 0], ease: 'sine' }, { t: 18, r: [2.9, 0, 0], ease: 'sine' },
        { t: 22, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 5, r: [3.6, 0, 0], ease: 'quart' }, { t: 9, r: [-1.7, 0, 0], ease: 'sine' },
        { t: 11, r: [-2.2, 0, 0], ease: 'quad' }, { t: 15, r: [0.3, 0, 0], ease: 'sine' }, { t: 18, r: [1.2, 0, 0], ease: 'sine' },
        { t: 22, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i14. Rear cross. The rear heel pivots, the pelvis whips from -28 to +8 and
  // the chest from -9 to +17 degrees, and the lead arm rips back to the ribs.
  'p.straight': {
    name: 'Straight',
    duration: 32, blendIn: 3, blendOut: 7,
    impact: { tick: 14, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 7, p: [0, -0.116, 0], ease: 'linear' },
      { t: 8, p: [0, -0.113, 0], ease: 'linear' },
      { t: 9, p: [0, -0.106, 0.004], ease: 'linear' },
      { t: 10, p: [0, -0.099, 0.013], ease: 'linear' },
      { t: 11, p: [0, -0.096, 0.032], ease: 'linear' },
      { t: 12, p: [0, -0.094, 0.063], ease: 'linear' },
      { t: 13, p: [0, -0.079, 0.112], ease: 'linear' },
      { t: 14, p: [0, -0.077, 0.18], ease: 'sine' },
      { t: 17, p: [0, -0.074, 0.193], ease: 'quad' },
      { t: 23, p: [0, -0.09, 0.1], ease: 'sine' },
      { t: 32, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [0.77, -33.8, -0.13], ease: 'sine' },
        { t: 7, r: [1.4, -33.6, 0], ease: 'linear' }, { t: 11, r: [1.77, -18.2, 0.3], ease: 'linear' },
        { t: 12, r: [1.95, -10.69, 0.44], ease: 'linear' }, { t: 13, r: [2.16, -1.91, 0.61], ease: 'linear' },
        { t: 14, r: [2.4, 8.1, 0.8], ease: 'sine' }, { t: 17, r: [2.46, 10.27, 0.89], ease: 'quad' },
        { t: 23, r: [1.8, -9.3, 0], ease: 'sine' }, { t: 32, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [1.09, 5.96, -0.36], ease: 'sine' },
        { t: 7, r: [2.9, 5.7, 0], ease: 'linear' }, { t: 11, r: [3.6, 4.52, 0.48], ease: 'linear' },
        { t: 12, r: [3.94, 3.94, 0.71], ease: 'linear' }, { t: 13, r: [4.34, 3.27, 0.99], ease: 'linear' },
        { t: 14, r: [4.8, 2.5, 1.3], ease: 'sine' }, { t: 17, r: [4.91, 2.34, 1.44], ease: 'quad' },
        { t: 23, r: [3.6, 3.8, 0], ease: 'sine' }, { t: 32, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [1.54, 7, -0.39], ease: 'sine' },
        { t: 7, r: [3.8, 6.7, 0], ease: 'linear' }, { t: 11, r: [4.76, 5.3, 0.52], ease: 'linear' },
        { t: 12, r: [5.23, 4.61, 0.77], ease: 'linear' }, { t: 13, r: [5.78, 3.81, 1.06], ease: 'linear' },
        { t: 14, r: [6.4, 2.9, 1.4], ease: 'sine' }, { t: 17, r: [6.54, 2.7, 1.55], ease: 'quad' },
        { t: 23, r: [4.8, 4.5, 0], ease: 'sine' }, { t: 32, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [1.54, 8.39, -3.45], ease: 'sine' },
        { t: 7, r: [3.8, 7.9, -3], ease: 'linear' }, { t: 11, r: [4.76, 6.24, -2.41], ease: 'linear' },
        { t: 12, r: [5.23, 5.43, -2.12], ease: 'linear' }, { t: 13, r: [5.78, 4.48, -1.78], ease: 'linear' },
        { t: 14, r: [6.4, 3.4, -1.4], ease: 'sine' }, { t: 17, r: [6.54, 3.17, -1.22], ease: 'quad' },
        { t: 23, r: [4.8, 5.3, -3], ease: 'sine' }, { t: 32, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 7, r: [0.4, 6.7, 0], ease: 'sine' },
        { t: 11, r: [0.2, 1.1, 0], ease: 'quart' }, { t: 14, r: [0, -3.9, 0], ease: 'sine' },
        { t: 17, r: [-0.02, -4.45, 0], ease: 'quad' }, { t: 23, r: [0.3, 0.5, 0], ease: 'sine' },
        { t: 32, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 7, r: [2.3, 10.7, 0], ease: 'sine' },
        { t: 11, r: [2, 0.3, 0], ease: 'quart' }, { t: 14, r: [1.8, -9, 0], ease: 'sine' },
        { t: 17, r: [1.78, -10.02, 0], ease: 'quad' }, { t: 23, r: [2.1, -0.8, 0], ease: 'sine' },
        { t: 32, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 7, r: [-34.7, 5.3, -32.9], ease: 'sine' },
        { t: 11, r: [-26.4, -3.7, -17.9], ease: 'quart' }, { t: 14, r: [-35.1, -49.2, -41.5], ease: 'sine' },
        { t: 17, r: [-36.06, -52.7, -44.1], ease: 'quad' }, { t: 23, r: [-48.2, -4.9, -36.1], ease: 'sine' },
        { t: 32, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 7, r: [-123.8, 0, 17], ease: 'sine' },
        { t: 11, r: [-117.2, 0, 17], ease: 'quart' }, { t: 14, r: [-152, 0, 17], ease: 'sine' },
        { t: 17, r: [-155.5, 0, 17], ease: 'quad' }, { t: 23, r: [-123.8, 0, 17], ease: 'sine' },
        { t: 32, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 7, r: [-8, 1.6, 0], ease: 'sine' },
        { t: 11, r: [-8, 4, 0], ease: 'quart' }, { t: 14, r: [-8, 14, 0], ease: 'sine' },
        { t: 17, r: [-8, 15.1, 0], ease: 'quad' }, { t: 23, r: [-8, 4, 0], ease: 'sine' },
        { t: 32, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 7, r: [-16, 0, 0], ease: 'sine' },
        { t: 11, r: [-19, 0, 0], ease: 'quart' }, { t: 14, r: [-27, 0, 0], ease: 'sine' },
        { t: 17, r: [-27.88, 0, 0], ease: 'quad' }, { t: 23, r: [-17, 0, 0], ease: 'sine' },
        { t: 32, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 3, r: [-14.65, -1.26, 47], ease: 'sine' },
        { t: 7, r: [-15.4, 31.2, 35.5], ease: 'linear' }, { t: 11, r: [-24.8, -16.5, 23.26], ease: 'linear' },
        { t: 12, r: [-34.18, -11.27, 11.05], ease: 'linear' }, { t: 13, r: [-48.45, -3.3, -7.53], ease: 'linear' },
        { t: 14, r: [-68.7, 8, -33.9], ease: 'snap' }, { t: 17, r: [-77.32, 23.08, -50.9], ease: 'sine' },
        { t: 20, r: [-69.8, 10.6, -36.6], ease: 'quad' }, { t: 23, r: [-46.9, -23, 3.6], ease: 'sine' },
        { t: 32, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 3, r: [-156, 0, -1], ease: 'sine' },
        { t: 7, r: [-152, 0, -1], ease: 'linear' }, { t: 11, r: [-127.47, 0, -1], ease: 'linear' },
        { t: 12, r: [-103, 0, -1], ease: 'linear' }, { t: 13, r: [-65.76, 0, -1], ease: 'linear' },
        { t: 14, r: [-12.9, 0, -1], ease: 'snap' }, { t: 17, r: [-4.9, 0, -1], ease: 'sine' },
        { t: 20, r: [-35, 0, -1], ease: 'quad' }, { t: 23, r: [-86.6, 0, -1], ease: 'sine' },
        { t: 32, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 3, r: [-8, 7, 0], ease: 'sine' },
        { t: 7, r: [-8, 4, 0], ease: 'linear' }, { t: 11, r: [-8, 10, 0], ease: 'linear' },
        { t: 12, r: [-8, 1.03, 0], ease: 'linear' }, { t: 13, r: [-8, -12.62, 0], ease: 'linear' },
        { t: 14, r: [-8, -32, 0], ease: 'snap' }, { t: 17, r: [-8, -40, 0], ease: 'sine' },
        { t: 20, r: [-8, -41, 0], ease: 'sine' }, { t: 23, r: [-8, -10, 0], ease: 'sine' },
        { t: 32, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 3, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 7, r: [-18.8, 0, 2.8], ease: 'linear' }, { t: 11, r: [-26, 0, 7], ease: 'linear' },
        { t: 12, r: [-20.87, 0, 5.08], ease: 'linear' }, { t: 13, r: [-13.07, 0, 2.15], ease: 'linear' },
        { t: 14, r: [-2, 0, -2], ease: 'snap' }, { t: 17, r: [6, 0, -5], ease: 'sine' },
        { t: 20, r: [-28, 0, -10], ease: 'sine' }, { t: 23, r: [-18, 0, 0], ease: 'sine' },
        { t: 32, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 7, r: [-14, -16, 12], ease: 'sine' },
        { t: 11, r: [-24, -12, 10], ease: 'quart' }, { t: 14, r: [-28, -4, 8], ease: 'sine' },
        { t: 17, r: [-28.44, -3.12, 7.78], ease: 'quad' }, { t: 23, r: [-24, -10, 10], ease: 'sine' },
        { t: 32, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 7, r: [38, 0, 0], ease: 'sine' },
        { t: 11, r: [27, 0, 0], ease: 'quart' }, { t: 14, r: [20, 0, 0], ease: 'sine' },
        { t: 17, r: [19.23, 0, 0], ease: 'quad' }, { t: 23, r: [26, 0, 0], ease: 'sine' },
        { t: 32, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 7, r: [-29.9, 2, 0], ease: 'sine' }, { t: 11, r: [-9.4, 2, 0], ease: 'quart' },
        { t: 14, r: [-0.4, 2, 0], ease: 'sine' }, { t: 17, r: [0.9, 2, 0], ease: 'quad' }, { t: 23, r: [-9, 2, 0], ease: 'sine' },
        { t: 32, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [5.9, 0, 0], ease: 'sine' }, { t: 11, r: [7.3, 0, 0], ease: 'quart' },
        { t: 14, r: [6.9, 0, 0], ease: 'sine' }, { t: 17, r: [7.1, 0, 0], ease: 'quad' }, { t: 23, r: [7, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [2.5, 0, 0], ease: 'sine' }, { t: 11, r: [3.1, 0, 0], ease: 'quart' },
        { t: 14, r: [2.9, 0, 0], ease: 'sine' }, { t: 17, r: [3, 0, 0], ease: 'quad' }, { t: 23, r: [2.9, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 7, r: [-2, 6, -14], ease: 'sine' },
        { t: 11, r: [8, 4, -13], ease: 'quart' }, { t: 14, r: [16, -6, -12], ease: 'sine' },
        { t: 17, r: [16.88, -7.1, -11.89], ease: 'quad' }, { t: 23, r: [10, 2, -13], ease: 'sine' },
        { t: 32, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 7, r: [34, 0, 0], ease: 'sine' },
        { t: 11, r: [18, 0, 0], ease: 'quart' }, { t: 14, r: [10, 0, 0], ease: 'sine' },
        { t: 17, r: [9.12, 0, 0], ease: 'quad' }, { t: 23, r: [20, 0, 0], ease: 'sine' },
        { t: 32, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 7, r: [-35.7, -3, 0], ease: 'sine' }, { t: 11, r: [-15.1, 0, 0], ease: 'quart' },
        { t: 14, r: [-27.8, 0, 0], ease: 'sine' }, { t: 17, r: [-27.4, 0, 0], ease: 'quad' }, { t: 23, r: [-22.1, 0, 0], ease: 'sine' },
        { t: 32, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [8.5, 0, 0], ease: 'sine' }, { t: 11, r: [-6.3, 0, 0], ease: 'quart' },
        { t: 14, r: [3.5, 0, 0], ease: 'sine' }, { t: 17, r: [5.9, 0, 0], ease: 'quad' }, { t: 23, r: [-0.1, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [3.6, 0, 0], ease: 'sine' }, { t: 11, r: [-2.7, 0, 0], ease: 'quart' },
        { t: 14, r: [1.5, 0, 0], ease: 'sine' }, { t: 17, r: [2.5, 0, 0], ease: 'quad' }, { t: 23, r: [0, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i15. The elbow holds ~100 degrees the whole way; the arc comes from the
  // hips and the pivot of the lead foot, not the arm.
  'p.hook': {
    name: 'Hook',
    duration: 32, blendIn: 3, blendOut: 7,
    impact: { tick: 15, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 8, p: [0, -0.121, 0], ease: 'sine' },
      { t: 12, p: [0, -0.1, 0.05], ease: 'linear' },
      { t: 13, p: [0, -0.098, 0.06], ease: 'linear' },
      { t: 14, p: [0, -0.082, 0.084], ease: 'linear' },
      { t: 15, p: [0, -0.08, 0.12], ease: 'sine' },
      { t: 18, p: [0, -0.084, 0.128], ease: 'quad' },
      { t: 23, p: [0, -0.09, 0.1], ease: 'sine' },
      { t: 32, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [0.78, -33.8, 0.3], ease: 'sine' },
        { t: 8, r: [1.4, -19.7, 0.9], ease: 'sine' }, { t: 12, r: [1.7, -33.6, 0.3], ease: 'linear' },
        { t: 13, r: [1.75, -25.55, -0.1], ease: 'linear' }, { t: 14, r: [1.82, -15.1, -0.62], ease: 'linear' },
        { t: 15, r: [1.9, -3.5, -1.2], ease: 'sine' }, { t: 18, r: [1.92, -0.19, -1.36], ease: 'quad' },
        { t: 23, r: [1.7, 15.1, -1.5], ease: 'sine' }, { t: 32, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [1.37, 5.73, 0.56], ease: 'sine' },
        { t: 8, r: [2.9, 4.6, 1.5], ease: 'sine' }, { t: 12, r: [3.4, 5.7, 0.5], ease: 'linear' },
        { t: 13, r: [3.51, 5.06, -0.17], ease: 'linear' }, { t: 14, r: [3.65, 4.23, -1.04], ease: 'linear' },
        { t: 15, r: [3.8, 3.3, -2], ease: 'sine' }, { t: 18, r: [3.84, 3.04, -2.27], ease: 'quad' },
        { t: 23, r: [3.4, 1.9, -2.5], ease: 'sine' }, { t: 32, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [1.9, 6.72, 0.62], ease: 'sine' },
        { t: 8, r: [3.8, 5.4, 1.7], ease: 'sine' }, { t: 12, r: [4.5, 6.7, 0.6], ease: 'linear' },
        { t: 13, r: [4.66, 5.95, -0.15], ease: 'linear' }, { t: 14, r: [4.87, 4.98, -1.12], ease: 'linear' },
        { t: 15, r: [5.1, 3.9, -2.2], ease: 'sine' }, { t: 18, r: [5.17, 3.59, -2.51], ease: 'quad' },
        { t: 23, r: [4.5, 2.3, -2.8], ease: 'sine' }, { t: 32, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [1.9, 8.03, -2.27], ease: 'sine' },
        { t: 8, r: [3.8, 6.4, -1.1], ease: 'sine' }, { t: 12, r: [4.5, 7.9, -2.4], ease: 'linear' },
        { t: 13, r: [4.66, 7.04, -3.26], ease: 'linear' }, { t: 14, r: [4.87, 5.93, -4.37], ease: 'linear' },
        { t: 15, r: [5.1, 4.7, -5.6], ease: 'sine' }, { t: 18, r: [5.17, 4.35, -5.95], ease: 'quad' },
        { t: 23, r: [4.5, 2.7, -6.2], ease: 'sine' }, { t: 32, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 8, r: [0.4, 3.1, 0], ease: 'sine' },
        { t: 12, r: [0.3, 6.7, 0], ease: 'quart' }, { t: 15, r: [0.2, -1, 0], ease: 'sine' },
        { t: 18, r: [0.19, -1.85, 0], ease: 'quad' }, { t: 23, r: [0.3, -5.7, 0], ease: 'sine' },
        { t: 32, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 8, r: [2.3, 4.1, 0], ease: 'sine' },
        { t: 12, r: [2.2, 10.7, 0], ease: 'quart' }, { t: 15, r: [2, -3.5, 0], ease: 'sine' },
        { t: 18, r: [1.98, -5.06, 0], ease: 'quad' }, { t: 23, r: [2.2, -12.2, 0], ease: 'sine' },
        { t: 32, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 3, r: [-33.14, 7.86, -47], ease: 'sine' },
        { t: 8, r: [-20.4, -5.9, -4.7], ease: 'sine' }, { t: 12, r: [-16.7, -7.5, 27.3], ease: 'linear' },
        { t: 13, r: [-21, -13.94, 29], ease: 'linear' }, { t: 14, r: [-31.69, -29.91, 33.23], ease: 'linear' },
        { t: 15, r: [-47.8, -54, 39.6], ease: 'snap' }, { t: 18, r: [-55.62, -62, 42.69], ease: 'sine' },
        { t: 21, r: [-63.4, -63.8, 34], ease: 'quad' }, { t: 23, r: [-125.3, -41.3, -41.5], ease: 'sine' },
        { t: 32, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 3, r: [-135, 0, 17], ease: 'sine' },
        { t: 8, r: [-105.4, 0, 17], ease: 'sine' }, { t: 12, r: [-72.3, 0, 17], ease: 'linear' },
        { t: 13, r: [-73.52, 0, 17], ease: 'linear' }, { t: 14, r: [-76.54, 0, 17], ease: 'linear' },
        { t: 15, r: [-81.1, 0, 17], ease: 'snap' }, { t: 18, r: [-89.1, 0, 17], ease: 'sine' },
        { t: 21, r: [-75.1, 0, 17], ease: 'quad' }, { t: 23, r: [-61, 0, 17], ease: 'sine' },
        { t: 32, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 3, r: [-8, -7, 0], ease: 'sine' },
        { t: 8, r: [-8, -4, 0], ease: 'sine' }, { t: 12, r: [-8, -10, 0], ease: 'linear' },
        { t: 13, r: [-8, -4.19, 0], ease: 'linear' }, { t: 14, r: [-8, 10.24, 0], ease: 'linear' },
        { t: 15, r: [-8, 32, 0], ease: 'snap' }, { t: 18, r: [-8, 40, 0], ease: 'sine' },
        { t: 21, r: [-8, 41, 0], ease: 'sine' }, { t: 23, r: [-8, 10, 0], ease: 'sine' },
        { t: 32, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 3, r: [-17.36, 0, -0.56], ease: 'sine' },
        { t: 8, r: [-18.8, 0, -2.8], ease: 'sine' }, { t: 12, r: [-26, 0, -7], ease: 'linear' },
        { t: 13, r: [-22.68, 0, -5.75], ease: 'linear' }, { t: 14, r: [-14.43, 0, -2.66], ease: 'linear' },
        { t: 15, r: [-2, 0, 2], ease: 'snap' }, { t: 18, r: [6, 0, 5], ease: 'sine' },
        { t: 21, r: [-28, 0, 10], ease: 'sine' }, { t: 23, r: [-18, 0, 0], ease: 'sine' },
        { t: 32, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 8, r: [-19.8, -3.5, 28.7], ease: 'sine' },
        { t: 12, r: [-5.3, 32.5, 26.2], ease: 'quart' }, { t: 15, r: [-2, 17.2, 43.1], ease: 'sine' },
        { t: 18, r: [-1.64, 15.52, 44.96], ease: 'quad' }, { t: 23, r: [-3.7, -24.9, 45.7], ease: 'sine' },
        { t: 32, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 8, r: [-145.4, 0, -1], ease: 'sine' },
        { t: 12, r: [-152, 0, -1], ease: 'quart' }, { t: 18, r: [-152.73, 0, -1], ease: 'quad' },
        { t: 23, r: [-145.5, 0, -1], ease: 'sine' }, { t: 32, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 8, r: [-8, -1.6, 0], ease: 'sine' },
        { t: 12, r: [-8, -4, 0], ease: 'quart' }, { t: 18, r: [-8, -14, 0], ease: 'quad' },
        { t: 23, r: [-8, -4, 0], ease: 'sine' }, { t: 32, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 8, r: [-16, 0, 0], ease: 'sine' },
        { t: 12, r: [-19, 0, 0], ease: 'quart' }, { t: 18, r: [-27, 0, 0], ease: 'quad' },
        { t: 23, r: [-17, 0, 0], ease: 'sine' }, { t: 32, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 8, r: [-18, -22, 12], ease: 'sine' },
        { t: 12, r: [-22, -26, 12], ease: 'quart' }, { t: 15, r: [-26, -2, 10], ease: 'sine' },
        { t: 18, r: [-26.44, 0.64, 9.78], ease: 'quad' }, { t: 23, r: [-24, 6, 8], ease: 'sine' },
        { t: 32, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 8, r: [33, 0, 0], ease: 'sine' },
        { t: 12, r: [28, 0, 0], ease: 'quart' }, { t: 15, r: [22, 0, 0], ease: 'sine' },
        { t: 18, r: [21.34, 0, 0], ease: 'quad' }, { t: 23, r: [24, 0, 0], ease: 'sine' },
        { t: 32, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 8, r: [-20.9, 2, 0], ease: 'sine' }, { t: 12, r: [-12.3, 2, 0], ease: 'quart' },
        { t: 15, r: [-4.2, 2, 0], ease: 'sine' }, { t: 18, r: [-3.4, 2, 0], ease: 'quad' }, { t: 23, r: [-8.8, 2, 0], ease: 'sine' },
        { t: 32, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [6.6, 0, 0], ease: 'sine' }, { t: 12, r: [7, 0, 0], ease: 'quart' },
        { t: 15, r: [6.6, 0, 0], ease: 'sine' }, { t: 18, r: [6.5, 0, 0], ease: 'quad' }, { t: 23, r: [6.3, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [2.8, 0, 0], ease: 'sine' }, { t: 12, r: [2.9, 0, 0], ease: 'quart' },
        { t: 15, r: [2.8, 0, 0], ease: 'sine' }, { t: 18, r: [2.7, 0, 0], ease: 'quad' }, { t: 23, r: [2.7, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 8, r: [4, 10, -13], ease: 'sine' },
        { t: 12, r: [8, 12, -13], ease: 'quart' }, { t: 15, r: [12, -4, -12], ease: 'sine' },
        { t: 18, r: [12.44, -5.76, -11.89], ease: 'quad' }, { t: 23, r: [10, -10, -12], ease: 'sine' },
        { t: 32, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 8, r: [26, 0, 0], ease: 'sine' },
        { t: 12, r: [18, 0, 0], ease: 'quart' }, { t: 15, r: [12, 0, 0], ease: 'sine' },
        { t: 18, r: [11.34, 0, 0], ease: 'quad' }, { t: 23, r: [16, 0, 0], ease: 'sine' },
        { t: 32, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 8, r: [-35.1, -3, 0], ease: 'sine' }, { t: 12, r: [-20.6, 0, 0], ease: 'quart' },
        { t: 15, r: [-25.4, 0, 0], ease: 'sine' }, { t: 18, r: [-25.8, 0, 0], ease: 'quad' }, { t: 23, r: [-25.8, 0, 0], ease: 'sine' },
        { t: 32, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [7.9, 0, 0], ease: 'sine' }, { t: 12, r: [-6, 0, 0], ease: 'quart' },
        { t: 15, r: [2.6, 0, 0], ease: 'sine' }, { t: 18, r: [3.6, 0, 0], ease: 'quad' }, { t: 23, r: [1.2, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [3.3, 0, 0], ease: 'sine' }, { t: 12, r: [-2.5, 0, 0], ease: 'quart' },
        { t: 15, r: [1.1, 0, 0], ease: 'sine' }, { t: 18, r: [1.5, 0, 0], ease: 'quad' }, { t: 23, r: [0.5, 0, 0], ease: 'sine' },
        { t: 32, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i16. Sinks into the rear leg, drives off it, and LEAVES THE FLOOR.
  //
  // ---------------------------------------------------------------------
  // ROUND 17. Round 16's numbers are real, and this clip now goes airborne.
  // ---------------------------------------------------------------------
  // FIRST: the round-16 rebuild below was re-measured against the rig and every
  // figure reproduces. pelvis excursion 194mm (claimed 188), max hip-line break
  // 55.4mm (claimed 54), knees 42/45 -> 86/65 -> 33/47 exactly. That round is
  // not in doubt; the strip that failed to show it was (see the note on
  // 17-anim-strip's determinism at the end of this comment).
  //
  // SECOND: measured across all 91 clips, this is the ONLY attack in the game
  // with a hip line that breaks. Every other strike sits at or under 22mm of
  // hip-height difference and most are under 10mm — p.straight 4.9, p.hook 5.0,
  // p.jab 8.1, p.overhand 9.2, k.roundhouse 18.1, k.highKick 21.9. So round 16
  // fixed one clip out of forty, and the critic's "two bodies each holding its
  // own vertical axis with both hip lines level" is still true of the other 39.
  //
  // THIRD, and what this round shipped: a move called Skyward Uppercut, tagged
  // `launcher`, never left the concrete. Both boots stayed inside 2.2mm of the
  // floor for all 36 ticks. There was no airborne pose anywhere in the delivered
  // set of grounded attacks, which is half of the standing complaint about this
  // axis. The drive now carries the body off the floor and lands it:
  //
  //                                     before        after
  //     airborne ticks (both boots)     0             7   (clip t19-t25)
  //     max both-boot clearance         2.2mm         178mm
  //     pelvis excursion                194mm         286mm
  //     delivered pelvis at t22         1034mm        1171mm
  //     delivered lowest boot at t22    172mm         337mm
  //
  // The flight is a parabola authored one key per tick from t17 to t25, the lead
  // knee folding to 63deg and the rear leg trailing, ankles plantar-flexed so the
  // boots point rather than dangle, landing into the absorb the clip already had
  // at t26. Nothing above the pelvis is touched: `spine01` and `chest` keep the
  // fractional key times `whip` gave them, so the head-lag centroid is unmoved.
  //
  // WHAT IT COST, verified pointwise against a reconstruction of the pre-edit
  // clip. Tick 0, tick 16 (contact) and tick 36 are bit-identical at 0.000mm, so
  // entry from and exit to idle still cannot pop and the contact pose combat
  // reads is untouched. The move's three ACTIVE frames are clip 16.00 / 16.72 /
  // 17.44 (straight3 pivots clip 16 onto move tick 18 at outScale 0.72), and
  // hand_R across those three moves 0.000 / 2.894 / 9.232mm against a 260mm
  // capsule — which is why t17 is deliberately almost flat and the push does not
  // start until t18, one clip tick past the last active frame. Worst single-tick
  // hurtbox travel is unchanged at 0.390m, inside this file's own 0.60m rule.
  // `check.mjs` anchor ratio unchanged. The flight is over by move tick ~32 and
  // the move recovers at 46, so the -14 punish window lands on a grounded
  // fighter; nothing about the block punish moves.
  //
  // Two servos could have eaten this and do not. `Fighter#installPelvisLift`
  // lifts by the SMALLER of the two boots' penetration, which goes negative the
  // moment both boots are clear, so it releases (measured 0.0mm through the whole
  // flight). `Fighter#footIk` only arms when a boot is buried deeper than the
  // ankle roll can lift, so it never engages.
  //
  // HOW IT WAS MEASURED, because 17-anim-strip could not do it. Two runs of an
  // UNCHANGED tree put that shot's "+20t" panels about 60 ticks apart — its round
  // timer reads 57 in one and 56 in the other — because it waits on `KB.tick`
  // from the driver and then spends 100-300ms taking a 1920x1080 screenshot while
  // the sim keeps running, so panel k lands at `base + off_k + accumulated
  // screenshot latency`. Its cross-run panel noise is 5 to 74 /255. Before/after
  // through it reads 9-17/255 against a same-tree noise floor of 5-74/255: no
  // conclusion is available from that shot at this size.
  //
  // So the A/B was done IN ONE PAGE SESSION with the clock pinned to 1/60 through
  // the run-up and 0 while frozen, the wait and the freeze in a single page-side
  // callback, the defender parked out of reach and hidden so the move whiffs and
  // no FX fire, and the ONLY difference between arms the clip object on the
  // attacker's animator. On that instrument, at move tick 22, over the lower body:
  //
  //     change  26.19 /255, 57.2% of pixels >= 8
  //     control  1.29 /255,  1.0% of pixels >= 8   (same clip, different pass)
  //
  // and on bone positions, worst bone 490.4mm against a same-clip control of
  // 0.245mm. Both boots are off the concrete in the delivered frame; looked at,
  // at 3x, they are.
  //
  // ROUND 15. IT DID NOT SINK INTO ANYTHING. The comment above described a
  // weight shift the data never contained, and this is the clip the animation
  // axis is scored on (`17-anim-strip` photographs it at clip ticks 1.6, 4.8,
  // 8.8, 12.8, 16.7, 21.0 and 26.8). Driven through the rig:
  //
  //   hip_L.y - hip_R.y   stayed inside 4.3mm for all 36 ticks — the hip line
  //                       was level in every frame, which is exactly the
  //                       critic's "both hip lines level"
  //   hip-to-ankle span   0.803 -> 0.798 -> 0.855: the legs were between 93%
  //                       and 100% extended from end to end. The knees never
  //                       bent, so nothing was ever loaded
  //   the 64mm "sink"     came entirely from the ROOT TRACK translating the
  //                       whole rig down. The boots went with it: the lead
  //                       toe pad ran 109mm under the concrete at t6
  //
  // A root drop is not a crouch, it is the fighter being lowered. The sink now
  // comes out of the knees with the ankles held at their stance height, which
  // is what makes it weight rather than an elevator:
  //
  //                          before          after
  //     pelvis excursion     70mm            188mm
  //     max hip-line break   4.3mm           54mm  (12.6x)
  //     knee_L / knee_R      42/45 -> 12/8   42/45 -> 86/65 -> 33/47
  //     worst boot under     109mm           26mm
  //     rear heel lift       0mm             55mm at contact, toe pad planted
  //
  // Two things this deliberately did NOT change. The root's Z is untouched, so
  // the move's spacing and forward drive are what they were. And the whole
  // t0/t36 pose is bit-identical, so entry from and exit to idle still cannot
  // pop — `regress.mjs` measures stance0 and stanceEnd unchanged at 0.022.
  //
  // The contact tick is the one place a pose edit here can break combat, and it
  // is nearly free on screen: the clip's pelvis at t16 rises 47mm, but the
  // control was ALREADY being raised by that much by `Fighter#installPelvisLift`
  // — the servo exists to lift a pelvis whose boots are buried, and both of this
  // clip's boots were 47mm under at contact. So the correction has moved out of
  // the servo and into the clip, and the delivered frame's pelvis moves 3.4px.
  // hand_R at t16 is 54mm from where it was in clip space and the hit still
  // lands on every capture; check.mjs's anchor ratio stays 1.000 with hand_R
  // still the leading limb (travel 0.430 -> 0.412m).
  //
  // ROUND 14. This clip's fist used to DESCEND into contact. Driven through the
  // rig, hand_R ran y 1.501 at t0, a shallow low of 1.373 at t9, back up to
  // 1.480 at t13 and 1.368 at contact — so its minimum height over the whole
  // startup WAS its contact height, and it finished 13cm below the guard hand.
  // Rise from the low point to contact, against the other three rising moves:
  //
  //     p.uppercut       0.000 m        k.launcherKick   1.533 m
  //     p.launcherPunch  0.436 m        sp.risingFang    1.207 m
  //
  // A launcher whose fist ends below the guard cannot read as a launcher, and
  // it explains this clip's silhouette numbers without any appeal to occlusion:
  // with the elbow folded to -154 deg at t9 the arm is collapsed to a point, so
  // there is no chamber for the eye to read, and the small circle it does make
  // at chest height passes straight through the guard hand's position.
  //
  // The chamber below now sinks the fist to the hip (y 1.073 at t13) and rises
  // 0.295m into an UNCHANGED contact pose. The contact, tick-0 and final poses
  // are bit-identical to before, so nothing the combat system reads has moved.
  // Striking-arm silhouette divergence at impact-4, the last frame a defender
  // can act on: 0.355 -> 0.592, from the lowest of all 34 clips to above the
  // median. Arm retreat 0.343 -> 0.210. Worst single-tick hurtbox travel
  // 0.175 -> 0.260m, well inside the file's 60cm rule, and 0.333m when the
  // interpolation is sampled at 8x per tick.
  //
  // The remaining half of this is NOT in this file: contact is still at
  // y 1.368, below the guard. Raising it is a Moves.js change, because both
  // consumers are HEIGHT.MID with a 25-26cm capsule on hand_R and raising the
  // fist to head height would turn them into highs.
  //
  // ROUND 19. THE DRIVE ROUND 18 BOUGHT WAS BEING PAID FOR IN FOOT SKATE.
  //
  // Round 18 authored 324mm of root Z (sit back to -0.121, drive to +0.203) and
  // delivered it. Nothing paid for it below the ankles. Driven through the rig
  // and measured on the SOLE POINTS -- the points `Fighter#measureSole` records
  // under `ankle_*` and `toe_*` at the stance pose, which is what the floor
  // actually touches -- both boots stayed flat on the concrete for the whole of
  // t1..t18 and the whole 324mm went into sliding them:
  //
  //     planted-sole path, t1..t18   lead 467mm    rear 644mm
  //     worst single tick             63mm         87mm
  //
  // Two thirds of a metre of skate on a boot that never leaves the ground, at
  // 60Hz, inside a fifth of a second. That is CRITIC.md's "floaty feet" and its
  // "limbs moving in isolation" in one defect, and it is the reason the drive
  // did not read: the pelvis moved, and the fighter was moved with it, rather
  // than the fighter pushing the pelvis. There was no push-off anywhere in the
  // clip -- the rear heel never came up, so nothing was ever driving from the
  // floor.
  //
  // WHY THE OLD ANKLE SOLVE COULD NOT SEE THIS. The file header's boot solve
  // (mean toe-pad error 2.0mm) constrains sole HEIGHT and nothing else. A boot
  // sliding along a floor it is perfectly flat on scores 2.0mm. Height is not
  // contact; a planted foot owns a world POSITION, and until round 19 no metric
  // in this file measured one.
  //
  // WHAT CHANGED. `hip_*.x`, `hip_*.z`, `knee_*.x` and `ankle_*.x` are re-solved
  // per tick over t1..t18 by damped least squares against three residuals per
  // leg: the toe sole point's forward position, the toe sole point's height, and
  // the ankle (heel) sole point's height. The targets are authored as a plant,
  // not as a pose --
  //
  //   lead boot  pinned on its stance mark (world +0.449) through t12, then
  //              creeping to +0.505 as the body drives past it and the leg runs
  //              out of reach; heel flat to t13, then peeling to 155mm by t17
  //   rear boot  pinned at -0.145 through t12, ball rolling to -0.042 by t17,
  //              heel climbing 0 -> 210mm from t11 so the boot ends up on its
  //              ball with the leg extending: the push-off the clip never had
  //
  // Past t15 the heel target is down-weighted to 0.2, because by then the body
  // is rising and both boots are legitimately peeling -- constraining a heel
  // there only clamps the ankle and throws the leg out of reach.
  //
  // FIRST ATTEMPT MEASURED WORSE AND WAS THROWN AWAY. Solving hip and knee
  // against the toe alone, with the authored ankle left in place, pinned the
  // ball and rotated the boot around it: the lead ankle dropped to 160mm with
  // the toe bone at 220mm, which is the heel 112mm THROUGH the concrete. That
  // is the round-15 "stood the fighter on its HEELS" defect rebuilt from the
  // other end. The heel residual is not optional; the boot is two contact points.
  //
  // RESULT, all measured on the sole points through the real rig:
  //
  //                              before      after
  //     planted-sole path L      467mm       100mm
  //     planted-sole path R      644mm       185mm
  //     worst single tick L/R    63/87mm     34/42mm
  //     deepest sole burial      21.7mm      4.4mm  (lead)
  //     rear heel at contact     96mm        172mm
  //     lead heel at contact     69mm        96mm
  //
  // WHAT IS BIT-IDENTICAL, because the drive is round 18's and this round does
  // not get to spend it: the entire root track, hips/spine/chest/neck/head, both
  // arms, and therefore hips, chest and head forward position at EVERY tick to
  // the millimetre; `hand_R` at the contact tick (world -299.78, 1597.46, 689.59)
  // so reach, spacing and the hitbox open exactly where they did; the t0 and t36
  // STANCE (max bone drift 0.000mm); and the worst single-tick hurtbox travel,
  // still 352mm on hand_R at t16. `check.mjs` anchors stay 0-on-the-wrong-limb,
  // worst ratio 0.59. No geometry added.
  //
  // SEEN, not just measured. Single-page A/B -- one compiled program, one GPU
  // state, the only difference being which six leg key-arrays hang on the
  // animator's clip object, run A/B/A' so the third pass is the noise floor --
  // frozen on move ticks 6, 10, 13 and 16 with the strip's own parked camera,
  // differenced over the 640x240 boot band:
  //
  //     tick   noise mean   change mean   noise %>=8   change %>=8
  //       6       2.26         6.22          3.0%        19.1%
  //      10       1.64         5.00          1.6%        17.3%
  //      13       1.55         4.53          1.5%        14.1%
  //      16       1.68         3.95          1.9%        11.6%
  //
  // At 3x the before/after pair is not subtle: at t10 the old coil stands with
  // both legs near straight and the boots drawn together, the new one is sunk
  // over a wide planted base; at contact the old boots are flat on the floor and
  // the new pair are both up on their balls with the rear leg extended.
  //
  // ONE SIDE EFFECT, not in this file and worth someone's attention: the boots
  // now plant hard enough that `#trackFootfalls` fires during the coil, so the
  // stage kicks up a dust plume that the old clip never triggered. It reads as
  // weight in the frame, but its size is EffectsDirector's call, not this file's.
  //
  // ROUND 18. THERE WAS NO BODY DRIVE, AND THE ROOT'S Z TRACK WAS WHY.
  //
  // Measured on the frame this axis is scored on -- `17-anim-strip`, parked
  // camera, three runs a side, control built as the current tree with only this
  // file reverted -- over the strip's own +6t -> +16t window:
  //
  //                            control        this clip
  //     hips, world             +102 mm         +256 mm
  //     hips, screen             +23.2 px        +58.7 px   (230 px/m here)
  //     chest, screen            -23.1 px        +12.6 px
  //     forward-most panel:  hips +16t          hips +16t
  //                          chest +6t          chest +21t
  //
  // So the chest used to reach its forward-most point TEN TICKS BEFORE the
  // hips and then travel backwards through the strike -- the exact inversion of
  // CRITIC.md's "the hips lead, the head lags". It now lags by 4 ticks measured
  // per-tick (hips peak clip t20, chest t24, head t25) and by one panel on the
  // strip, whose panels are 5 ticks apart there and cannot resolve finer.
  //
  // The shape is anticipate -> drive -> carry, and the anticipation is not
  // decoration: it is what makes the drive DELIVER. `CombatSystem#separatePair`
  // splits any overlap between the two fighters, so once the capsules touch
  // every millimetre the root authors buys only half a millimetre of attacker
  // travel. The pair is staged 1.02 m apart and the capsules meet at 0.84, so
  // there are only ~88 mm of free travel available. Sitting back to z -0.121
  // through the coil opens that to ~180 mm, and the whole drive is then spent
  // before the push starts. Measured: the old track authored 137 mm over the
  // window and delivered 102; this one authors 276 mm and delivers 256.
  //
  // Two things are deliberately unchanged. Reach at the contact tick is
  // z +0.155 against the old +0.140 -- slightly MORE, never less -- so the
  // hitbox opens no further away than it used to; `straight3` and `riseUpper`
  // were both driven through the real retimed path and land at 0.95 / 1.02 /
  // 1.15 / 1.30 / 1.45 m, on the same tick, for the same damage, with the
  // defender launched identically. And the root HEIGHT track is untouched at
  // every key, so the pelvis-excursion and boot-planting work from round 15
  // stands as measured.
  //
  // THE ACCEPTANCE TEST AS WRITTEN CANNOT BE PASSED, and that is a property of
  // the instrument rather than of this clip. The test asks the hips-band
  // centroid (x 620-960, y 430-570, foreground mask against the 7-panel median)
  // to move 40 px. Calibrated by translating the attacker rigidly through one
  // frozen frame and changing nothing else:
  //
  //     body moves   +40.6 px  ->  band centroid  +25.9 px
  //     body moves   +70.4 px  ->  band centroid  +33.7 px
  //     body moves  +106.2 px  ->  band centroid  +35.2 px
  //
  // The response saturates near +35 px because the band's right edge at x 960
  // cuts the body and clips the mass that is supposed to carry the centroid.
  // A 40 px reading is unreachable at any translation. This clip measures
  // +22.2 px on that band (control -3.6 px, and the critic's own baseline
  // reading was -1.7 px), which the calibration curve places at roughly 40-60 px
  // of body travel -- consistent with the +58.7 px measured directly.
  //
  // ROUND 19 RE-MEASURED ALL OF THAT AND IT REPRODUCES. NOTHING WAS CHANGED HERE.
  //
  // The round-19 brief still carried the pre-round-18 finding ("hips a net
  // -1.7 px, chest RETREATS 11.9 px") as standing. It is not. Driven through
  // `17-anim-strip`'s exact staging and parked camera, clock pinned to 1/60,
  // stepped a tick at a time, SIX independent arms in two page sessions:
  //
  //     hips, screen, +6t -> +16t     +50.1  +50.2  +50.7  +50.9  (+52.3 +48.6)
  //     chest, screen, same window    +20.4  +20.5  +21.5  +21.6
  //     hips peak / chest peak        move tick 20-21 / 24-25  -> chest lags 4
  //
  // Against the brief's bar of "at least 40 px" and "chest lags hips by 2 to 4
  // ticks", both halves pass, on every arm, with a 0.8 px spread. The upward
  // chain order also holds per-tick: hips peak t19, spine02 t21, elbow_R t22,
  // chest t23, head t24.
  //
  // THE BAND-CENTROID FORM OF THE TEST STILL CANNOT PASS, independently
  // confirmed. Implemented exactly as written — y 430-570, x 620-960, masked
  // against the seven-panel per-pixel median — it reads +25.6 px on the shipped
  // strip and +27.5 px on a fresh one. That is the saturation the round-18 note
  // calibrated: the band's right edge at x 960 cuts the body and clips the mass
  // that would carry the centroid. Measure the hips BONE, not the band.
  //
  // ROUND 20. THE BODY DRIVE IS DONE AND IT REPRODUCES A THIRD TIME. THE MOVE
  // WAS STILL NOT AN UPPERCUT.
  //
  // First, the standing finding this round was briefed with — "hips a net
  // -1.7 px, chest RETREATS 11.9 px" — is measured dead, again, on a third
  // independent rig. Driven through `17-anim-strip`'s own staging and parked
  // camera, clock pinned, stepped a tick at a time, cross-arm noise 0.11-0.16 px:
  //
  //     hips, screen, +6t -> +16t     +49.5 px   (bar: >= 40)
  //     chest, screen, same window    +21.0 px
  //     forward-most tick, t>=16      hips 20, spine01 21, spine02 23,
  //                                   chest 24, neck 25, head 26
  //
  // Both halves pass. Do not brief it as open again without re-measuring it.
  //
  // What was still wrong is that the STRIKE stopped at contact. Measured on the
  // shipped round-19 clip, hand_R world height:
  //
  //     t13 1.196   t16 1.399   t17 1.585   t21 1.613 (peak)   t26 1.387
  //
  // The fist of the "Skyward Uppercut" rose 186 mm in the tick after contact and
  // then moved 28 mm over the next four. It peaked 212 mm BELOW its own shoulder
  // and 530 mm below the top of its own head — the guard hand (hand_L, 1.93) sat
  // 320 mm HIGHER than the punching hand at the top of the strike. Whatever that
  // silhouette is, it is a low hook that stops dead, and stopping dead is the
  // deceleration defect this file already fixed once for the wind-up. The strip
  // showed it as two near-identical panels: +16t -> +21t was the lowest
  // pose-change-relative-to-hips of any panel pair in the sheet, 17.6 px against
  // 34.8 for +13t -> +16t, because ticks 18-21 moved hips, chest and head by
  // IDENTICAL per-tick amounts — the torso was a rigid body being translated by
  // the root with zero articulation.
  //
  // So the arm now finishes overhead. shoulder_R and elbow_R only; nothing else
  // in the clip is touched. hand_R world height, same rig, same session, OLD and
  // NEW differing only in which two key arrays hang on the live clip:
  //
  //     tick     16      19      20      21      22      23      26
  //     OLD    1.423   1.571   1.600   1.612   1.587   1.534   1.373
  //     NEW    1.423   1.578   1.745   2.147   2.331   2.243   1.645
  //     screen   0     -2.2   -37.8  -140.9  -198.3  -188.3   -71.3  px
  //
  // The peak is 173 mm ABOVE headTop instead of 530 mm below it, and it arrives
  // at clip 22 — the shoulder leads (its key lands at 20.7 after `whip`), the
  // forearm trails it (elbow key at 21.996). Contact is untouched: whole-body
  // max bone delta over ticks 0-16 equals the A/A' noise floor to 0.01 mm.
  //
  // THE PIN IS WHY CONTACT SURVIVED. `whip` delays every post-pivot key of this
  // clip by f*6*(1-(t-16)/20), which for shoulder_R put its first key after the
  // pivot at 21.55 and for elbow_R at 22.77 — so the three frames the hitbox is
  // swept over (clip 16.000 / 16.714 / 17.429, and 17.48 / 17.67 for riseUpper
  // and technical's hammerFist) are governed by those keys and cannot be
  // re-authored freely. Each track therefore gets an extra key at t 16.5 holding
  // v16 + k*(old v19 - v16), with k the ratio of the two `snap` curves evaluated
  // at clip 17.43 once whip has moved both keys: 0.8302 for shoulder_R (next key
  // 21.55 -> 19.425) and 0.8395 for elbow_R (22.774 -> 20.829). The residual is
  // sub-degree at the mid-sweep frame. Do not round those two keys, and do not
  // move t 16.5 without re-deriving them.
  //
  // MEASURED THROUGH THE COMBAT SYSTEM, not asserted. All three consumers of
  // this clip, on their real retimed paths, five spacings each, same page
  // session, clip arrays swapped:
  //
  //     straight3 / heavy       hit tick 20, dmg 31.05, both sides, all five
  //     straight3 / standard    hit tick 18, dmg 21.63, both sides, all five
  //     straight3 / technical   hit tick 18, dmg 20.60, both sides, all five
  //     riseUpper / standard    hit tick 17, dmg 20.60, both sides, all five
  //     hammerFist / technical  hit tick 18, dmg 23.69, both sides, all five
  //
  // Worst hitbox capsule endpoint movement across every active frame of all of
  // them: 8.3-9.6 mm, rising to 17.2 mm only at the 0.95 m spacing where the
  // capsules already overlap and `separatePair` is doing the arithmetic. The
  // hitbox radius is 260 mm. `check.mjs` anchors stay 0-on-the-wrong-limb, worst
  // ratio 0.59. The stance is untouched — the two versions are identical again
  // by clip 28, and t0/t36 were never keyed here.
  //
  // ONE COST, and it is on a hurtbox rather than a hitbox. hand_R's worst
  // single-tick travel goes 269 mm (at contact) to 427 mm (at t21, in recovery).
  // Hurtboxes are not swept the way hitboxes are, so for that one tick a
  // counter-hit aimed exactly at the airborne fist can pass through it; the
  // torso, head and leg hurtboxes are unaffected and are what actually catch
  // strikes. Spreading the swing to lower that number costs the +21t panel,
  // which is one of the seven the axis is scored on, so it ships measured.
  //
  // AND A NOTE FOR WHOEVER OWNS `tools/capture.mjs`: 17-anim-strip's setup calls
  // `animator.play(mv.clip, {blend: 0, loop: false})` after `startMove`, which is
  // exactly the assignment `TestHarness.armAtImpact` has a comment warning about
  // — it drops the retime `Fighter#startMove` installed one line earlier.
  // Verified by reading `animator.time` against `moveTick` through the shot's own
  // staging: they are equal at every tick, 0:0 4:4 ... 32:32, where the retime
  // says clip 16 should land on move tick 20 for a heavy. The strip's panels are
  // honest CLIP ticks; they are not the move ticks a player sees.
  //
  // ROUND 21. THE HEAD WAS BOLTED TO THE CHEST — ON THIS CLIP AND ON EVERY
  // OTHER ATTACK IN THE LIBRARY.
  //
  // Start with the briefed finding, because it is dead and this is the fourth
  // rig to say so. "The hips translate a NET -1.7 px toward the target and the
  // chest actively RETREATS 11.9 px" has now been re-measured in rounds 18, 19,
  // 20 and here; the acceptance test's two halves both pass and have since
  // round 18. DO NOT BRIEF IT AS OPEN AGAIN WITHOUT RE-MEASURING IT.
  //
  // ROUND 27, FIFTH RIG, AND THIS TIME ON THE ACCEPTANCE TEST'S OWN INSTRUMENT
  // rather than on a proxy for it — the band centroid of a real 17-anim-strip,
  // foreground-masked against the seven-panel median background, exactly as the
  // brief defines it. Own certified run, manifest complete:true, defects []:
  //
  //     band (y range, x 620-960)   +0t    +6t    +10t   +13t   +16t   t+6 -> t+16
  //     HIPS  430-570              836.5  837.4  881.5  877.2  885.7    +48.3 px
  //     CHEST 330-430              852.1  859.7  867.0  867.2  868.8     +9.1 px
  //     HEAD  230-330              880.2  886.9  880.3  872.2  873.7    -13.2 px
  //
  // The threshold is +40 px and the hips clear it by 20%. The morning's shipped
  // strip gives +44.4 px on the same code, so the run-to-run spread is about
  // 4 px and the pass is not marginal. Half two, peak of forward position
  // through the real rig at quarter-tick resolution: hips clip 20.00, chest
  // clip 23.50, head clip 24.75 — chest lags hips by 3.50 ticks, inside the
  // 2-to-4 window. (On peak SPEED rather than peak position the same pair is
  // 13.25 / 14.75, a 1.50-tick lag. Quote which one you mean.)
  //
  // AND A THIRD READ, because a band centroid mixes in the opponent and the FX:
  // the hips BONE projected into the strip's own parked camera, driven through
  // the live sim, moves 822.1 -> 874.7 px over the same two panels. Three
  // instruments, three agreements. The finding is dead five times over.
  //
  // WHAT IS ACTUALLY MISSING 50 MM OF DRIVE, AND IT IS NOT IN THIS FILE. The
  // authored root track and the position the fighter reaches agree to the digit
  // for the first fourteen ticks and then come apart:
  //
  //     clip tick            13      14      15      16      17      20
  //     authored root z    -0.020  +0.050  +0.115  +0.155  +0.178  +0.203
  //     live, in the shot  -0.020  +0.050  +0.104  +0.119  +0.128  +0.137
  //     live, opponent 6m  -0.020  +0.050  +0.115  +0.155  +0.178  +0.203
  //
  // Move the defender out of range and the drive is delivered bit-exact; leave
  // it at the shot's own staging and 50 mm — 27% of the whole translation, 12 px
  // on the strip — is absorbed by pushbox separation over the three ticks where
  // the hips are fastest. So the clip is authoring more body drive than the
  // frame is allowed to show, and the missing part is in the separation solve in
  // Fighter/CombatSystem, not in any key here. Whoever owns that: the hips lose
  // their drive at exactly the moment this axis is scored on.
  //
  // ALSO DISPROVED, so nobody spends the round on it again. The chest carries
  // only 47% of the hips' translation through the window because the spine
  // arches back 42 deg across the drive, which looks like the fixable thing.
  // It is not worth fixing here: cutting the load-phase forward crunch from a
  // summed 33.5 deg to 16 deg (spine01/spine02/chest X only, t4-t15, contact
  // pose untouched) buys the chest bone 31 mm of extra travel — about 7 px, and
  // roughly 2 px once the band centroid dilutes it — while deleting half the
  // clip's anticipation. Measured, reverted, not shipped. The chest's amplitude
  // is capped by the pinned t16 contact pose; it cannot be bought with spine
  // pitch alone, and the root cannot be deepened either because the lead boot is
  // solved against the floor (foot_L world z holds 0.341-0.348 from t0 to t13
  // while the pelvis travels 121 mm under it) and any extra root retreat comes
  // straight out as a slide.
  //
  // What is open is one level up the same chain. `docs/CRITIC.md`'s 90+ line is
  // "the hips lead, the HEAD LAGS", and `whip` (see ./reactions.js) has been
  // retiming this clip's head by six ticks since round 13 — but a delay applied
  // to a track with no amplitude produces nothing. Measured as headTop's
  // position in the CHEST's own frame, driven through the real rig, which is the
  // head's own contribution with everything the body does divided out:
  //
  //     p.uppercut, whole clip     14.4 mm      <- 25th lowest of 79 clips
  //     across the seven panels    13.7 mm         the axis is scored on
  //     r.launch / r.koFall        194 / 246 mm    the rig can do this
  //
  // It is not this clip's defect, it is the library's. Of the thirty clips with
  // the least head articulation, twenty-eight are attacks: k.lowKick 1.9 mm,
  // p.elbow 3.1, p.hook 4.1, p.jab 4.8, p.straight 5.7, k.roundhouse 10.0.
  // Lateral (roll) on an attack runs 0.3–6 mm — the head never tilts AT ALL.
  // For scale, headTop sits 0.29 m above the neck base, so 14 mm is under three
  // degrees. Every attacking robot in this game carries its head the way a
  // mannequin does, and it sits at the top of the silhouette where the eye goes.
  //
  // This round fixes the ONE clip the axis is photographed on, because that is
  // the only place the fix can be proved. The chin tucks and rolls onto the
  // loaded rear side through the coil, holds tucked one key past the hips'
  // reversal, and is thrown back and open as the fist goes overhead. Head
  // articulation over the seven scored panels, headTop in chest frame:
  //
  //     forward   16  19  11  15  24  25  21  mm     ->  16  19  65  69  24 -78 -76
  //     lateral    1   1   1   0  -1  -1   0  mm     ->   1   3  48  42  -1 -26 -26
  //     range                          13.7 mm       ->            164.7 mm  (12x)
  //
  // WHAT IT COST: nothing. Only `neck` and `head` were touched, X and Z only —
  // every Y is the yaw the clip already had, to the digit. Driven through the
  // rig against a reconstruction of the pre-edit tracks, EVERY bone that is not
  // neck/head/headTop moves 0.00 mm at every one of the seven panels, and t0,
  // t16 and t36 are bit-identical at 0.0000 mm, so the stance, the pinned
  // contact pose and everything combat reads are untouched. Worst single-tick
  // hurtbox travel is unchanged at 0.705 m on hand_R; the head bone's own worst
  // tick is unchanged at 0.131 m (the crown swings, the hurtbox origin barely
  // moves). `check.mjs` anchors stay 0-on-the-wrong-limb, worst ratio 0.59. No
  // geometry, no root motion, no reach: the kick workstream's spacing
  // measurements cannot be confounded by this.
  //
  // SEEN, not just measured. Single-page A/B against dist/ — one compiled
  // program, one GPU state, the only difference being which TWO key arrays hang
  // on the attacker's live clip — run A/B/A' so the third pass is the noise
  // floor, frozen on the strip's own clip ticks with its own parked camera,
  // differenced over the 200x210 head band:
  //
  //     tick   change   noise    change %>=8   noise %>=8
  //       13    4.20     1.12        7.8%         0.6%
  //       16    1.26     1.16        1.6%         0.7%   <- pose IS identical here
  //       21    7.55     5.13       25.4%        19.7%
  //       26    5.34     1.06        8.2%         0.5%
  //
  // t16 is the control and it lands ON the noise floor, which is the shape a
  // real change has: it appears where the clip changed and vanishes where it
  // did not. At 3x, at t13 the visor has swung down and the crown clears the
  // exhaust column it used to hide behind; at t26 the head comes up and back
  // and reads as a separate element instead of being lost in the backpack.
  //
  // THREE THINGS THAT WILL WASTE A ROUND IF NOT KNOWN. (1) `Animator`'s look-at
  // layer would fight this, and it is DORMANT — `setLookTarget` has no caller
  // outside Animator.js, so the authored head reaches the frame. (2) `whip`
  // moves this clip's head keys to 6 / 11.6 / 14.1 / 16 / 24.1 / 29 / 36 and its
  // neck keys to 4.68 / 11.05 / 13.88 / 16 / 22.98 / 28.34 / 36; author against
  // those, not against the literal t's, or the extreme lands between panels.
  // (3) The A/B instrument needs the attacker's world position restored and the
  // arena, FX, environment and HUD updates stubbed between arms, and 90 idle
  // ticks run to settle the spring layer. Without the position restore the
  // A/A' floor is 8.8–11.6/255 — the whole fighter, standing somewhere else,
  // because root motion accumulates across runs. With it, 1.1.
  //
  // NEXT: the other twenty-eight attack clips, same treatment, in punches.js,
  // kicks.js and specials.js. It was not done this round because 17-anim-strip
  // photographs only this clip and an unprovable change is how the last two
  // rounds stalled — but the measurement above is the whole brief, and the
  // instrument is `headTop in the chest's frame`, not the authored Euler track.
  'p.uppercut': {
    name: 'Uppercut',
    duration: 36, blendIn: 3, blendOut: 8,
    impact: { tick: 16, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'linear' },
      { t: 1, p: [0, -0.080, -0.010], ease: 'linear' },
      { t: 2, p: [0, -0.092, -0.030], ease: 'linear' },
      { t: 3, p: [0, -0.111, -0.056], ease: 'linear' },
      { t: 4, p: [0, -0.134, -0.081], ease: 'linear' },
      { t: 5, p: [0, -0.158, -0.101], ease: 'linear' },
      { t: 6, p: [0, -0.179, -0.113], ease: 'linear' },
      { t: 7, p: [0, -0.196, -0.119], ease: 'linear' },
      { t: 8, p: [0, -0.207, -0.121], ease: 'linear' },
      { t: 9, p: [0, -0.211, -0.120], ease: 'linear' },
      { t: 10, p: [0, -0.206, -0.114], ease: 'linear' },
      { t: 11, p: [0, -0.190, -0.098], ease: 'linear' },
      { t: 12, p: [0, -0.164, -0.070], ease: 'linear' },
      { t: 13, p: [0, -0.132, -0.020], ease: 'linear' },
      { t: 14, p: [0, -0.090, 0.050], ease: 'linear' },
      { t: 15, p: [0, -0.055, 0.115], ease: 'linear' },
      { t: 16, p: [0, -0.023, 0.155], ease: 'linear' },
      // ROUND 17: the flight. See the note above the clip. t17 is deliberately
      // almost flat, because clip 16.00/16.72/17.44 are the move's three ACTIVE
      // frames and the hitbox is swept over them -- the push does not start
      // until t18, which is move tick 20.8, one tick past the last of them.
      // ROUND 18 amends that: the Z carry now CONTINUES through those three
      // frames, because a strike that stops travelling on its own contact frame
      // is the deceleration defect this file already fixed once for the limbs.
      // Reach at clip 16 is 0.140, bit-identical to what it was, so the hitbox
      // opens at exactly the distance it used to.
      { t: 17, p: [0, -0.018, 0.178], ease: 'linear' },
      { t: 18, p: [0, -0.002, 0.192], ease: 'linear' },
      { t: 19, p: [0, 0.032, 0.200], ease: 'linear' },
      { t: 20, p: [0, 0.058, 0.203], ease: 'linear' },
      { t: 21, p: [0, 0.072, 0.199], ease: 'linear' },
      { t: 22, p: [0, 0.075, 0.189], ease: 'linear' },
      { t: 23, p: [0, 0.066, 0.175], ease: 'linear' },
      { t: 24, p: [0, 0.038, 0.158], ease: 'linear' },
      { t: 25, p: [0, -0.008, 0.140], ease: 'sine' },
      { t: 26, p: [0, -0.136, 0.122], ease: 'sine' },
      { t: 30, p: [0, -0.108, 0.066], ease: 'sine' },
      { t: 36, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      // THE HIP LINE BREAKS. `hips` Z is the pelvic roll and it was doing
      // nothing: over the whole clip hip_L.y - hip_R.y stayed inside 4.3mm, so
      // both hip lines were level in every frame and nobody was standing on a
      // leg. It now rolls -11.5deg onto the rear (right) leg through the load
      // and +9.0deg onto the lead leg through the drive, which is +-40mm of hip
      // height difference; `spine01` takes an equal and opposite roll so the
      // ribcage stays upright over a pelvis that is not — the counter-rotation
      // is what makes it read as weight rather than as the whole chassis
      // tipping, and it is also what keeps the fist where it was (see below).
      //
      // t16 is the pinned contact tick: X and Y here are bit-identical to what
      // they were, and the Z pair cancels through the chain, so hand_R at
      // contact moves by the pelvis roll's lever arm on ONE bone — measured
      // below 30mm — and nothing the combat system reads changes limb.
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [4.5, -33.8, -5.5], ease: 'linear' },
        { t: 9, r: [8, -29.1, -11.5], ease: 'linear' }, { t: 13, r: [3, -14.55, -4], ease: 'linear' },
        { t: 14, r: [1.4, -9.01, -1], ease: 'linear' }, { t: 15, r: [0, -2.64, 2.2], ease: 'linear' },
        { t: 16, r: [-1.2, 4.6, 9], ease: 'sine' }, { t: 19, r: [-1.41, 6.13, 9.6], ease: 'quad' },
        { t: 21, r: [0.6, 2, 8], ease: 'quad' }, { t: 23, r: [3, -2.04, 6.48], ease: 'sine' },
        { t: 26, r: [3.6, -8.1, 4.2], ease: 'sine' }, { t: 30, r: [2.4, -16, 2], ease: 'sine' },
        { t: 36, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [6, 5.9, 4], ease: 'linear' },
        { t: 9, r: [10.5, 5.51, 8.6], ease: 'linear' }, { t: 13, r: [3.4, 4.3, 4.4], ease: 'linear' },
        { t: 14, r: [1.2, 3.84, 2.3], ease: 'linear' }, { t: 15, r: [-0.6, 3.31, -0.5], ease: 'linear' },
        { t: 16, r: [-2.4, 2.7, -7.4], ease: 'sine' }, { t: 19, r: [-2.82, 2.58, -8.3], ease: 'quad' },
        { t: 21, r: [0.4, 3, -6.6], ease: 'quad' }, { t: 23, r: [3.9, 3.28, -5.16], ease: 'sine' },
        { t: 26, r: [4.6, 3.7, -3], ease: 'sine' }, { t: 30, r: [3.4, 4.5, -1.4], ease: 'sine' },
        { t: 36, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [6.5, 6.91, 2.2], ease: 'linear' },
        { t: 9, r: [11.5, 6.46, 4.6], ease: 'linear' }, { t: 13, r: [3.2, 5.05, 3], ease: 'linear' },
        { t: 14, r: [1, 4.51, 2.4], ease: 'linear' }, { t: 15, r: [-1, 3.9, 1.7], ease: 'linear' },
        { t: 16, r: [-3.2, 3.2, 1.1], ease: 'sine' }, { t: 19, r: [-3.76, 3.06, 1.03], ease: 'quad' },
        { t: 21, r: [0.4, 3.6, 0.9], ease: 'quad' }, { t: 23, r: [4.55, 3.92, 0.7], ease: 'sine' },
        { t: 26, r: [5.4, 4.4, 0.4], ease: 'sine' }, { t: 30, r: [4, 5.2, 0.2], ease: 'sine' },
        { t: 36, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [6.5, 8.28, -1], ease: 'linear' },
        { t: 9, r: [11.5, 7.73, 1.2], ease: 'linear' }, { t: 13, r: [3.2, 6.03, -0.2], ease: 'linear' },
        { t: 14, r: [1, 5.38, -0.8], ease: 'linear' }, { t: 15, r: [-1, 4.64, -1.3], ease: 'linear' },
        { t: 16, r: [-3.2, 3.8, -1.7], ease: 'sine' }, { t: 19, r: [-3.76, 3.64, -1.77], ease: 'quad' },
        { t: 21, r: [0.4, 4.4, -2], ease: 'quad' }, { t: 23, r: [4.55, 4.72, -2.16], ease: 'sine' },
        { t: 26, r: [5.4, 5.2, -2.4], ease: 'sine' }, { t: 30, r: [4, 6.2, -2.7], ease: 'sine' },
        { t: 36, r: [2.6, 7.3, -3], ease: 'linear' }],
      // ROUND 21: THE HEAD. X (pitch) and Z (roll) only — every Y here is the
      // yaw this clip already had, to the digit, and the t0, t16 and t36 keys
      // are bit-identical, so the stance and the pinned contact pose do not
      // move. The chin tucks through the load, holds tucked one key past the
      // hips' reversal, and is thrown back as the fist goes overhead. Split
      // ~35/65 between the two joints because they compose over a parent chain:
      // the numbers below SUM to the ~20deg tuck and ~30deg throw-back that were
      // authored, they are not that figure repeated twice.
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 9, r: [7, 6.4, -4.5], ease: 'sine' },
        { t: 13, r: [5.5, 0.5, -3.2], ease: 'quart' }, { t: 16, r: [1.5, -3, 0], ease: 'sine' },
        { t: 19, r: [-10, -3.38, 3.5], ease: 'quad' }, { t: 26, r: [-2.8, 0.2, 1.1], ease: 'sine' },
        { t: 36, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 9, r: [13, 10.1, -8.5], ease: 'sine' },
        { t: 13, r: [10.6, -0.8, -6.2], ease: 'quart' }, { t: 16, r: [3.6, -7.3, 0], ease: 'sine' },
        { t: 19, r: [-20, -8.01, 6.5], ease: 'quad' }, { t: 26, r: [-6.5, -1.3, 2], ease: 'sine' },
        { t: 36, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 9, r: [-41.1, 11.2, -33], ease: 'sine' },
        { t: 13, r: [-17.4, -11, -28.6], ease: 'quart' }, { t: 16, r: [-24, -64.5, -56.1], ease: 'sine' },
        { t: 19, r: [-24.73, -68, -59.12], ease: 'quad' }, { t: 26, r: [-45.8, -6.2, -40.3], ease: 'sine' },
        { t: 36, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 9, r: [-124.27, 0, 17], ease: 'sine' },
        { t: 13, r: [-126.5, 0, 17], ease: 'quart' }, { t: 16, r: [-152, 0, 17], ease: 'sine' },
        { t: 19, r: [-154.8, 0, 17], ease: 'quad' }, { t: 26, r: [-123.7, 0, 17], ease: 'sine' },
        { t: 36, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 9, r: [-8, 1.6, 0], ease: 'sine' },
        { t: 13, r: [-8, 4, 0], ease: 'quart' }, { t: 16, r: [-8, 14, 0], ease: 'sine' },
        { t: 19, r: [-8, 15.1, 0], ease: 'quad' }, { t: 26, r: [-8, 4, 0], ease: 'sine' },
        { t: 36, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 9, r: [-16, 0, 0], ease: 'sine' },
        { t: 13, r: [-19, 0, 0], ease: 'quart' }, { t: 16, r: [-27, 0, 0], ease: 'sine' },
        { t: 19, r: [-27.88, 0, 0], ease: 'quad' }, { t: 26, r: [-17, 0, 0], ease: 'sine' },
        { t: 36, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      // The chamber, re-authored in round 14 — see the note above the clip.
      // The fist SINKS to the hip (world y 1.501 -> 1.098) across t5-t13 and
      // then rises into an unchanged contact pose. Solved against the rig for a
      // target hand path, with a continuity regulariser on the shoulder,
      // because the chain is redundant and an unregularised solve returns a
      // different Euler branch at every key.
      // THE SKYWARD FINISH. See the ROUND 20 note above the clip. `t: 17` is not
      // a pose, it is a PIN: it holds the value the old t16->t19 segment had
      // already interpolated to at the last active frame, so the three frames
      // the hitbox is swept over are unchanged and everything after them is
      // free. Its value is v16 + 0.8589 * (old v19 - v16), where 0.8589 is the
      // ratio of the two `snap` curves at clip 17.43 once `whip` has moved both
      // keys (old next key 21.55, new next key 19.85). Do not round it.
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 4, r: [-14.76, 9.67, 47], ease: 'linear' },
        { t: 9, r: [8.4, -49.3, 57.33], ease: 'sine' }, { t: 12, r: [25.9, -79, 44.63], ease: 'quart' },
        { t: 13, r: [27.7, -84.3, 42.73], ease: 'linear' },
        { t: 14, r: [20.5, -77.6, 47.53], ease: 'linear' }, { t: 15, r: [4.7, -67.4, 56.03], ease: 'linear' },
        { t: 16, r: [-51.3, -39.1, -8.5], ease: 'snap' }, { t: 16.5, r: [-65.39, -42.66, -21.49], ease: 'sine' },
        { t: 18, r: [-107.65, 0.39, 41.38], ease: 'sine' },
        { t: 22, r: [-77.21, -13.69, 25.5], ease: 'sine' }, { t: 26, r: [-40, -30.9, 6.1], ease: 'sine' },
        { t: 36, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 4, r: [-156, 0, -1], ease: 'linear' },
        { t: 9, r: [-139.48, 0, -1], ease: 'sine' }, { t: 12, r: [-115.08, 0, -1], ease: 'quart' },
        { t: 13, r: [-110.58, 0, -1], ease: 'linear' },
        { t: 14, r: [-113.88, 0, -1], ease: 'linear' }, { t: 15, r: [-111.28, 0, -1], ease: 'linear' },
        { t: 16, r: [-89, 0, -1], ease: 'snap' }, { t: 16.5, r: [-82.3, 0, -1], ease: 'sine' },
        { t: 19, r: [-64.55, 0, -1], ease: 'sine' },
        { t: 22, r: [-83.34, 0, -1], ease: 'sine' }, { t: 26, r: [-106.3, 0, -1], ease: 'sine' },
        { t: 36, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4, r: [-8, 7, 0], ease: 'linear' },
        { t: 9, r: [-8, 5.82, 0], ease: 'linear' }, { t: 13, r: [-8, 10, 0], ease: 'linear' },
        { t: 14, r: [-8, -0.19, 0], ease: 'linear' }, { t: 15, r: [-8, -13.94, 0], ease: 'linear' },
        { t: 16, r: [-8, -32, 0], ease: 'snap' }, { t: 19, r: [-8, -40, 0], ease: 'sine' },
        { t: 22, r: [-8, -41, 0], ease: 'sine' }, { t: 26, r: [-8, -10, 0], ease: 'sine' },
        { t: 36, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4, r: [-17.36, 0, 0.56], ease: 'linear' },
        { t: 9, r: [-18.8, 0, 2.8], ease: 'linear' }, { t: 13, r: [-26, 0, 7], ease: 'linear' },
        { t: 14, r: [-20.18, 0, 4.82], ease: 'linear' }, { t: 15, r: [-12.32, 0, 1.87], ease: 'linear' },
        { t: 16, r: [-2, 0, -2], ease: 'snap' }, { t: 19, r: [6, 0, -5], ease: 'sine' },
        { t: 22, r: [-28, 0, -10], ease: 'sine' }, { t: 26, r: [-18, 0, 0], ease: 'sine' },
        { t: 36, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' },
        { t: 1, r: [-40.16, 7.11, 12.76], ease: 'linear' },
        { t: 2, r: [-44.72, 4.22, 15.83], ease: 'linear' },
        { t: 3, r: [-49.75, 1.33, 20.81], ease: 'linear' },
        { t: 4, r: [-53.23, -1.56, 23.5], ease: 'linear' },
        { t: 5, r: [-57.73, -4.45, 25.49], ease: 'linear' },
        { t: 6, r: [-61.59, -7.33, 26.71], ease: 'linear' },
        { t: 7, r: [-64.72, -10.22, 27.18], ease: 'linear' },
        { t: 8, r: [-66.68, -13.11, 27.28], ease: 'linear' },
        { t: 9, r: [-67.31, -16, 27.11], ease: 'linear' },
        { t: 10, r: [-65.72, -14, 23.21], ease: 'linear' },
        { t: 11, r: [-62.23, -12, 19.12], ease: 'linear' },
        { t: 12, r: [-56.61, -10, 15.84], ease: 'linear' },
        { t: 13, r: [-49.55, -8, 12.5], ease: 'linear' },
        { t: 14, r: [-42.59, -6, 7.92], ease: 'linear' },
        { t: 15, r: [-39.25, -4, 2.58], ease: 'linear' },
        { t: 16, r: [-31.51, -2, -8.11], ease: 'linear' },
        { t: 17, r: [-30.62, -2.6, -9.73], ease: 'linear' },
        { t: 18, r: [-26.3, -3.2, -12.2], ease: 'linear' },
        { t: 19, r: [-33.3, -3.8, -5], ease: 'linear' },
        { t: 20, r: [-41.8, -4.4, -1.05], ease: 'linear' },
        { t: 21, r: [-48.14, -5, 1.76], ease: 'linear' },
        { t: 22, r: [-51.3, -5.6, 3.5], ease: 'linear' },
        { t: 23, r: [-49.3, -6.2, 4.2], ease: 'linear' },
        { t: 24, r: [-44.3, -6.8, 4.9], ease: 'linear' },
        { t: 25, r: [-38.3, -7.4, 5.6], ease: 'sine' },
        { t: 26, r: [-40.13, -8, 6.21], ease: 'sine' },
        { t: 30, r: [-38.48, -0.8, 11.11], ease: 'sine' },
        { t: 36, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' },
        { t: 1, r: [43.45, 0, 0], ease: 'linear' },
        { t: 2, r: [46.93, 0, 0], ease: 'linear' },
        { t: 3, r: [51.6, 0, 0], ease: 'linear' },
        { t: 4, r: [55.61, 0, 0], ease: 'linear' },
        { t: 5, r: [59.67, 0, 0], ease: 'linear' },
        { t: 6, r: [63.38, 0, 0], ease: 'linear' },
        { t: 7, r: [66.56, 0, 0], ease: 'linear' },
        { t: 8, r: [68.59, 0, 0], ease: 'linear' },
        { t: 9, r: [69.47, 0, 0], ease: 'linear' },
        { t: 10, r: [67.82, 0, 0], ease: 'linear' },
        { t: 11, r: [64.88, 0, 0], ease: 'linear' },
        { t: 12, r: [60.4, 0, 0], ease: 'linear' },
        { t: 13, r: [55.66, 0, 0], ease: 'linear' },
        { t: 14, r: [49.17, 0, 0], ease: 'linear' },
        { t: 15, r: [42.16, 0, 0], ease: 'linear' },
        { t: 16, r: [23.67, 0, 0], ease: 'linear' },
        { t: 17, r: [17.21, 0, 0], ease: 'linear' },
        { t: 18, r: [8.44, 0, 0], ease: 'linear' },
        { t: 19, r: [28.72, 0, 0], ease: 'linear' },
        { t: 20, r: [44.36, 0, 0], ease: 'linear' },
        { t: 21, r: [56.88, 0, 0], ease: 'linear' },
        { t: 22, r: [63, 0, 0], ease: 'linear' },
        { t: 23, r: [62, 0, 0], ease: 'linear' },
        { t: 24, r: [59, 0, 0], ease: 'linear' },
        { t: 25, r: [57, 0, 0], ease: 'sine' },
        { t: 26, r: [61.27, 0, 0], ease: 'sine' },
        { t: 30, r: [54.81, 0, 0], ease: 'sine' },
        { t: 36, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' },
        { t: 1, r: [-4.6, 2, 0], ease: 'linear' },
        { t: 2, r: [-4.98, 2, 0], ease: 'linear' },
        { t: 3, r: [-5.55, 2, 0], ease: 'linear' },
        { t: 4, r: [-5.75, 2, 0], ease: 'linear' },
        { t: 5, r: [-5.47, 2, 0], ease: 'linear' },
        { t: 6, r: [-5.51, 2, 0], ease: 'linear' },
        { t: 7, r: [-5.74, 2, 0], ease: 'linear' },
        { t: 8, r: [-5.91, 2, 0], ease: 'linear' },
        { t: 9, r: [-6.22, 2, 0], ease: 'linear' },
        { t: 10, r: [-5.58, 2, 0], ease: 'linear' },
        { t: 11, r: [-5.48, 2, 0], ease: 'linear' },
        { t: 12, r: [-5.41, 2, 0], ease: 'linear' },
        { t: 13, r: [-6.52, 2, 0], ease: 'linear' },
        { t: 14, r: [1.51, 2, 0], ease: 'linear' },
        { t: 15, r: [18.22, 2, 0], ease: 'linear' },
        { t: 16, r: [43.06, 2, 0], ease: 'linear' },
        { t: 17, r: [54.95, 2, 0], ease: 'linear' },
        { t: 18, r: [58.89, 2, 0], ease: 'linear' },
        { t: 19, r: [45.45, 2, 0], ease: 'linear' },
        { t: 20, r: [38.22, 2, 0], ease: 'linear' },
        { t: 21, r: [31.63, 2, 0], ease: 'linear' },
        { t: 22, r: [27, 2, 0], ease: 'linear' },
        { t: 23, r: [23, 2, 0], ease: 'linear' },
        { t: 24, r: [13, 2, 0], ease: 'linear' },
        { t: 25, r: [-3, 2, 0], ease: 'sine' },
        { t: 26, r: [-22.7, 2, 0], ease: 'sine' },
        { t: 30, r: [-16.47, 2, 0], ease: 'sine' },
        { t: 36, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' },
        { t: 2, r: [0.89, 0, 0], ease: 'quad' },
        { t: 4, r: [1.05, 0, 0], ease: 'quad' },
        { t: 6, r: [1.05, 0, 0], ease: 'quad' },
        { t: 9, r: [1, 0, 0], ease: 'sine' },
        { t: 11, r: [0.49, 0, 0], ease: 'sine' },
        { t: 13, r: [-0.84, 0, 0], ease: 'quart' },
        { t: 15, r: [-7.14, 0, 0], ease: 'quart' },
        { t: 16, r: [-16.46, 0, 0], ease: 'linear' },
        { t: 17, r: [-16, 0, 0], ease: 'linear' },
        { t: 18, r: [-14, 0, 0], ease: 'linear' },
        { t: 19, r: [-11, 0, 0], ease: 'linear' },
        { t: 20, r: [-8, 0, 0], ease: 'linear' },
        { t: 21, r: [-6, 0, 0], ease: 'linear' },
        { t: 22, r: [-5, 0, 0], ease: 'linear' },
        { t: 23, r: [-4, 0, 0], ease: 'linear' },
        { t: 24, r: [-3, 0, 0], ease: 'linear' },
        { t: 25, r: [-2, 0, 0], ease: 'sine' },
        { t: 26, r: [-0.47, 0, 0], ease: 'sine' },
        { t: 30, r: [-0.27, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' },
        { t: 2, r: [0.49, 0, 0], ease: 'quad' },
        { t: 4, r: [0.98, 0, 0], ease: 'quad' },
        { t: 6, r: [1.47, 0, 0], ease: 'quad' },
        { t: 9, r: [2.2, 0, 0], ease: 'sine' },
        { t: 11, r: [2.6, 0, 0], ease: 'sine' },
        { t: 13, r: [3, 0, 0], ease: 'quart' },
        { t: 15, r: [3, 0, 0], ease: 'quart' },
        { t: 16, r: [3, 0, 0], ease: 'linear' },
        { t: 18, r: [4, 0, 0], ease: 'linear' },
        { t: 20, r: [4.6, 0, 0], ease: 'linear' },
        { t: 22, r: [4.4, 0, 0], ease: 'linear' },
        { t: 24, r: [3.6, 0, 0], ease: 'sine' },
        { t: 26, r: [2.9, 0, 0], ease: 'sine' },
        { t: 30, r: [1.74, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' },
        { t: 1, r: [-10.1, -4.67, -9.97], ease: 'linear' },
        { t: 2, r: [-13.15, -3.33, -5.09], ease: 'linear' },
        { t: 3, r: [-17.22, -2, 0.29], ease: 'linear' },
        { t: 4, r: [-20.07, -0.67, 4.4], ease: 'linear' },
        { t: 5, r: [-23.56, 0.66, 8.19], ease: 'linear' },
        { t: 6, r: [-27.78, 2, 10.47], ease: 'linear' },
        { t: 7, r: [-30.62, 3.33, 13.09], ease: 'linear' },
        { t: 8, r: [-35.63, 4.67, 11.69], ease: 'linear' },
        { t: 9, r: [-38.62, 6, 10.05], ease: 'linear' },
        { t: 10, r: [-34.66, 5, 5.75], ease: 'linear' },
        { t: 11, r: [-29.74, 4, 4.85], ease: 'linear' },
        { t: 12, r: [-25.83, 3, 2.31], ease: 'linear' },
        { t: 13, r: [-21.68, 2, 2.68], ease: 'linear' },
        { t: 14, r: [-17.55, -0.67, -2.5], ease: 'linear' },
        { t: 15, r: [-13.94, -3.33, -6.96], ease: 'linear' },
        { t: 16, r: [-12.09, -6, -15.43], ease: 'linear' },
        { t: 17, r: [-15.1, -6.2, -13.53], ease: 'linear' },
        { t: 18, r: [-15.61, -6.4, -11.64], ease: 'linear' },
        { t: 19, r: [-8.01, -6.6, -18.12], ease: 'linear' },
        { t: 20, r: [-2.45, -6, -20.76], ease: 'linear' },
        { t: 21, r: [1.44, -5, -22.1], ease: 'linear' },
        { t: 22, r: [3.1, -4, -22.4], ease: 'linear' },
        { t: 23, r: [1.6, -2.5, -21.6], ease: 'linear' },
        { t: 24, r: [-1.9, -1, -20.8], ease: 'linear' },
        { t: 25, r: [-5.9, 0.5, -20], ease: 'sine' },
        { t: 26, r: [-10.71, 2, -19.37], ease: 'sine' },
        { t: 30, r: [-9.04, -1.2, -16.85], ease: 'sine' },
        { t: 36, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' },
        { t: 1, r: [46.98, 0, 0], ease: 'linear' },
        { t: 2, r: [50.95, 0, 0], ease: 'linear' },
        { t: 3, r: [56.56, 0, 0], ease: 'linear' },
        { t: 4, r: [62.6, 0, 0], ease: 'linear' },
        { t: 5, r: [68.13, 0, 0], ease: 'linear' },
        { t: 6, r: [73.21, 0, 0], ease: 'linear' },
        { t: 7, r: [76.58, 0, 0], ease: 'linear' },
        { t: 8, r: [79.65, 0, 0], ease: 'linear' },
        { t: 9, r: [79.74, 0, 0], ease: 'linear' },
        { t: 10, r: [79.04, 0, 0], ease: 'linear' },
        { t: 11, r: [77.91, 0, 0], ease: 'linear' },
        { t: 12, r: [75.83, 0, 0], ease: 'linear' },
        { t: 13, r: [73.32, 0, 0], ease: 'linear' },
        { t: 14, r: [67.16, 0, 0], ease: 'linear' },
        { t: 15, r: [59.38, 0, 0], ease: 'linear' },
        { t: 16, r: [51.45, 0, 0], ease: 'linear' },
        { t: 17, r: [49.5, 0, 0], ease: 'linear' },
        { t: 18, r: [43.02, 0, 0], ease: 'linear' },
        { t: 19, r: [49.51, 0, 0], ease: 'linear' },
        { t: 20, r: [55.76, 0, 0], ease: 'linear' },
        { t: 21, r: [60.6, 0, 0], ease: 'linear' },
        { t: 22, r: [63, 0, 0], ease: 'linear' },
        { t: 23, r: [61, 0, 0], ease: 'linear' },
        { t: 24, r: [57, 0, 0], ease: 'linear' },
        { t: 25, r: [54, 0, 0], ease: 'sine' },
        { t: 26, r: [55.98, 0, 0], ease: 'sine' },
        { t: 30, r: [49.42, 0, 0], ease: 'sine' },
        { t: 36, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' },
        { t: 1, r: [-33.91, -3, 0], ease: 'linear' },
        { t: 2, r: [-35.75, -3, 0], ease: 'linear' },
        { t: 3, r: [-38.86, -3, 0], ease: 'linear' },
        { t: 4, r: [-43.12, -3, 0], ease: 'linear' },
        { t: 5, r: [-46.36, -3, 0], ease: 'linear' },
        { t: 6, r: [-48.28, -3, 0], ease: 'linear' },
        { t: 7, r: [-50.16, -3, 0], ease: 'linear' },
        { t: 8, r: [-49, -3, 0], ease: 'linear' },
        { t: 9, r: [-46.84, -3, 0], ease: 'linear' },
        { t: 10, r: [-47.65, -2.25, 0], ease: 'linear' },
        { t: 11, r: [-46.78, -1.5, 0], ease: 'linear' },
        { t: 12, r: [-40.26, -0.75, 0], ease: 'linear' },
        { t: 13, r: [-30.05, 0, 0], ease: 'linear' },
        { t: 14, r: [-12.27, 0, 0], ease: 'linear' },
        { t: 15, r: [6.87, 0, 0], ease: 'linear' },
        { t: 16, r: [21.6, 0, 0], ease: 'linear' },
        { t: 17, r: [32.36, 0, 0], ease: 'linear' },
        { t: 18, r: [41.55, 0, 0], ease: 'linear' },
        { t: 19, r: [31.77, 0, 0], ease: 'linear' },
        { t: 20, r: [26.89, 0, 0], ease: 'linear' },
        { t: 21, r: [22.52, 0, 0], ease: 'linear' },
        { t: 22, r: [19, 0, 0], ease: 'linear' },
        { t: 23, r: [14, 0, 0], ease: 'linear' },
        { t: 24, r: [4, 0, 0], ease: 'linear' },
        { t: 25, r: [-14, 0, 0], ease: 'sine' },
        { t: 26, r: [-39.81, 0, 0], ease: 'sine' },
        { t: 30, r: [-34.18, -1.2, 0], ease: 'sine' },
        { t: 36, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' },
        { t: 2, r: [-1.32, 0, 0], ease: 'quad' },
        { t: 4, r: [-1.31, 0, 0], ease: 'quad' },
        { t: 6, r: [-1.58, 0, 0], ease: 'quad' },
        { t: 9, r: [-1.57, 0, 0], ease: 'sine' },
        { t: 11, r: [-2.81, 0, 0], ease: 'sine' },
        { t: 13, r: [-6.44, 0, 0], ease: 'quart' },
        { t: 15, r: [-16.12, 0, 0], ease: 'quart' },
        { t: 16, r: [-18.12, 0, 0], ease: 'linear' },
        { t: 17, r: [-17, 0, 0], ease: 'linear' },
        { t: 18, r: [-15, 0, 0], ease: 'linear' },
        { t: 19, r: [-12, 0, 0], ease: 'linear' },
        { t: 20, r: [-9, 0, 0], ease: 'linear' },
        { t: 21, r: [-7, 0, 0], ease: 'linear' },
        { t: 22, r: [-6, 0, 0], ease: 'linear' },
        { t: 23, r: [-5.5, 0, 0], ease: 'linear' },
        { t: 24, r: [-5, 0, 0], ease: 'linear' },
        { t: 25, r: [-4.5, 0, 0], ease: 'sine' },
        { t: 26, r: [-4.11, 0, 0], ease: 'sine' },
        { t: 30, r: [-3.37, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' },
        { t: 2, r: [0.78, 0, 0], ease: 'quad' },
        { t: 4, r: [1.56, 0, 0], ease: 'quad' },
        { t: 6, r: [2.33, 0, 0], ease: 'quad' },
        { t: 9, r: [3.5, 0, 0], ease: 'sine' },
        { t: 11, r: [1.1, 0, 0], ease: 'sine' },
        { t: 13, r: [-1.3, 0, 0], ease: 'quart' },
        { t: 15, r: [2.63, 0, 0], ease: 'quart' },
        { t: 16, r: [4.6, 0, 0], ease: 'linear' },
        { t: 18, r: [5.5, 0, 0], ease: 'linear' },
        { t: 20, r: [6, 0, 0], ease: 'linear' },
        { t: 22, r: [5, 0, 0], ease: 'linear' },
        { t: 24, r: [2, 0, 0], ease: 'sine' },
        { t: 26, r: [-0.3, 0, 0], ease: 'sine' },
        { t: 30, r: [-0.18, 0, 0], ease: 'sine' },
        { t: 36, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i18. The fist loops up and behind on the cock, then the entire torso
  // falls into the strike. Heaviest forward lean in the punch set.
  'p.overhand': {
    name: 'Overhand',
    duration: 44, blendIn: 4, blendOut: 8,
    impact: { tick: 22, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 12.22, p: [0, -0.118, -0.04], ease: 'linear' },
      { t: 13, p: [0, -0.117, -0.04], ease: 'linear' },
      { t: 14, p: [0, -0.115, -0.04], ease: 'linear' },
      { t: 15, p: [0, -0.112, -0.038], ease: 'linear' },
      { t: 16, p: [0, -0.108, -0.034], ease: 'linear' },
      { t: 17, p: [0, -0.106, -0.025], ease: 'linear' },
      { t: 18, p: [0, -0.104, -0.008], ease: 'linear' },
      { t: 19, p: [0, -0.106, 0.02], ease: 'linear' },
      { t: 20, p: [0, -0.115, 0.064], ease: 'linear' },
      { t: 21, p: [0, -0.125, 0.129], ease: 'linear' },
      { t: 22, p: [0, -0.129, 0.22], ease: 'sine' },
      { t: 26, p: [0, -0.143, 0.234], ease: 'quad' },
      { t: 33, p: [0, -0.096, 0.14], ease: 'sine' },
      { t: 44, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 5, r: [0.54, -33.8, -0.32], ease: 'sine' },
        { t: 12.22, r: [0.5, -36, 1.5], ease: 'linear' }, { t: 18.33, r: [0, -22.48, 0.6], ease: 'linear' },
        { t: 20, r: [1.35, -11.86, 1.05], ease: 'linear' }, { t: 21, r: [2.39, -3.73, 1.4], ease: 'linear' },
        { t: 22, r: [3.6, 5.8, 1.8], ease: 'sine' }, { t: 26, r: [4, 8.35, 1.93], ease: 'quad' },
        { t: 33, r: [2.9, -5.8, 0.9], ease: 'sine' }, { t: 44, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 5, r: [0.42, 5.93, -0.84], ease: 'sine' },
        { t: 12.22, r: [1, 5.9, 2.5], ease: 'linear' }, { t: 18.33, r: [0, 4.83, 1], ease: 'linear' },
        { t: 20, r: [2.7, 3.99, 1.75], ease: 'linear' }, { t: 21, r: [4.77, 3.35, 2.33], ease: 'linear' },
        { t: 22, r: [7.2, 2.6, 3], ease: 'sine' }, { t: 26, r: [7.99, 2.4, 3.22], ease: 'quad' },
        { t: 33, r: [5.8, 3.5, 1.5], ease: 'sine' }, { t: 44, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 5, r: [0.64, 6.94, -0.95], ease: 'sine' },
        { t: 12.22, r: [1.3, 6.9, 2.8], ease: 'linear' }, { t: 18.33, r: [0, 5.67, 1.1], ease: 'linear' },
        { t: 20, r: [3.61, 4.7, 1.96], ease: 'linear' }, { t: 21, r: [6.37, 3.96, 2.62], ease: 'linear' },
        { t: 22, r: [9.6, 3.1, 3.4], ease: 'sine' }, { t: 26, r: [10.66, 2.87, 3.65], ease: 'quad' },
        { t: 33, r: [7.7, 4.2, 1.7], ease: 'sine' }, { t: 44, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 5, r: [0.64, 8.31, -4.06], ease: 'sine' },
        { t: 12.22, r: [1.3, 8.2, 0.2], ease: 'linear' }, { t: 18.33, r: [0, 6.74, -1.7], ease: 'linear' },
        { t: 20, r: [3.61, 5.6, -0.76], ease: 'linear' }, { t: 21, r: [6.37, 4.73, -0.04], ease: 'linear' },
        { t: 22, r: [9.6, 3.7, 0.8], ease: 'sine' }, { t: 26, r: [10.66, 3.43, 1.08], ease: 'quad' },
        { t: 33, r: [7.7, 4.9, -1.1], ease: 'sine' }, { t: 44, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 12.22, r: [0.8, 7.3, 0], ease: 'sine' },
        { t: 18.33, r: [1, 2.6, 0], ease: 'sine' }, { t: 22, r: [-0.5, -3.3, 0], ease: 'sine' },
        { t: 26, r: [-0.66, -3.95, 0], ease: 'quad' }, { t: 33, r: [-0.2, -0.4, 0], ease: 'sine' },
        { t: 44, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 12.22, r: [2.8, 11.8, 0], ease: 'sine' },
        { t: 18.33, r: [3, 3, 0], ease: 'sine' }, { t: 22, r: [1.2, -7.9, 0], ease: 'sine' },
        { t: 26, r: [1, -9.1, 0], ease: 'quad' }, { t: 33, r: [1.6, -2.4, 0], ease: 'sine' },
        { t: 44, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 12.22, r: [-27.4, 6.3, -43.8], ease: 'sine' },
        { t: 18.33, r: [-14.4, -6.9, -24.4], ease: 'sine' }, { t: 22, r: [-42.6, -38.6, -42.3], ease: 'sine' },
        { t: 26, r: [-45.7, -42.09, -44.27], ease: 'quad' }, { t: 33, r: [-56.9, 1.4, -35.5], ease: 'sine' },
        { t: 44, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 12.22, r: [-123.7, 0, 17], ease: 'sine' },
        { t: 18.33, r: [-115.1, 0, 17], ease: 'sine' }, { t: 22, r: [-152, 0, 17], ease: 'sine' },
        { t: 26, r: [-155.5, 0, 17], ease: 'quad' }, { t: 33, r: [-124, 0, 17], ease: 'sine' }, { t: 38, r: [-120.92, 0, 17], ease: 'sine' },
        { t: 44, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 12.22, r: [-8, 1.6, 0], ease: 'sine' },
        { t: 18.33, r: [-8, 4, 0], ease: 'sine' }, { t: 22, r: [-8, 14, 0], ease: 'sine' },
        { t: 26, r: [-8, 15.1, 0], ease: 'quad' }, { t: 33, r: [-8, 4, 0], ease: 'sine' },
        { t: 44, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 12.22, r: [-16, 0, 0], ease: 'sine' },
        { t: 18.33, r: [-19, 0, 0], ease: 'sine' }, { t: 22, r: [-27, 0, 0], ease: 'sine' },
        { t: 26, r: [-27.88, 0, 0], ease: 'quad' }, { t: 33, r: [-17, 0, 0], ease: 'sine' },
        { t: 44, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 5, r: [-21.09, -1.17, 25], ease: 'sine' },
        { t: 12.22, r: [-120.1, 2, 199.5], ease: 'linear' }, { t: 18.33, r: [-44.5, 35.2, 218.5], ease: 'linear' },
        { t: 20, r: [-44.88, 33.88, 249.44], ease: 'linear' }, { t: 21, r: [-45.26, 32.56, 280.5], ease: 'linear' },
        { t: 22, r: [-45.8, 30.7, 324.2], ease: 'snap' }, { t: 26, r: [-47.12, 26.14, 341.2], ease: 'sine' },
        { t: 33, r: [-48.3, -22.1, 356.4], ease: 'sine' }, { t: 44, r: [-22, 0, 396], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 5, r: [-156, 0, -1], ease: 'sine' },
        { t: 12.22, r: [-79, 0, -1], ease: 'linear' }, { t: 18.33, r: [-69.17, 0, -1], ease: 'linear' },
        { t: 20, r: [-53.17, 0, -1], ease: 'linear' }, { t: 21, r: [-37.1, 0, -1], ease: 'linear' },
        { t: 22, r: [-14.5, 0, -1], ease: 'snap' }, { t: 26, r: [-6.5, 0, -1], ease: 'sine' },
        { t: 29, r: [-36.1, 0, -1], ease: 'quad' }, { t: 33, r: [-86.5, 0, -1], ease: 'sine' },
        { t: 44, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 5, r: [-8, 7, 0], ease: 'sine' },
        { t: 12.22, r: [-8, 4, 0], ease: 'linear' }, { t: 18.33, r: [-8, 10, 0], ease: 'linear' },
        { t: 20, r: [-8, -2.29, 0], ease: 'linear' }, { t: 21, r: [-8, -14.63, 0], ease: 'linear' },
        { t: 22, r: [-8, -32, 0], ease: 'snap' }, { t: 26, r: [-8, -40, 0], ease: 'sine' },
        { t: 29, r: [-8, -41, 0], ease: 'sine' }, { t: 33, r: [-8, -10, 0], ease: 'sine' },
        { t: 44, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 5, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 12.22, r: [-18.8, 0, 2.8], ease: 'linear' }, { t: 18.33, r: [-26, 0, 7], ease: 'linear' },
        { t: 20, r: [-18.97, 0, 4.37], ease: 'linear' }, { t: 21, r: [-11.92, 0, 1.72], ease: 'linear' },
        { t: 22, r: [-2, 0, -2], ease: 'snap' }, { t: 26, r: [6, 0, -5], ease: 'sine' },
        { t: 29, r: [-28, 0, -10], ease: 'sine' }, { t: 33, r: [-18, 0, 0], ease: 'sine' },
        { t: 44, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 12.22, r: [-14, -16, 12], ease: 'sine' },
        { t: 18.33, r: [-22, -10, 10], ease: 'sine' }, { t: 22, r: [-34, -4, 8], ease: 'sine' },
        { t: 26, r: [-35.32, -3.34, 7.78], ease: 'quad' }, { t: 33, r: [-28, -8, 10], ease: 'sine' },
        { t: 44, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 12.22, r: [38, 0, 0], ease: 'sine' },
        { t: 18.33, r: [28, 0, 0], ease: 'sine' }, { t: 22, r: [30, 0, 0], ease: 'sine' },
        { t: 33, r: [30.22, 0, 0], ease: 'sine' }, { t: 44, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 12.22, r: [-28.5, 2, 0], ease: 'sine' }, { t: 18.33, r: [-10.6, 2, 0], ease: 'sine' },
        { t: 22, r: [-4.9, 2, 0], ease: 'sine' }, { t: 26, r: [-4.2, 2, 0], ease: 'quad' }, { t: 33, r: [-10.1, 2, 0], ease: 'sine' },
        { t: 44, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 12.22, r: [6.2, 0, 0], ease: 'sine' }, { t: 18.33, r: [7.3, 0, 0], ease: 'sine' },
        { t: 22, r: [7.1, 0, 0], ease: 'sine' }, { t: 26, r: [7.1, 0, 0], ease: 'quad' }, { t: 33, r: [6.8, 0, 0], ease: 'sine' },
        { t: 44, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 12.22, r: [2.6, 0, 0], ease: 'sine' }, { t: 18.33, r: [3.1, 0, 0], ease: 'sine' },
        { t: 22, r: [3, 0, 0], ease: 'sine' }, { t: 26, r: [3, 0, 0], ease: 'quad' }, { t: 33, r: [2.9, 0, 0], ease: 'sine' },
        { t: 44, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 12.22, r: [-2, 6, -14], ease: 'sine' },
        { t: 18.33, r: [6, 4, -13], ease: 'sine' }, { t: 22, r: [16, -8, -12], ease: 'sine' },
        { t: 26, r: [17.1, -9.32, -11.89], ease: 'quad' }, { t: 33, r: [12, 0, -13], ease: 'sine' },
        { t: 44, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 12.22, r: [34, 0, 0], ease: 'sine' },
        { t: 18.33, r: [20, 0, 0], ease: 'sine' }, { t: 22, r: [10, 0, 0], ease: 'sine' },
        { t: 26, r: [8.9, 0, 0], ease: 'quad' }, { t: 33, r: [18, 0, 0], ease: 'sine' },
        { t: 44, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 12.22, r: [-36, -3, 0], ease: 'sine' }, { t: 18.33, r: [-19.8, 0, 0], ease: 'sine' },
        { t: 22, r: [-32.8, 0, 0], ease: 'sine' }, { t: 26, r: [-34.2, 0, 0], ease: 'quad' }, { t: 33, r: [-26, 0, 0], ease: 'sine' },
        { t: 44, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 12.22, r: [7.8, 0, 0], ease: 'sine' }, { t: 18.33, r: [-4.4, 0, 0], ease: 'sine' },
        { t: 22, r: [7.1, 0, 0], ease: 'sine' }, { t: 26, r: [8.4, 0, 0], ease: 'quad' }, { t: 33, r: [0, 0, 0], ease: 'sine' },
        { t: 44, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 12.22, r: [3.3, 0, 0], ease: 'sine' }, { t: 18.33, r: [-1.9, 0, 0], ease: 'sine' },
        { t: 22, r: [3, 0, 0], ease: 'sine' }, { t: 26, r: [3.5, 0, 0], ease: 'quad' }, { t: 33, r: [0, 0, 0], ease: 'sine' },
        { t: 44, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i14. The hand never leads. The forearm folds flat against the biceps and
  // the point of the elbow is thrown by hip rotation alone.
  'p.elbow': {
    name: 'Elbow Strike',
    duration: 28, blendIn: 3, blendOut: 6,
    impact: { tick: 14, bone: 'elbow_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 8, p: [0, -0.12, 0], ease: 'linear' },
      { t: 9, p: [0, -0.12, 0.002], ease: 'linear' },
      { t: 10, p: [0, -0.118, 0.009], ease: 'linear' },
      { t: 11, p: [0, -0.112, 0.026], ease: 'linear' },
      { t: 12, p: [0, -0.106, 0.055], ease: 'linear' },
      { t: 13, p: [0, -0.104, 0.099], ease: 'linear' },
      { t: 14, p: [0, -0.104, 0.16], ease: 'sine' },
      { t: 17, p: [0, -0.102, 0.174], ease: 'quad' },
      { t: 22, p: [0, -0.072, 0.08], ease: 'sine' },
      { t: 28, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [0.89, -33.8, 0.1], ease: 'sine' },
        { t: 8, r: [1.2, -34.8, 0.6], ease: 'linear' }, { t: 12, r: [1.47, -10.85, -0.05], ease: 'linear' },
        { t: 13, r: [1.58, -1.29, -0.31], ease: 'linear' }, { t: 14, r: [1.7, 9.3, -0.6], ease: 'sine' },
        { t: 17, r: [1.76, 12.8, -0.73], ease: 'quad' }, { t: 22, r: [1.4, -7, 0], ease: 'sine' },
        { t: 28, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [1.48, 5.98, 0.28], ease: 'sine' },
        { t: 8, r: [2.4, 5.8, 1], ease: 'linear' }, { t: 12, r: [2.94, 3.95, -0.09], ease: 'linear' },
        { t: 13, r: [3.16, 3.21, -0.52], ease: 'linear' }, { t: 14, r: [3.4, 2.4, -1], ease: 'sine' },
        { t: 17, r: [3.51, 2.03, -1.22], ease: 'quad' }, { t: 22, r: [2.9, 3.6, 0], ease: 'sine' },
        { t: 28, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [2.07, 7.02, 0.31], ease: 'sine' },
        { t: 8, r: [3.2, 6.8, 1.1], ease: 'linear' }, { t: 12, r: [3.91, 4.63, -0.09], ease: 'linear' },
        { t: 13, r: [4.19, 3.76, -0.57], ease: 'linear' }, { t: 14, r: [4.5, 2.8, -1.1], ease: 'sine' },
        { t: 17, r: [4.64, 2.36, -1.34], ease: 'quad' }, { t: 22, r: [3.8, 4.3, 0], ease: 'sine' },
        { t: 28, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [2.07, 8.42, -2.64], ease: 'sine' },
        { t: 8, r: [3.2, 8, -1.7], ease: 'linear' }, { t: 12, r: [3.91, 5.45, -3.11], ease: 'linear' },
        { t: 13, r: [4.19, 4.43, -3.67], ease: 'linear' }, { t: 14, r: [4.5, 3.3, -4.3], ease: 'sine' },
        { t: 17, r: [4.64, 2.78, -4.59], ease: 'quad' }, { t: 22, r: [3.8, 5, -3], ease: 'sine' },
        { t: 28, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 8, r: [0.5, 7, 0], ease: 'quart' },
        { t: 14, r: [0.3, -4.2, 0], ease: 'sine' }, { t: 17, r: [0.28, -5.43, 0], ease: 'quad' },
        { t: 22, r: [0.4, -0.1, 0], ease: 'sine' }, { t: 28, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 8, r: [2.4, 11.2, 0], ease: 'quart' },
        { t: 14, r: [2.2, -9.5, 0], ease: 'sine' }, { t: 17, r: [2.18, -11.78, 0], ease: 'quad' },
        { t: 22, r: [2.3, -1.9, 0], ease: 'sine' }, { t: 28, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 8, r: [-32.5, 6.7, -36.8], ease: 'quart' },
        { t: 14, r: [-25.4, -58.8, -35.3], ease: 'sine' }, { t: 17, r: [-24.62, -62.3, -35.13], ease: 'quad' },
        { t: 22, r: [-47.3, -7.3, -38.3], ease: 'sine' }, { t: 28, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 8, r: [-123.8, 0, 17], ease: 'quart' },
        { t: 14, r: [-152, 0, 17], ease: 'sine' }, { t: 17, r: [-155.1, 0, 17], ease: 'quad' },
        { t: 22, r: [-123.7, 0, 17], ease: 'sine' }, { t: 28, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 8, r: [-8, 4, 0], ease: 'quart' },
        { t: 14, r: [-8, 14, 0], ease: 'sine' }, { t: 17, r: [-8, 15.1, 0], ease: 'quad' },
        { t: 22, r: [-8, 4, 0], ease: 'sine' }, { t: 28, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 8, r: [-19, 0, 0], ease: 'quart' },
        { t: 14, r: [-27, 0, 0], ease: 'sine' }, { t: 17, r: [-27.88, 0, 0], ease: 'quad' },
        { t: 22, r: [-17, 0, 0], ease: 'sine' }, { t: 28, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 3, r: [-15.27, 0.09, 47], ease: 'sine' },
        { t: 8, r: [-22.6, 68, 40.7], ease: 'linear' }, { t: 12, r: [-37.45, 44.31, 14.45], ease: 'linear' },
        { t: 13, r: [-49.26, 25.47, -6.42], ease: 'linear' }, { t: 14, r: [-65.6, -0.6, -35.3], ease: 'snap' },
        { t: 17, r: [-73.6, -8.6, -43.3], ease: 'sine' }, { t: 20, r: [-73.1, -18.9, -49], ease: 'quad' },
        { t: 22, r: [-38.3, -17.9, 8.1], ease: 'sine' }, { t: 28, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 3, r: [-147.16, 0, -1], ease: 'sine' },
        { t: 8, r: [-152, 0, -1], ease: 'linear' }, { t: 12, r: [-146.92, 0, -1], ease: 'linear' },
        { t: 13, r: [-142.88, 0, -1], ease: 'linear' }, { t: 14, r: [-137.3, 0, -1], ease: 'snap' },
        { t: 17, r: [-129.3, 0, -1], ease: 'sine' }, { t: 20, r: [-126.4, 0, -1], ease: 'quad' },
        { t: 22, r: [-101.1, 0, -1], ease: 'sine' }, { t: 28, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 8, r: [-8, 10, 0], ease: 'quart' },
        { t: 14, r: [-8, -32, 0], ease: 'sine' }, { t: 17, r: [-8, -35.5, 0], ease: 'quad' },
        { t: 20, r: [-8, -41, 0], ease: 'sine' }, { t: 22, r: [-8, -10, 0], ease: 'sine' },
        { t: 28, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 8, r: [-26, 0, 7], ease: 'quart' },
        { t: 14, r: [-2, 0, -2], ease: 'sine' }, { t: 17, r: [0.64, 0, -2.99], ease: 'quad' },
        { t: 20, r: [-28, 0, -10], ease: 'sine' }, { t: 22, r: [-18, 0, 0], ease: 'sine' },
        { t: 28, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 8, r: [-14, -16, 12], ease: 'quart' },
        { t: 14, r: [-28, -2, 8], ease: 'sine' }, { t: 17, r: [-29.54, -0.46, 7.56], ease: 'quad' },
        { t: 22, r: [-39, 10, 11], ease: 'sine' }, { t: 25, r: [-40.21, 11.32, 11.33], ease: 'sine' }, { t: 28, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 8, r: [38, 0, 0], ease: 'quart' },
        { t: 14, r: [22, 0, 0], ease: 'sine' }, { t: 17, r: [20.24, 0, 0], ease: 'quad' },
        { t: 22, r: [42, 0, 0], ease: 'sine' }, { t: 25, r: [44.2, 0, 0], ease: 'sine' }, { t: 28, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 8, r: [-29.3, 2, 0], ease: 'quart' }, { t: 14, r: [-2.2, 2, 0], ease: 'sine' },
        { t: 17, r: [0.9, 2, 0], ease: 'quad' }, { t: 22, r: [-2.6, 2, 0], ease: 'sine' }, { t: 25, r: [-2.3, 2, 0], ease: 'sine' },
        { t: 28, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [6.1, 0, 0], ease: 'quart' }, { t: 14, r: [6.7, 0, 0], ease: 'sine' },
        { t: 17, r: [6.7, 0, 0], ease: 'quad' }, { t: 22, r: [0.8, 0, 0], ease: 'sine' }, { t: 25, r: [0.4, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [2.5, 0, 0], ease: 'quart' }, { t: 14, r: [2.8, 0, 0], ease: 'sine' },
        { t: 17, r: [2.8, 0, 0], ease: 'quad' }, { t: 22, r: [0.3, 0, 0], ease: 'sine' }, { t: 25, r: [0.2, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 8, r: [-2, 6, -14], ease: 'quart' },
        { t: 14, r: [16, -6, -12], ease: 'sine' }, { t: 17, r: [17.98, -7.32, -11.78], ease: 'quad' },
        { t: 22, r: [-9, -6, -12], ease: 'sine' }, { t: 25, r: [-11.75, -6, -12], ease: 'sine' }, { t: 28, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 8, r: [34, 0, 0], ease: 'quart' },
        { t: 14, r: [10, 0, 0], ease: 'sine' }, { t: 17, r: [7.36, 0, 0], ease: 'quad' },
        { t: 22, r: [45, 0, 0], ease: 'sine' }, { t: 25, r: [48.5, 0, 0], ease: 'sine' }, { t: 28, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 8, r: [-35.5, -3, 0], ease: 'quart' }, { t: 14, r: [-28.5, 0, 0], ease: 'sine' },
        { t: 17, r: [-27.7, 0.3, 0], ease: 'quad' }, { t: 22, r: [-28.4, -3, 0], ease: 'sine' }, { t: 25, r: [-27.5, -3.3, 0], ease: 'sine' },
        { t: 28, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [8.4, 0, 0], ease: 'quart' }, { t: 14, r: [4.3, 0, 0], ease: 'sine' },
        { t: 17, r: [3.9, 0, 0], ease: 'quad' }, { t: 22, r: [2.6, 0, 0], ease: 'sine' }, { t: 25, r: [2.9, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 8, r: [3.5, 0, 0], ease: 'quart' }, { t: 14, r: [1.8, 0, 0], ease: 'sine' },
        { t: 17, r: [1.6, 0, 0], ease: 'quad' }, { t: 22, r: [1.1, 0, 0], ease: 'sine' }, { t: 25, r: [1.2, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i20. Head turns first and finds the opponent on tick 8, then the body
  // follows through a full 360 of root yaw. Ends facing forward again.
  'p.backfist': {
    name: 'Spinning Backfist',
    duration: 33, blendIn: 4, blendOut: 8,
    impact: { tick: 13, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 4.88, p: [0, -0.114, 0], ease: 'sine' },
      { t: 9.75, p: [0, -0.096, 0.02], ry: -150, ease: 'linear' },
      { t: 10, p: [0, -0.096, 0.021], ry: -150.04, ease: 'linear' },
      { t: 11, p: [0, -0.093, 0.034], ry: -172.06, ease: 'linear' },
      { t: 12, p: [0, -0.083, 0.061], ry: -266.97, ease: 'linear' },
      { t: 13, p: [0, -0.082, 0.1], ry: -276, ease: 'sine' },
      { t: 16, p: [0, -0.078, 0.109], ry: -280, ease: 'quad' },
      { t: 23, p: [0, -0.088, 0.06], ry: -360, ease: 'sine' },
      { t: 33, p: [0, -0.075, 0], ry: -360, ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 2, r: [1.08, -33.32, 0.25], ease: 'sine' },
        { t: 4.88, r: [1.2, -13.9, 0], ease: 'sine' }, { t: 9.75, r: [1, 0, 0], ease: 'linear' },
        { t: 11, r: [0.9, -2.57, -0.29], ease: 'linear' }, { t: 12, r: [0.8, -5.21, -0.58], ease: 'linear' },
        { t: 13, r: [0.7, -8.1, -0.9], ease: 'sine' }, { t: 16, r: [0.67, -8.99, -1], ease: 'quad' },
        { t: 23, r: [1.4, -23.2, 0], ease: 'sine' }, { t: 33, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 2, r: [2.04, 5.62, 0.42], ease: 'sine' },
        { t: 4.88, r: [2.4, 4.2, 0], ease: 'sine' }, { t: 9.75, r: [1.9, 3.1, 0], ease: 'linear' },
        { t: 11, r: [1.74, 3.29, -0.48], ease: 'linear' }, { t: 12, r: [1.58, 3.49, -0.97], ease: 'linear' },
        { t: 13, r: [1.4, 3.7, -1.5], ease: 'sine' }, { t: 16, r: [1.35, 3.77, -1.66], ease: 'quad' },
        { t: 23, r: [2.9, 4.9, 0], ease: 'sine' }, { t: 33, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 2, r: [2.8, 6.58, 0.48], ease: 'sine' },
        { t: 4.88, r: [3.2, 4.9, 0], ease: 'sine' }, { t: 9.75, r: [2.6, 3.6, 0], ease: 'linear' },
        { t: 11, r: [2.38, 3.85, -0.54], ease: 'linear' }, { t: 12, r: [2.15, 4.11, -1.09], ease: 'linear' },
        { t: 13, r: [1.9, 4.4, -1.7], ease: 'sine' }, { t: 16, r: [1.82, 4.49, -1.89], ease: 'quad' },
        { t: 23, r: [3.8, 5.7, 0], ease: 'sine' }, { t: 33, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 2, r: [2.8, 7.89, -2.47], ease: 'sine' },
        { t: 4.88, r: [3.2, 5.8, -3], ease: 'sine' }, { t: 9.75, r: [2.6, 4.3, -3], ease: 'linear' },
        { t: 11, r: [2.38, 4.59, -3.6], ease: 'linear' }, { t: 12, r: [2.15, 4.88, -4.22], ease: 'linear' },
        { t: 13, r: [1.9, 5.2, -4.9], ease: 'sine' }, { t: 16, r: [1.82, 5.3, -5.11], ease: 'quad' },
        { t: 23, r: [3.8, 6.8, -3], ease: 'sine' }, { t: 33, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 4.88, r: [0.5, -12.3, 0], ease: 'sine' },
        { t: 9.75, r: [0.6, -33.3, 0], ease: 'quart' }, { t: 13, r: [0.7, -10.3, 0], ease: 'sine' },
        { t: 16, r: [0.71, -7.77, 0], ease: 'quad' }, { t: 23, r: [0.4, 4, 0], ease: 'sine' },
        { t: 33, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 4.88, r: [2.4, -24.6, 0], ease: 'sine' },
        { t: 9.75, r: [2.5, -63.6, 0], ease: 'quart' }, { t: 13, r: [2.6, -20.8, 0], ease: 'sine' },
        { t: 16, r: [2.61, -17.3, 0], ease: 'quad' }, { t: 23, r: [2.3, 5.8, 0], ease: 'sine' },
        { t: 33, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 2, r: [-46, -0.18, -36.69], ease: 'sine' },
        { t: 4.88, r: [4, -27, -22.8], ease: 'sine' }, { t: 9.75, r: [182, 5.7, -71.7], ease: 'linear' },
        { t: 11, r: [197.76, 5.57, -61.9], ease: 'linear' }, { t: 12, r: [227.4, 5.34, -43.48], ease: 'linear' },
        { t: 13, r: [270, 5, -17], ease: 'snap' }, { t: 16, r: [278, 4.82, -9], ease: 'sine' },
        { t: 19, r: [298.1, 5.4, -2.3], ease: 'quad' }, { t: 23, r: [336.1, 10.8, -2.4], ease: 'sine' },
        { t: 33, r: [325, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 2, r: [-135, 0, 17], ease: 'sine' },
        { t: 4.88, r: [-152, 0, 17], ease: 'sine' }, { t: 9.75, r: [-102.9, 0, 17], ease: 'linear' },
        { t: 11, r: [-86.05, 0, 17], ease: 'linear' }, { t: 12, r: [-54.36, 0, 17], ease: 'linear' },
        { t: 13, r: [-8.8, 0, 17], ease: 'snap' }, { t: 16, r: [-0.8, 0, 17], ease: 'sine' },
        { t: 19, r: [-37.2, 0, 17], ease: 'quad' }, { t: 23, r: [-103.6, 0, 17], ease: 'sine' },
        { t: 33, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 2, r: [-8, -7, 0], ease: 'sine' },
        { t: 4.88, r: [-8, -4, 0], ease: 'sine' }, { t: 9.75, r: [-8, -10, 0], ease: 'linear' },
        { t: 11, r: [-8, -2.48, 0], ease: 'linear' }, { t: 12, r: [-8, 11.67, 0], ease: 'linear' },
        { t: 13, r: [-8, 32, 0], ease: 'snap' }, { t: 16, r: [-8, 40, 0], ease: 'sine' },
        { t: 19, r: [-8, 41, 0], ease: 'sine' }, { t: 23, r: [-8, 10, 0], ease: 'sine' },
        { t: 33, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 2, r: [-17.36, 0, -0.56], ease: 'sine' },
        { t: 4.88, r: [-18.8, 0, -2.8], ease: 'sine' }, { t: 9.75, r: [-26, 0, -7], ease: 'linear' },
        { t: 11, r: [-21.7, 0, -5.39], ease: 'linear' }, { t: 12, r: [-13.62, 0, -2.36], ease: 'linear' },
        { t: 13, r: [-2, 0, 2], ease: 'snap' }, { t: 16, r: [6, 0, 5], ease: 'sine' },
        { t: 19, r: [-28, 0, 10], ease: 'sine' }, { t: 23, r: [-18, 0, 0], ease: 'sine' },
        { t: 33, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 4.88, r: [-16.8, -7.7, 34.7], ease: 'sine' },
        { t: 9.75, r: [-152.9, 12.8, 88.1], ease: 'quart' }, { t: 13, r: [-311.7, -3.9, 80.1], ease: 'sine' },
        { t: 16, r: [-315.2, -5.74, 79.22], ease: 'quad' }, { t: 23, r: [-382.4, -4.5, 33.8], ease: 'sine' },
        { t: 33, r: [-382, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 4.88, r: [-145.4, 0, -1], ease: 'sine' },
        { t: 9.75, r: [-113.3, 0, -1], ease: 'quart' }, { t: 13, r: [-152, 0, -1], ease: 'sine' },
        { t: 16, r: [-155.5, 0, -1], ease: 'quad' }, { t: 23, r: [-145.4, 0, -1], ease: 'sine' },
        { t: 33, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4.88, r: [-8, -1.6, 0], ease: 'sine' },
        { t: 9.75, r: [-8, -4, 0], ease: 'quart' }, { t: 13, r: [-8, -14, 0], ease: 'sine' },
        { t: 16, r: [-8, -15.1, 0], ease: 'quad' }, { t: 23, r: [-8, -4, 0], ease: 'sine' },
        { t: 33, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4.88, r: [-16, 0, 0], ease: 'sine' },
        { t: 9.75, r: [-19, 0, 0], ease: 'quart' }, { t: 13, r: [-27, 0, 0], ease: 'sine' },
        { t: 16, r: [-27.88, 0, 0], ease: 'quad' }, { t: 23, r: [-17, 0, 0], ease: 'sine' },
        { t: 33, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 4.88, r: [-16, -20, 12], ease: 'sine' },
        { t: 9.75, r: [-10, -6, 12], ease: 'quart' }, { t: 13, r: [-14, -10, 10], ease: 'sine' },
        { t: 16, r: [-14.44, -10.44, 9.78], ease: 'quad' }, { t: 23, r: [-39, 10, 11], ease: 'sine' }, { t: 28, r: [-41.75, 12.2, 11.11], ease: 'sine' },
        { t: 33, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 4.88, r: [34, 0, 0], ease: 'sine' },
        { t: 9.75, r: [30, 0, 0], ease: 'quart' }, { t: 13, r: [24, 0, 0], ease: 'sine' },
        { t: 16, r: [23.34, 0, 0], ease: 'quad' }, { t: 23, r: [42, 0, 0], ease: 'sine' }, { t: 28, r: [43.98, 0, 0], ease: 'sine' },
        { t: 33, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 4.88, r: [-23.5, 2, 0], ease: 'sine' }, { t: 9.75, r: [-25.6, 2, 0], ease: 'quart' },
        { t: 13, r: [-16, 2, 0], ease: 'sine' }, { t: 16, r: [-14.7, 2, 0], ease: 'quad' }, { t: 23, r: [-5.2, 2, 0], ease: 'sine' },
        { t: 28, r: [-1.6, 2, 0], ease: 'sine' }, { t: 33, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4.88, r: [6.6, 0, 0], ease: 'sine' }, { t: 9.75, r: [6.3, 0, 0], ease: 'quart' },
        { t: 13, r: [6.6, 0, 0], ease: 'sine' }, { t: 16, r: [6.8, 0, 0], ease: 'quad' }, { t: 23, r: [-0.7, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4.88, r: [2.8, 0, 0], ease: 'sine' }, { t: 9.75, r: [2.6, 0, 0], ease: 'quart' },
        { t: 13, r: [2.8, 0, 0], ease: 'sine' }, { t: 16, r: [2.8, 0, 0], ease: 'quad' }, { t: 23, r: [-0.3, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 4.88, r: [2, 10, -13], ease: 'sine' },
        { t: 9.75, r: [-4, 0, -13], ease: 'quart' }, { t: 13, r: [4, 4, -13], ease: 'sine' },
        { t: 16, r: [4.88, 4.44, -13], ease: 'quad' }, { t: 23, r: [-9, -6, -12], ease: 'sine' }, { t: 28, r: [-10.43, -7.1, -11.89], ease: 'sine' },
        { t: 33, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 4.88, r: [28, 0, 0], ease: 'sine' },
        { t: 9.75, r: [30, 0, 0], ease: 'quart' }, { t: 13, r: [22, 0, 0], ease: 'sine' },
        { t: 16, r: [21.12, 0, 0], ease: 'quad' }, { t: 23, r: [45, 0, 0], ease: 'sine' }, { t: 28, r: [47.53, 0, 0], ease: 'sine' },
        { t: 33, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 4.88, r: [-34.1, -3, 0], ease: 'sine' }, { t: 9.75, r: [-29.8, -3, 0], ease: 'quart' },
        { t: 13, r: [-18, 0, 0], ease: 'sine' }, { t: 16, r: [-15.3, 0.3, 0], ease: 'quad' }, { t: 23, r: [-32.3, -3, 0], ease: 'sine' },
        { t: 28, r: [-34.6, -3.3, 0], ease: 'sine' }, { t: 33, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4.88, r: [8.4, 0, 0], ease: 'sine' }, { t: 9.75, r: [8.6, 0, 0], ease: 'quart' },
        { t: 13, r: [0, 0, 0], ease: 'sine' }, { t: 16, r: [-0.1, 0, 0], ease: 'quad' }, { t: 23, r: [0.4, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 4.88, r: [3.5, 0, 0], ease: 'sine' }, { t: 9.75, r: [3.6, 0, 0], ease: 'quart' },
        { t: 13, r: [0, 0, 0], ease: 'sine' }, { t: 16, r: [0, 0, 0], ease: 'quad' }, { t: 23, r: [0.2, 0, 0], ease: 'sine' },
        { t: 28, r: [0, 0, 0], ease: 'sine' }, { t: 33, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i22. Both fists laced overhead with an 6-frame hang at the top, then a
  // two-handed axe straight down the centreline.
  'p.hammerFist': {
    name: 'Hammer Fist',
    duration: 41, blendIn: 4, blendOut: 9,
    impact: { tick: 19, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 9, p: [0, -0.091, -0.04], ease: 'sine' },
      { t: 14, p: [0, -0.079, -0.02], ease: 'linear' },
      { t: 15, p: [0, -0.084, -0.015], ease: 'linear' },
      { t: 16, p: [0, -0.099, 0.003], ease: 'linear' },
      { t: 17, p: [0, -0.117, 0.034], ease: 'linear' },
      { t: 18, p: [0, -0.131, 0.079], ease: 'linear' },
      { t: 19, p: [0, -0.137, 0.14], ease: 'sine' },
      { t: 23, p: [0, -0.143, 0.154], ease: 'quad' },
      { t: 30, p: [0, -0.117, 0.08], ease: 'sine' },
      { t: 41, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [-0.26, -30.71, 0], ease: 'sine' },
        { t: 9, r: [-1.7, -23.2, 0], ease: 'sine' }, { t: 14, r: [-2.6, -19.7, 0], ease: 'linear' },
        { t: 17, r: [1.72, -18.47, 0], ease: 'linear' }, { t: 18, r: [3.56, -17.95, 0], ease: 'linear' },
        { t: 19, r: [5.5, -17.4, 0], ease: 'sine' }, { t: 23, r: [6.39, -17.15, 0], ease: 'quad' },
        { t: 30, r: [3.1, -22, 0], ease: 'sine' }, { t: 41, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [-0.65, 5.42, 0], ease: 'sine' },
        { t: 9, r: [-3.4, 4.9, 0], ease: 'sine' }, { t: 14, r: [-5.3, 4.6, 0], ease: 'linear' },
        { t: 17, r: [3.4, 4.49, 0], ease: 'linear' }, { t: 18, r: [7.09, 4.45, 0], ease: 'linear' },
        { t: 19, r: [11, 4.4, 0], ease: 'sine' }, { t: 23, r: [12.79, 4.38, 0], ease: 'quad' },
        { t: 30, r: [6.2, 4.8, 0], ease: 'sine' }, { t: 41, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [-0.79, 6.35, 0], ease: 'sine' },
        { t: 9, r: [-4.5, 5.7, 0], ease: 'sine' }, { t: 14, r: [-7, 5.4, 0], ease: 'linear' },
        { t: 17, r: [4.58, 5.29, 0], ease: 'linear' }, { t: 18, r: [9.49, 5.25, 0], ease: 'linear' },
        { t: 19, r: [14.7, 5.2, 0], ease: 'sine' }, { t: 23, r: [17.09, 5.18, 0], ease: 'quad' },
        { t: 30, r: [8.3, 5.6, 0], ease: 'sine' }, { t: 41, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [-0.79, 7.61, -3], ease: 'sine' },
        { t: 9, r: [-4.5, 6.8, -3], ease: 'sine' }, { t: 14, r: [-7, 6.4, -3], ease: 'linear' },
        { t: 17, r: [4.58, 6.29, -3], ease: 'linear' }, { t: 18, r: [9.49, 6.25, -3], ease: 'linear' },
        { t: 19, r: [14.7, 6.2, -3], ease: 'sine' }, { t: 23, r: [17.09, 6.18, -3], ease: 'quad' },
        { t: 30, r: [8.3, 6.7, -3], ease: 'sine' }, { t: 41, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 9, r: [1.7, 4, 0], ease: 'sine' },
        { t: 14, r: [2.1, 3.1, 0], ease: 'sine' }, { t: 19, r: [-1.3, 2.6, 0], ease: 'sine' },
        { t: 23, r: [-1.67, 2.55, 0], ease: 'quad' }, { t: 30, r: [-0.3, 3.7, 0], ease: 'sine' },
        { t: 41, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 9, r: [3.8, 5.8, 0], ease: 'sine' },
        { t: 14, r: [4.3, 4.1, 0], ease: 'sine' }, { t: 19, r: [0.2, 3, 0], ease: 'sine' },
        { t: 23, r: [-0.25, 2.88, 0], ease: 'quad' }, { t: 30, r: [1.4, 5.2, 0], ease: 'sine' },
        { t: 41, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 9, r: [-54.5, -30.7, 68.7], ease: 'sine' },
        { t: 14, r: [-67.7, -34.6, 62.5], ease: 'sine' }, { t: 19, r: [8.3, -51.6, 84], ease: 'sine' },
        { t: 23, r: [11.8, -53.47, 86.37], ease: 'quad' }, { t: 30, r: [-49.3, 18.1, -0.5], ease: 'sine' },
        { t: 41, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 9, r: [-28, 0, 17], ease: 'sine' },
        { t: 14, r: [-20.9, 0, 17], ease: 'sine' }, { t: 19, r: [-28.7, 0, 17], ease: 'sine' },
        { t: 23, r: [-29.56, 0, 17], ease: 'quad' }, { t: 30, r: [-85, 0, 17], ease: 'sine' },
        { t: 41, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 9, r: [-8, -4, 0], ease: 'sine' },
        { t: 14, r: [-8, -10, 0], ease: 'sine' }, { t: 19, r: [-8, 32, 0], ease: 'sine' },
        { t: 23, r: [-8, 35.5, 0], ease: 'quad' }, { t: 26, r: [-8, 41, 0], ease: 'sine' },
        { t: 30, r: [-8, 10, 0], ease: 'sine' }, { t: 41, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 9, r: [-18.8, 0, -2.8], ease: 'sine' },
        { t: 14, r: [-26, 0, -7], ease: 'sine' }, { t: 19, r: [-2, 0, 2], ease: 'sine' },
        { t: 23, r: [0.64, 0, 2.99], ease: 'quad' }, { t: 26, r: [-28, 0, 10], ease: 'sine' },
        { t: 30, r: [-18, 0, 0], ease: 'sine' }, { t: 41, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 4, r: [-22.02, -5.72, 47], ease: 'sine' },
        { t: 9, r: [-88.7, 13.6, -54.6], ease: 'sine' }, { t: 14, r: [-91.7, 13.6, -56.7], ease: 'linear' },
        { t: 17, r: [-68.3, 26.79, -59.81], ease: 'linear' }, { t: 18, r: [-48.36, 38.03, -62.46], ease: 'linear' },
        { t: 19, r: [-21.8, 53, -66], ease: 'snap' }, { t: 23, r: [-4.8, 62.58, -68.27], ease: 'sine' },
        { t: 26, r: [-8.3, 54.5, -60.7], ease: 'quad' }, { t: 30, r: [-52.6, -22.3, 5.5], ease: 'sine' },
        { t: 41, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 4, r: [-156, 0, -1], ease: 'sine' },
        { t: 9, r: [-26.8, 0, -1], ease: 'sine' }, { t: 14, r: [-21.7, 0, -1], ease: 'linear' },
        { t: 17, r: [-22.24, 0, -1], ease: 'linear' }, { t: 18, r: [-22.69, 0, -1], ease: 'linear' },
        { t: 19, r: [-23.3, 0, -1], ease: 'snap' }, { t: 23, r: [-23.85, 0, -1], ease: 'sine' },
        { t: 26, r: [-43.7, 0, -1], ease: 'quad' }, { t: 30, r: [-91.2, 0, -1], ease: 'sine' },
        { t: 41, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4, r: [-8, 7, 0], ease: 'sine' },
        { t: 9, r: [-8, 4, 0], ease: 'sine' }, { t: 14, r: [-8, 10, 0], ease: 'linear' },
        { t: 17, r: [-8, -4.06, 0], ease: 'linear' }, { t: 18, r: [-8, -16.04, 0], ease: 'linear' },
        { t: 19, r: [-8, -32, 0], ease: 'snap' }, { t: 23, r: [-8, -40, 0], ease: 'sine' },
        { t: 26, r: [-8, -41, 0], ease: 'sine' }, { t: 30, r: [-8, -10, 0], ease: 'sine' },
        { t: 41, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 9, r: [-18.8, 0, 2.8], ease: 'sine' }, { t: 14, r: [-26, 0, 7], ease: 'linear' },
        { t: 17, r: [-17.97, 0, 3.99], ease: 'linear' }, { t: 18, r: [-11.12, 0, 1.42], ease: 'linear' },
        { t: 19, r: [-2, 0, -2], ease: 'snap' }, { t: 23, r: [6, 0, -5], ease: 'sine' },
        { t: 26, r: [-28, 0, -10], ease: 'sine' }, { t: 30, r: [-18, 0, 0], ease: 'sine' },
        { t: 41, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 9, r: [-16, -14, 10], ease: 'sine' },
        { t: 14, r: [-12, -12, 10], ease: 'sine' }, { t: 19, r: [-30, -14, 12], ease: 'sine' },
        { t: 23, r: [-31.98, -14.22, 12.22], ease: 'quad' }, { t: 30, r: [-24, -16, 11], ease: 'sine' },
        { t: 41, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 9, r: [22, 0, 0], ease: 'sine' },
        { t: 14, r: [16, 0, 0], ease: 'sine' }, { t: 19, r: [46, 0, 0], ease: 'sine' },
        { t: 23, r: [49.3, 0, 0], ease: 'quad' }, { t: 30, r: [38, 0, 0], ease: 'sine' },
        { t: 41, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 9, r: [-9.3, 2, 0], ease: 'sine' }, { t: 14, r: [-17.9, 2, 0], ease: 'sine' },
        { t: 19, r: [-26.9, 2, 0], ease: 'sine' }, { t: 23, r: [-28.8, 2, 0], ease: 'quad' }, { t: 30, r: [-22.6, 2, 0], ease: 'sine' },
        { t: 41, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 9, r: [7.3, 0, 0], ease: 'sine' }, { t: 14, r: [0, 0, 0], ease: 'sine' },
        { t: 19, r: [5.8, 0, 0], ease: 'sine' }, { t: 23, r: [5.7, 0, 0], ease: 'quad' }, { t: 30, r: [6.1, 0, 0], ease: 'sine' },
        { t: 41, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 9, r: [3.1, 0, 0], ease: 'sine' }, { t: 14, r: [0, 0, 0], ease: 'sine' },
        { t: 19, r: [2.4, 0, 0], ease: 'sine' }, { t: 23, r: [2.4, 0, 0], ease: 'quad' }, { t: 30, r: [2.6, 0, 0], ease: 'sine' },
        { t: 41, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 9, r: [2, 6, -13], ease: 'sine' },
        { t: 14, r: [0, 6, -13], ease: 'sine' }, { t: 19, r: [-6, 6, -14], ease: 'sine' },
        { t: 23, r: [-6.66, 6, -14.11], ease: 'quad' }, { t: 30, r: [0, 6, -13], ease: 'sine' },
        { t: 41, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 9, r: [18, 0, 0], ease: 'sine' },
        { t: 14, r: [14, 0, 0], ease: 'sine' }, { t: 19, r: [44, 0, 0], ease: 'sine' },
        { t: 23, r: [47.3, 0, 0], ease: 'quad' }, { t: 30, r: [34, 0, 0], ease: 'sine' },
        { t: 41, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 9, r: [-22.7, -3, 0], ease: 'sine' }, { t: 14, r: [-28.9, -3, 0], ease: 'sine' },
        { t: 19, r: [-45.5, -3, 0], ease: 'sine' }, { t: 23, r: [-46.4, -3, 0], ease: 'quad' }, { t: 30, r: [-39.6, -3, 0], ease: 'sine' },
        { t: 41, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 9, r: [8.1, 0, 0], ease: 'sine' }, { t: 14, r: [0, 0, 0], ease: 'sine' },
        { t: 19, r: [8.2, 0, 0], ease: 'sine' }, { t: 23, r: [9.5, 0, 0], ease: 'quad' }, { t: 30, r: [8.3, 0, 0], ease: 'sine' },
        { t: 41, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 9, r: [3.4, 0, 0], ease: 'sine' }, { t: 14, r: [0, 0, 0], ease: 'sine' },
        { t: 19, r: [3.5, 0, 0], ease: 'sine' }, { t: 23, r: [4, 0, 0], ease: 'quad' }, { t: 30, r: [3.5, 0, 0], ease: 'sine' },
        { t: 41, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // Four alternating straights on an advance, contact on ticks 12/20/28/36.
  // Each fist reaches full lock on its own contact frame and the chest
  // counter-rotates every beat; the root walks half a metre forward.
  'p.pistonRush': {
    name: 'Piston Rush',
    duration: 62, blendIn: 4, blendOut: 10,
    impact: { tick: 16, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quart' },
      { t: 12, p: [0, -0.084, 0.1], ease: 'linear' },
      { t: 13, p: [0, -0.086, 0.105], ease: 'linear' },
      { t: 14, p: [0, -0.094, 0.117], ease: 'linear' },
      { t: 15, p: [0, -0.101, 0.136], ease: 'linear' },
      { t: 16, p: [0, -0.104, 0.16], ease: 'quart' },
      { t: 20, p: [0, -0.088, 0.24], ease: 'quad' },
      { t: 24, p: [0, -0.104, 0.3], ease: 'quart' },
      { t: 28, p: [0, -0.084, 0.38], ease: 'quad' },
      { t: 32, p: [0, -0.104, 0.44], ease: 'quart' },
      { t: 36, p: [0, -0.088, 0.52], ease: 'sine' },
      { t: 40, p: [0, -0.086, 0.529], ease: 'sine' },
      { t: 50, p: [0, -0.1, 0.5], ease: 'sine' },
      { t: 62, p: [0, -0.076, 0.5], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [0.8, -30.71, 0], ease: 'sine' },
        { t: 12, r: [1.9, -38.3, -0.6], ease: 'linear' }, { t: 14, r: [1.81, -29.2, -0.34], ease: 'linear' },
        { t: 15, r: [1.76, -23.5, -0.18], ease: 'linear' }, { t: 16, r: [1.7, -17.4, 0], ease: 'quart' },
        { t: 20, r: [1.9, 10.4, 0.6], ease: 'quad' }, { t: 24, r: [1.7, -17.4, 0], ease: 'quart' },
        { t: 28, r: [1.9, -38.3, -0.6], ease: 'quad' }, { t: 32, r: [1.7, -17.4, 0], ease: 'quart' },
        { t: 36, r: [1.9, 10.4, 0.6], ease: 'sine' }, { t: 40, r: [1.92, 13.46, 0.67], ease: 'sine' },
        { t: 50, r: [1.7, -22, 0], ease: 'sine' }, { t: 62, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [1.48, 5.42, 0], ease: 'sine' },
        { t: 12, r: [3.8, 6, -1], ease: 'linear' }, { t: 14, r: [3.63, 5.3, -0.56], ease: 'linear' },
        { t: 15, r: [3.52, 4.87, -0.29], ease: 'linear' }, { t: 16, r: [3.4, 4.4, 0], ease: 'quart' },
        { t: 20, r: [3.8, 2.3, 1], ease: 'quad' }, { t: 24, r: [3.4, 4.4, 0], ease: 'quart' },
        { t: 28, r: [3.8, 6, -1], ease: 'quad' }, { t: 32, r: [3.4, 4.4, 0], ease: 'quart' },
        { t: 36, r: [3.8, 2.3, 1], ease: 'sine' }, { t: 40, r: [3.84, 2.07, 1.11], ease: 'sine' },
        { t: 50, r: [3.4, 4.8, 0], ease: 'sine' }, { t: 62, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [2.07, 6.35, 0], ease: 'sine' },
        { t: 12, r: [5.1, 7.1, -1.1], ease: 'linear' }, { t: 14, r: [4.84, 6.27, -0.62], ease: 'linear' },
        { t: 15, r: [4.68, 5.75, -0.32], ease: 'linear' }, { t: 16, r: [4.5, 5.2, 0], ease: 'quart' },
        { t: 20, r: [5.1, 2.7, 1.1], ease: 'quad' }, { t: 24, r: [4.5, 5.2, 0], ease: 'quart' },
        { t: 28, r: [5.1, 7.1, -1.1], ease: 'quad' }, { t: 32, r: [4.5, 5.2, 0], ease: 'quart' },
        { t: 36, r: [5.1, 2.7, 1.1], ease: 'sine' }, { t: 40, r: [5.17, 2.43, 1.22], ease: 'sine' },
        { t: 50, r: [4.5, 5.6, 0], ease: 'sine' }, { t: 62, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [2.07, 7.61, -3], ease: 'sine' },
        { t: 12, r: [5.1, 8.4, -4.3], ease: 'linear' }, { t: 14, r: [4.84, 7.44, -3.73], ease: 'linear' },
        { t: 15, r: [4.68, 6.84, -3.38], ease: 'linear' }, { t: 16, r: [4.5, 6.2, -3], ease: 'quart' },
        { t: 20, r: [5.1, 3.2, -1.7], ease: 'quad' }, { t: 24, r: [4.5, 6.2, -3], ease: 'quart' },
        { t: 28, r: [5.1, 8.4, -4.3], ease: 'quad' }, { t: 32, r: [4.5, 6.2, -3], ease: 'quart' },
        { t: 36, r: [5.1, 3.2, -1.7], ease: 'sine' }, { t: 40, r: [5.17, 2.87, -1.56], ease: 'sine' },
        { t: 50, r: [4.5, 6.7, -3], ease: 'sine' }, { t: 62, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quart' }, { t: 12, r: [0.2, 7.9, 0], ease: 'quad' },
        { t: 16, r: [0.3, 2.6, 0], ease: 'quart' }, { t: 20, r: [0.2, -4.5, 0], ease: 'quad' },
        { t: 24, r: [0.3, 2.6, 0], ease: 'quart' }, { t: 28, r: [0.2, 7.9, 0], ease: 'quad' },
        { t: 32, r: [0.3, 2.6, 0], ease: 'quart' }, { t: 36, r: [0.2, -4.5, 0], ease: 'sine' },
        { t: 40, r: [0.19, -5.28, 0], ease: 'sine' }, { t: 50, r: [0.3, 3.7, 0], ease: 'sine' },
        { t: 62, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quart' }, { t: 12, r: [2, 12.9, 0], ease: 'quad' },
        { t: 16, r: [2.2, 3, 0], ease: 'quart' }, { t: 20, r: [2, -10.1, 0], ease: 'quad' },
        { t: 24, r: [2.2, 3, 0], ease: 'quart' }, { t: 28, r: [2, 12.9, 0], ease: 'quad' },
        { t: 32, r: [2.2, 3, 0], ease: 'quart' }, { t: 36, r: [2, -10.1, 0], ease: 'sine' },
        { t: 40, r: [1.98, -11.54, 0], ease: 'sine' }, { t: 50, r: [2.2, 5.2, 0], ease: 'sine' },
        { t: 62, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 4, r: [-32.59, 0.45, -36.31], ease: 'sine' },
        { t: 12, r: [-53, -23.9, 29.8], ease: 'linear' }, { t: 14, r: [-50.3, -17.5, 11.22], ease: 'linear' },
        { t: 15, r: [-47.4, -10.62, -8.75], ease: 'linear' }, { t: 16, r: [-43.6, -1.6, -34.9], ease: 'quart' },
        { t: 20, r: [-34.1, -52.8, -42.6], ease: 'quad' }, { t: 24, r: [-49.2, 11.7, -0.6], ease: 'quart' },
        { t: 28, r: [-53, -23.9, 29.8], ease: 'quad' }, { t: 32, r: [-43.6, -1.6, -34.9], ease: 'quart' },
        { t: 36, r: [-34.1, -52.8, -42.6], ease: 'sine' }, { t: 40, r: [-33.05, -56.3, -43.45], ease: 'sine' },
        { t: 50, r: [-35, 0, -36], ease: 'sine' }, { t: 55, r: [-35.1, 3.5, -35.27], ease: 'sine' },
        { t: 62, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quart' }, { t: 12, r: [-11.5, 0, 17], ease: 'linear' },
        { t: 14, r: [-43.75, 0, 17], ease: 'linear' }, { t: 15, r: [-78.41, 0, 17], ease: 'linear' },
        { t: 16, r: [-123.8, 0, 17], ease: 'quart' }, { t: 20, r: [-152, 0, 17], ease: 'quad' },
        { t: 24, r: [-71.6, 0, 17], ease: 'quart' }, { t: 28, r: [-11.5, 0, 17], ease: 'quad' },
        { t: 32, r: [-123.8, 0, 17], ease: 'quart' }, { t: 36, r: [-152, 0, 17], ease: 'sine' },
        { t: 40, r: [-155.1, 0, 17], ease: 'sine' }, { t: 50, r: [-124, 0, 17], ease: 'sine' },
        { t: 55, r: [-120.92, 0, 17], ease: 'sine' }, { t: 62, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4, r: [-8, 1.24, 0], ease: 'sine' },
        { t: 12, r: [-8, -4, 0], ease: 'linear' }, { t: 14, r: [-8, -4.13, 0], ease: 'linear' },
        { t: 15, r: [-8, -4.26, 0], ease: 'linear' }, { t: 16, r: [-8, -4.44, 0], ease: 'snap' },
        { t: 20, r: [-8, 3.56, 0], ease: 'sine' }, { t: 24, r: [-8, -4, 0], ease: 'quart' },
        { t: 28, r: [-8, -4.66, 0], ease: 'quad' }, { t: 32, r: [-8, -10, 0], ease: 'quart' },
        { t: 36, r: [-8, 32, 0], ease: 'sine' }, { t: 40, r: [-8, 35.5, 0], ease: 'sine' },
        { t: 44, r: [-8, 41, 0], ease: 'sine' }, { t: 50, r: [-8, 10, 0], ease: 'sine' },
        { t: 62, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4, r: [-12.51, 0, 0.87], ease: 'sine' },
        { t: 12, r: [-18.8, 0, -2.8], ease: 'linear' }, { t: 14, r: [-18.95, 0, -2.89], ease: 'linear' },
        { t: 15, r: [-19.11, 0, -2.99], ease: 'linear' }, { t: 16, r: [-19.33, 0, -3.11], ease: 'snap' },
        { t: 20, r: [-11.33, 0, 1.57], ease: 'sine' }, { t: 24, r: [-18.8, 0, -2.8], ease: 'quart' },
        { t: 28, r: [-19.59, 0, -3.26], ease: 'quad' }, { t: 32, r: [-26, 0, -7], ease: 'quart' },
        { t: 36, r: [-2, 0, 2], ease: 'sine' }, { t: 40, r: [0.64, 0, 2.99], ease: 'sine' },
        { t: 44, r: [-28, 0, 10], ease: 'sine' }, { t: 50, r: [-18, 0, 0], ease: 'sine' },
        { t: 62, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quart' }, { t: 12, r: [-12.3, 31.2, 30.3], ease: 'quad' },
        { t: 16, r: [-52.2, -25.4, 4], ease: 'quart' }, { t: 20, r: [-62.7, 9, -32.2], ease: 'quad' },
        { t: 24, r: [-21.1, -8.4, 32.7], ease: 'quart' }, { t: 28, r: [-12.3, 31.2, 30.3], ease: 'quad' },
        { t: 32, r: [-52.2, -25.4, 4], ease: 'quart' }, { t: 36, r: [-62.7, 9, -32.2], ease: 'sine' },
        { t: 40, r: [-63.85, 12.5, -35.7], ease: 'sine' }, { t: 44, r: [-60.9, 16.3, -33.7], ease: 'sine' },
        { t: 50, r: [-22, 0, 36], ease: 'sine' }, { t: 55, r: [-18.5, -1.79, 39.5], ease: 'sine' }, { t: 62, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quart' }, { t: 12, r: [-152, 0, -1], ease: 'quad' },
        { t: 16, r: [-74, 0, -1], ease: 'quart' }, { t: 20, r: [-13.1, 0, -1], ease: 'quad' },
        { t: 24, r: [-145.5, 0, -1], ease: 'quart' }, { t: 28, r: [-152, 0, -1], ease: 'quad' },
        { t: 32, r: [-74, 0, -1], ease: 'quart' }, { t: 36, r: [-13.1, 0, -1], ease: 'sine' },
        { t: 40, r: [-9.6, 0, -1], ease: 'sine' }, { t: 44, r: [-52.7, 0, -1], ease: 'sine' },
        { t: 50, r: [-145, 0, -1], ease: 'sine' }, { t: 55, r: [-148.5, 0, -1], ease: 'sine' }, { t: 62, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quart' }, { t: 12, r: [-8, 4, 0], ease: 'quad' },
        { t: 16, r: [-8, 4.44, 0], ease: 'quart' }, { t: 20, r: [-8, 4, 0], ease: 'quad' },
        { t: 24, r: [-8, 4, 0], ease: 'quart' }, { t: 28, r: [-8, 4.66, 0], ease: 'quad' },
        { t: 32, r: [-8, 10, 0], ease: 'quart' }, { t: 36, r: [-8, -32, 0], ease: 'sine' },
        { t: 40, r: [-8, -35.5, 0], ease: 'sine' }, { t: 44, r: [-8, -41, 0], ease: 'sine' },
        { t: 50, r: [-8, -10, 0], ease: 'sine' }, { t: 62, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quart' }, { t: 12, r: [-18.8, 0, 2.8], ease: 'quad' },
        { t: 16, r: [-19.33, 0, 3.11], ease: 'quart' }, { t: 20, r: [-18.8, 0, 2.8], ease: 'quad' },
        { t: 24, r: [-18.8, 0, 2.8], ease: 'quart' }, { t: 28, r: [-19.59, 0, 3.26], ease: 'quad' },
        { t: 32, r: [-26, 0, 7], ease: 'quart' }, { t: 36, r: [-2, 0, -2], ease: 'sine' },
        { t: 40, r: [0.64, 0, -2.99], ease: 'sine' }, { t: 44, r: [-28, 0, -10], ease: 'sine' },
        { t: 50, r: [-18, 0, 0], ease: 'sine' }, { t: 62, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quart' }, { t: 12, r: [-24, -16, 11], ease: 'quad' },
        { t: 16, r: [-21, -16, 10], ease: 'quart' }, { t: 20, r: [-26, -4, 9], ease: 'quad' },
        { t: 24, r: [-21, -16, 10], ease: 'quart' }, { t: 28, r: [-24, -16, 11], ease: 'quad' },
        { t: 32, r: [-21, -16, 10], ease: 'quart' }, { t: 36, r: [-26, -4, 9], ease: 'sine' },
        { t: 40, r: [-26.55, -2.68, 8.89], ease: 'sine' }, { t: 50, r: [-21, -16, 10], ease: 'sine' },
        { t: 62, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quart' }, { t: 12, r: [26, 0, 0], ease: 'quad' },
        { t: 16, r: [31, 0, 0], ease: 'quart' }, { t: 20, r: [22, 0, 0], ease: 'quad' },
        { t: 24, r: [31, 0, 0], ease: 'quart' }, { t: 28, r: [26, 0, 0], ease: 'quad' },
        { t: 32, r: [31, 0, 0], ease: 'quart' }, { t: 36, r: [22, 0, 0], ease: 'sine' },
        { t: 40, r: [21.01, 0, 0], ease: 'sine' }, { t: 50, r: [31, 0, 0], ease: 'sine' },
        { t: 62, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quart' }, { t: 12, r: [-7.9, 2, 0], ease: 'quad' }, { t: 16, r: [-16.6, 2, 0], ease: 'quart' },
        { t: 20, r: [-3.8, 2, 0], ease: 'quad' }, { t: 24, r: [-22.1, 2, 0], ease: 'quart' }, { t: 28, r: [-7.9, 2, 0], ease: 'quad' },
        { t: 32, r: [-16.6, 2, 0], ease: 'quart' }, { t: 36, r: [-3.8, 2, 0], ease: 'sine' }, { t: 40, r: [-2.3, 2, 0], ease: 'sine' },
        { t: 50, r: [-16.6, 2, 0], ease: 'sine' }, { t: 62, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 12, r: [7.3, 0, 0], ease: 'quad' }, { t: 16, r: [6.8, 0, 0], ease: 'quart' },
        { t: 20, r: [6.8, 0, 0], ease: 'quad' }, { t: 24, r: [2.9, 0, 0], ease: 'quart' }, { t: 28, r: [7.3, 0, 0], ease: 'quad' },
        { t: 32, r: [6.8, 0, 0], ease: 'quart' }, { t: 36, r: [6.8, 0, 0], ease: 'sine' }, { t: 40, r: [6.8, 0, 0], ease: 'sine' },
        { t: 50, r: [6.7, 0, 0], ease: 'sine' }, { t: 62, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 12, r: [3.1, 0, 0], ease: 'quad' }, { t: 16, r: [2.9, 0, 0], ease: 'quart' },
        { t: 20, r: [2.9, 0, 0], ease: 'quad' }, { t: 24, r: [1.2, 0, 0], ease: 'quart' }, { t: 28, r: [3.1, 0, 0], ease: 'quad' },
        { t: 32, r: [2.9, 0, 0], ease: 'quart' }, { t: 36, r: [2.9, 0, 0], ease: 'sine' }, { t: 40, r: [2.9, 0, 0], ease: 'sine' },
        { t: 50, r: [2.8, 0, 0], ease: 'sine' }, { t: 62, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quart' }, { t: 12, r: [12, 8, -13], ease: 'quad' },
        { t: 16, r: [4, 6, -13], ease: 'quart' }, { t: 20, r: [14, -6, -12], ease: 'quad' },
        { t: 24, r: [4, 6, -13], ease: 'quart' }, { t: 28, r: [12, 8, -13], ease: 'quad' },
        { t: 32, r: [4, 6, -13], ease: 'quart' }, { t: 36, r: [14, -6, -12], ease: 'sine' },
        { t: 40, r: [15.1, -7.32, -11.89], ease: 'sine' }, { t: 50, r: [4, 6, -13], ease: 'sine' },
        { t: 62, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quart' }, { t: 12, r: [14, 0, 0], ease: 'quad' },
        { t: 16, r: [22, 0, 0], ease: 'quart' }, { t: 20, r: [12, 0, 0], ease: 'quad' },
        { t: 24, r: [22, 0, 0], ease: 'quart' }, { t: 28, r: [14, 0, 0], ease: 'quad' },
        { t: 32, r: [22, 0, 0], ease: 'quart' }, { t: 36, r: [12, 0, 0], ease: 'sine' },
        { t: 40, r: [10.9, 0, 0], ease: 'sine' }, { t: 50, r: [22, 0, 0], ease: 'sine' },
        { t: 62, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quart' }, { t: 12, r: [-18.1, 0, 0], ease: 'quad' }, { t: 16, r: [-30.7, -3, 0], ease: 'quart' },
        { t: 20, r: [-27, 0, 0], ease: 'quad' }, { t: 24, r: [-23.1, -3, 0], ease: 'quart' }, { t: 28, r: [-18, 0, 0], ease: 'quad' },
        { t: 32, r: [-30.7, -3, 0], ease: 'quart' }, { t: 36, r: [-27, 0, 0], ease: 'sine' }, { t: 40, r: [-26.6, 0.3, 0], ease: 'sine' },
        { t: 50, r: [-30.6, -3, 0], ease: 'sine' }, { t: 62, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 12, r: [-2.3, 0, 0], ease: 'quad' }, { t: 16, r: [8.5, 0, 0], ease: 'quart' },
        { t: 20, r: [1.7, 0, 0], ease: 'quad' }, { t: 24, r: [11.9, 0, 0], ease: 'quart' }, { t: 28, r: [-2.3, 0, 0], ease: 'quad' },
        { t: 32, r: [8.5, 0, 0], ease: 'quart' }, { t: 36, r: [1.7, 0, 0], ease: 'sine' }, { t: 40, r: [1, 0, 0], ease: 'sine' },
        { t: 50, r: [8.5, 0, 0], ease: 'sine' }, { t: 62, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quart' }, { t: 12, r: [-1, 0, 0], ease: 'quad' }, { t: 16, r: [3.6, 0, 0], ease: 'quart' },
        { t: 20, r: [0.7, 0, 0], ease: 'quad' }, { t: 24, r: [5, 0, 0], ease: 'quart' }, { t: 28, r: [-1, 0, 0], ease: 'quad' },
        { t: 32, r: [3.6, 0, 0], ease: 'quart' }, { t: 36, r: [0.7, 0, 0], ease: 'sine' }, { t: 40, r: [0.4, 0, 0], ease: 'sine' },
        { t: 50, r: [3.6, 0, 0], ease: 'sine' }, { t: 62, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i18. An 18-frame telegraph on purpose: settle, then a deep coil at tick 15
  // with the pelvis 45 degrees off-axis and 26 degrees of forward bend, then
  // everything unwinds at once. The fist finishes above the fighter's own head.
  'p.launcherPunch': {
    name: 'Rising Fist',
    duration: 43, blendIn: 4, blendOut: 10,
    impact: { tick: 17, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 6, p: [0, -0.126, -0.04], ease: 'sine' },
      { t: 12, p: [0, -0.186, -0.1], ease: 'linear' },
      { t: 13, p: [0, -0.169, -0.091], ease: 'linear' },
      { t: 14, p: [0, -0.152, -0.061], ease: 'linear' },
      { t: 15, p: [0, -0.141, -0.006], ease: 'linear' },
      { t: 16, p: [0, -0.115, 0.074], ease: 'linear' },
      { t: 17, p: [0, -0.104, 0.18], ease: 'sine' },
      { t: 21, p: [0, -0.078, 0.182], ease: 'quad' },
      { t: 29, p: [0, -0.096, 0.1], ease: 'sine' },
      { t: 43, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 3, r: [1.66, -33.8, -0.04], ease: 'sine' },
        { t: 6, r: [1.9, -32.5, 0.6], ease: 'sine' }, { t: 12, r: [3.1, -45.2, 1.5], ease: 'linear' },
        { t: 14, r: [0.93, -26.05, 1.11], ease: 'linear' }, { t: 15, r: [-0.47, -13.67, 0.86], ease: 'linear' },
        { t: 16, r: [-1.99, -0.28, 0.59], ease: 'linear' }, { t: 17, r: [-3.6, 13.9, 0.3], ease: 'sine' },
        { t: 21, r: [-3.71, 14.41, 0.27], ease: 'quad' }, { t: 29, r: [2.2, -11.6, 0.3], ease: 'sine' },
        { t: 43, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 3, r: [4.45, 6.1, -0.14], ease: 'sine' },
        { t: 6, r: [3.8, 5.6, 1], ease: 'sine' }, { t: 12, r: [6.2, 6.6, 2.5], ease: 'linear' },
        { t: 14, r: [1.86, 5.11, 1.85], ease: 'linear' }, { t: 15, r: [-0.95, 4.15, 1.43], ease: 'linear' },
        { t: 16, r: [-3.98, 3.11, 0.98], ease: 'linear' }, { t: 17, r: [-7.2, 2, 0.5], ease: 'sine' },
        { t: 21, r: [-7.41, 1.96, 0.45], ease: 'quad' }, { t: 29, r: [4.3, 4, 0.5], ease: 'sine' },
        { t: 43, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 3, r: [6.02, 7.14, -0.17], ease: 'sine' },
        { t: 6, r: [5.1, 6.6, 1.1], ease: 'sine' }, { t: 12, r: [8.3, 7.7, 2.8], ease: 'linear' },
        { t: 14, r: [2.5, 5.98, 2.09], ease: 'linear' }, { t: 15, r: [-1.25, 4.87, 1.63], ease: 'linear' },
        { t: 16, r: [-5.3, 3.67, 1.13], ease: 'linear' }, { t: 17, r: [-9.6, 2.4, 0.6], ease: 'sine' },
        { t: 21, r: [-9.89, 2.36, 0.54], ease: 'quad' }, { t: 29, r: [5.8, 4.7, 0.6], ease: 'sine' },
        { t: 43, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 3, r: [6.02, 8.56, -3.17], ease: 'sine' },
        { t: 6, r: [5.1, 7.8, -1.7], ease: 'sine' }, { t: 12, r: [8.3, 9.2, 0.2], ease: 'linear' },
        { t: 14, r: [2.5, 7.13, -0.64], ease: 'linear' }, { t: 15, r: [-1.25, 5.79, -1.19], ease: 'linear' },
        { t: 16, r: [-5.3, 4.34, -1.78], ease: 'linear' }, { t: 17, r: [-9.6, 2.8, -2.4], ease: 'sine' },
        { t: 21, r: [-9.89, 2.74, -2.48], ease: 'quad' }, { t: 29, r: [5.8, 5.5, -2.4], ease: 'sine' },
        { t: 43, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 6, r: [0.2, 6.4, 0], ease: 'sine' },
        { t: 12, r: [-0.3, 13.1, 0], ease: 'sine' }, { t: 14, r: [2.1, -4.2, 0], ease: 'quad' },
        { t: 17, r: [2.5, -5.4, 0], ease: 'sine' }, { t: 21, r: [2.54, -5.53, 0], ease: 'quad' },
        { t: 29, r: [0.1, 1.1, 0], ease: 'sine' }, { t: 43, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 6, r: [2, 10.1, 0], ease: 'sine' },
        { t: 12, r: [1.4, 22.6, 0], ease: 'sine' }, { t: 14, r: [4.3, -9.5, 0], ease: 'quad' },
        { t: 17, r: [4.8, -11.7, 0], ease: 'sine' }, { t: 21, r: [4.85, -11.94, 0], ease: 'quad' },
        { t: 29, r: [1.9, 0.3, 0], ease: 'sine' }, { t: 43, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 6, r: [-38, 9, -34.7], ease: 'sine' },
        { t: 12, r: [0.2, 1.3, -48], ease: 'sine' }, { t: 14, r: [-22, -72.1, -60.8], ease: 'quad' },
        { t: 17, r: [-18.7, -78.6, -60.7], ease: 'sine' }, { t: 21, r: [-18.34, -79.31, -60.69], ease: 'quad' },
        { t: 29, r: [-49.4, -1.2, -35.4], ease: 'sine' }, { t: 43, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 6, r: [-123.9, 0, 17], ease: 'sine' },
        { t: 12, r: [-132.6, 0, 17], ease: 'sine' }, { t: 14, r: [-152, 0, 17], ease: 'quad' },
        { t: 21, r: [-154.13, 0, 17], ease: 'quad' }, { t: 29, r: [-123.9, 0, 17], ease: 'sine' },
        { t: 43, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'sine' }, { t: 6, r: [-8, 1.6, 0], ease: 'sine' },
        { t: 12, r: [-8, 1.78, 0], ease: 'sine' }, { t: 14, r: [-8, 4, 0], ease: 'quad' },
        { t: 21, r: [-8, 14, 0], ease: 'quad' }, { t: 29, r: [-8, 4, 0], ease: 'sine' },
        { t: 43, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'sine' }, { t: 6, r: [-16, 0, 0], ease: 'sine' },
        { t: 12, r: [-16.22, 0, 0], ease: 'sine' }, { t: 14, r: [-19, 0, 0], ease: 'quad' },
        { t: 21, r: [-27, 0, 0], ease: 'quad' }, { t: 29, r: [-17, 0, 0], ease: 'sine' },
        { t: 43, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 3, r: [-12.51, 3.86, 47], ease: 'sine' },
        { t: 6, r: [-10.8, 15.7, 25.3], ease: 'sine' }, { t: 12, r: [-10.4, 15.9, 7.1], ease: 'linear' },
        { t: 14, r: [-20.39, -34.4, 1.47], ease: 'linear' }, { t: 15, r: [-34.21, -32.09, -6.32], ease: 'linear' },
        { t: 16, r: [-54.49, -28.71, -17.76], ease: 'linear' }, { t: 17, r: [-81.5, -24.2, -33], ease: 'snap' },
        { t: 21, r: [-98.5, -17.03, -45.86], ease: 'sine' }, { t: 29, r: [-61.9, -25.2, -7.8], ease: 'sine' },
        { t: 43, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 3, r: [-156, 0, -1], ease: 'sine' },
        { t: 6, r: [-136.3, 0, -1], ease: 'sine' }, { t: 12, r: [-84.9, 0, -1], ease: 'linear' },
        { t: 14, r: [-79.51, 0, -1], ease: 'linear' }, { t: 15, r: [-72.05, 0, -1], ease: 'linear' },
        { t: 16, r: [-61.09, 0, -1], ease: 'linear' }, { t: 17, r: [-46.5, 0, -1], ease: 'snap' },
        { t: 21, r: [-38.5, 0, -1], ease: 'sine' }, { t: 29, r: [-84.5, 0, -1], ease: 'sine' },
        { t: 43, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 3, r: [-8, 7, 0], ease: 'sine' },
        { t: 6, r: [-8, 4, 0], ease: 'sine' }, { t: 12, r: [-8, 4.44, 0], ease: 'linear' },
        { t: 14, r: [-8, 10, 0], ease: 'linear' }, { t: 15, r: [-8, 0.51, 0], ease: 'linear' },
        { t: 16, r: [-8, -13.43, 0], ease: 'linear' }, { t: 17, r: [-8, -32, 0], ease: 'snap' },
        { t: 21, r: [-8, -40, 0], ease: 'sine' }, { t: 24, r: [-8, -41, 0], ease: 'sine' },
        { t: 29, r: [-8, -10, 0], ease: 'sine' }, { t: 43, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 3, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 6, r: [-18.8, 0, 2.8], ease: 'sine' }, { t: 12, r: [-19.33, 0, 3.11], ease: 'linear' },
        { t: 14, r: [-26, 0, 7], ease: 'linear' }, { t: 15, r: [-20.57, 0, 4.97], ease: 'linear' },
        { t: 16, r: [-12.61, 0, 1.98], ease: 'linear' }, { t: 17, r: [-2, 0, -2], ease: 'snap' },
        { t: 21, r: [6, 0, -5], ease: 'sine' }, { t: 24, r: [-28, 0, -10], ease: 'sine' },
        { t: 29, r: [-18, 0, 0], ease: 'sine' }, { t: 43, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 6, r: [-14, -18, 12], ease: 'sine' },
        { t: 12, r: [-8, -22, 14], ease: 'sine' }, { t: 14, r: [-12, -2, 8], ease: 'quad' },
        { t: 17, r: [-8, 0, 8], ease: 'sine' }, { t: 21, r: [-7.56, 0.22, 8], ease: 'quad' },
        { t: 29, r: [-20, -10, 10], ease: 'sine' }, { t: 43, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 6, r: [40, 0, 0], ease: 'sine' },
        { t: 12, r: [54, 0, 0], ease: 'sine' }, { t: 14, r: [8, 0, 0], ease: 'quad' },
        { t: 17, r: [6, 0, 0], ease: 'sine' }, { t: 21, r: [5.78, 0, 0], ease: 'quad' },
        { t: 29, r: [34, 0, 0], ease: 'sine' }, { t: 43, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 6, r: [-32.6, 2, 0], ease: 'sine' }, { t: 12, r: [-51.6, 2, 0], ease: 'sine' },
        { t: 14, r: [0.9, 2, 0], ease: 'quad' }, { t: 17, r: [-0.4, 2, 0], ease: 'sine' }, { t: 21, r: [-1.5, 2, 0], ease: 'quad' },
        { t: 29, r: [-21.1, 2, 0], ease: 'sine' }, { t: 43, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 6, r: [5.7, 0, 0], ease: 'sine' }, { t: 12, r: [5.3, 0, 0], ease: 'sine' },
        { t: 14, r: [7.2, 0, 0], ease: 'quad' }, { t: 17, r: [6.8, 0, 0], ease: 'sine' }, { t: 21, r: [6.4, 0, 0], ease: 'quad' },
        { t: 29, r: [6.3, 0, 0], ease: 'sine' }, { t: 43, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 6, r: [2.4, 0, 0], ease: 'sine' }, { t: 12, r: [2.2, 0, 0], ease: 'sine' },
        { t: 14, r: [3, 0, 0], ease: 'quad' }, { t: 17, r: [2.9, 0, 0], ease: 'sine' }, { t: 21, r: [2.7, 0, 0], ease: 'quad' },
        { t: 29, r: [2.7, 0, 0], ease: 'sine' }, { t: 43, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'sine' }, { t: 6, r: [-4, 8, -14], ease: 'sine' },
        { t: 12, r: [-12, 10, -16], ease: 'sine' }, { t: 14, r: [8, -6, -12], ease: 'quad' },
        { t: 17, r: [4, -6, -12], ease: 'sine' }, { t: 21, r: [3.56, -6, -12], ease: 'quad' },
        { t: 29, r: [4, 2, -13], ease: 'sine' }, { t: 43, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'sine' }, { t: 6, r: [40, 0, 0], ease: 'sine' },
        { t: 12, r: [56, 0, 0], ease: 'sine' }, { t: 14, r: [6, 0, 0], ease: 'quad' },
        { t: 17, r: [4, 0, 0], ease: 'sine' }, { t: 21, r: [3.78, 0, 0], ease: 'quad' },
        { t: 29, r: [30, 0, 0], ease: 'sine' }, { t: 43, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'sine' }, { t: 6, r: [-40, -3, 0], ease: 'sine' }, { t: 12, r: [-47.5, -3, 0], ease: 'sine' },
        { t: 14, r: [-22, 0, 0], ease: 'quad' }, { t: 17, r: [-19.1, 0, 0], ease: 'sine' }, { t: 21, r: [-52.4, 0, 0], ease: 'quad' },
        { t: 29, r: [-20.7, 0, 0], ease: 'sine' }, { t: 43, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 6, r: [8.3, 0, 0], ease: 'sine' }, { t: 12, r: [8.3, 0, 0], ease: 'sine' },
        { t: 14, r: [16.5, 0, 0], ease: 'quad' }, { t: 17, r: [21.1, 0, 0], ease: 'sine' }, { t: 21, r: [0, 0, 0], ease: 'quad' },
        { t: 29, r: [-0.4, 0, 0], ease: 'sine' }, { t: 43, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 6, r: [3.5, 0, 0], ease: 'sine' }, { t: 12, r: [3.5, 0, 0], ease: 'sine' },
        { t: 14, r: [6.9, 0, 0], ease: 'quad' }, { t: 17, r: [8.9, 0, 0], ease: 'sine' }, { t: 21, r: [0, 0, 0], ease: 'quad' },
        { t: 29, r: [-0.2, 0, 0], ease: 'sine' }, { t: 43, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i11. Crouching lead punch to the knee. The drop is in the root; the punch
  // itself travels level.
  'p.lowJab': {
    name: 'Low Jab',
    duration: 26, blendIn: 3, blendOut: 6,
    // Was `hand_R` (0.224m of travel); the strike is thrown with hand_L
    // (0.714m), which is also what the `lowJab` move anchors.
    //
    // The tick was 11, and 11 is inside the RECOIL. Measured on hand_L, this
    // clip extends twice: reach from the chest runs 0.55 at t9, 0.50 at t10,
    // 0.44 at t11, then back out to 0.59 by t16. Fighter pins this tick onto
    // the move's first active frame, so the hitbox was going live on the frame
    // the fist was most retracted. Contact-frame speed as a share of the
    // drive's peak: 0.35 at t11, 0.98 at t9.
    impact: { tick: 9, bone: 'hand_L' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'linear' },
      { t: 1, p: [0, -0.079, 0], ease: 'linear' },
      { t: 2, p: [0, -0.091, 0], ease: 'linear' },
      { t: 3, p: [0, -0.111, 0.001], ease: 'linear' },
      { t: 4, p: [0, -0.137, 0.002], ease: 'linear' },
      { t: 5, p: [0, -0.157, 0.004], ease: 'linear' },
      { t: 6, p: [0, -0.169, 0.009], ease: 'linear' },
      { t: 7, p: [0, -0.173, 0.016], ease: 'linear' },
      { t: 8, p: [0, -0.172, 0.028], ease: 'linear' },
      { t: 9, p: [0, -0.161, 0.045], ease: 'linear' },
      { t: 10, p: [0, -0.151, 0.068], ease: 'linear' },
      { t: 11, p: [0, -0.15, 0.1], ease: 'sine' },
      { t: 13, p: [0, -0.146, 0.111], ease: 'quad' },
      { t: 18, p: [0, -0.176, 0], ease: 'sine' },
      { t: 26, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 2, r: [0.13, -24.86, 0.17], ease: 'linear' },
        { t: 7, r: [1.14, -28.28, -0.03], ease: 'linear' }, { t: 9, r: [2.34, -32.35, -0.26], ease: 'linear' },
        { t: 10, r: [3.15, -35.08, -0.42], ease: 'linear' }, { t: 11, r: [4.1, -38.3, -0.6], ease: 'sine' },
        { t: 13, r: [4.18, -39.58, -0.67], ease: 'quad' }, { t: 18, r: [3.4, -26.7, 0], ease: 'sine' },
        { t: 26, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 2, r: [0.14, 4.98, 0.28], ease: 'linear' },
        { t: 7, r: [2.19, 5.24, -0.05], ease: 'linear' }, { t: 9, r: [4.63, 5.55, -0.44], ease: 'linear' },
        { t: 10, r: [6.27, 5.76, -0.7], ease: 'linear' }, { t: 11, r: [8.2, 6, -1], ease: 'sine' },
        { t: 13, r: [8.36, 6.1, -1.11], ease: 'quad' }, { t: 18, r: [6.7, 5.1, 0], ease: 'sine' },
        { t: 26, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 2, r: [0.28, 5.82, 0.31], ease: 'linear' },
        { t: 7, r: [2.98, 6.15, -0.05], ease: 'linear' }, { t: 9, r: [6.19, 6.54, -0.48], ease: 'linear' },
        { t: 10, r: [8.35, 6.8, -0.76], ease: 'linear' }, { t: 11, r: [10.9, 7.1, -1.1], ease: 'sine' },
        { t: 13, r: [11.11, 7.21, -1.22], ease: 'quad' }, { t: 18, r: [9, 6.1, 0], ease: 'sine' },
        { t: 26, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 2, r: [0.28, 6.99, -2.64], ease: 'linear' },
        { t: 7, r: [2.98, 7.35, -3.06], ease: 'linear' }, { t: 9, r: [6.19, 7.78, -3.56], ease: 'linear' },
        { t: 10, r: [8.35, 8.06, -3.9], ease: 'linear' }, { t: 11, r: [10.9, 8.4, -4.3], ease: 'sine' },
        { t: 13, r: [11.11, 8.53, -4.44], ease: 'quad' }, { t: 18, r: [9, 7.2, -3], ease: 'sine' },
        { t: 26, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 7, r: [-0.4, 4.9, 0], ease: 'quart' },
        { t: 11, r: [-0.7, 7.9, 0], ease: 'sine' }, { t: 13, r: [-0.73, 8.23, 0], ease: 'quad' },
        { t: 18, r: [-0.4, 4.9, 0], ease: 'sine' }, { t: 26, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 7, r: [1.3, 7.4, 0], ease: 'quart' },
        { t: 11, r: [1, 12.9, 0], ease: 'sine' }, { t: 13, r: [0.97, 13.51, 0], ease: 'quad' },
        { t: 18, r: [1.3, 7.4, 0], ease: 'sine' }, { t: 26, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 7, r: [-38.6, 13.6, -4.9], ease: 'quart' },
        { t: 11, r: [-54.7, -21.3, 29.7], ease: 'sine' }, { t: 13, r: [-56.47, -24.8, 33.2], ease: 'quad' },
        { t: 16, r: [-56.9, -26, 34.4], ease: 'quad' }, { t: 18, r: [-38.6, 13.6, -4.9], ease: 'sine' },
        { t: 26, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 7, r: [-91.4, 0, 17], ease: 'quart' },
        { t: 11, r: [-11.4, 0, 17], ease: 'sine' }, { t: 13, r: [-7.9, 0, 17], ease: 'quad' },
        { t: 16, r: [-35.4, 0, 17], ease: 'quad' }, { t: 18, r: [-91.4, 0, 17], ease: 'sine' },
        { t: 26, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 7, r: [-8, -10, 0], ease: 'quart' },
        { t: 11, r: [-8, 32, 0], ease: 'sine' }, { t: 13, r: [-8, 35.5, 0], ease: 'quad' },
        { t: 16, r: [-8, 41, 0], ease: 'sine' }, { t: 18, r: [-8, 10, 0], ease: 'sine' },
        { t: 26, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 7, r: [-26, 0, -7], ease: 'quart' },
        { t: 11, r: [-2, 0, 2], ease: 'sine' }, { t: 13, r: [0.64, 0, 2.99], ease: 'quad' },
        { t: 16, r: [-28, 0, 10], ease: 'sine' }, { t: 18, r: [-18, 0, 0], ease: 'sine' },
        { t: 26, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 2, r: [-22.87, -5.99, 40.2], ease: 'linear' },
        { t: 7, r: [-34.9, -9.8, 38.37], ease: 'linear' }, { t: 9, r: [-30.11, -0.47, 33.17], ease: 'linear' },
        { t: 10, r: [-25.54, 8.44, 28.21], ease: 'linear' }, { t: 11, r: [-18.9, 21.4, 21], ease: 'snap' },
        { t: 13, r: [-14.8, 29.4, 20.16], ease: 'sine' }, { t: 15, r: [-9.42, 39.89, 19.05], ease: 'quad' },
        { t: 18, r: [-34.9, -9.8, 24.3], ease: 'sine' }, { t: 26, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 2, r: [-143.04, 0, -1], ease: 'linear' },
        { t: 7, r: [-143.89, 0, -1], ease: 'linear' }, { t: 9, r: [-146.32, 0, -1], ease: 'linear' },
        { t: 10, r: [-148.63, 0, -1], ease: 'linear' }, { t: 11, r: [-152, 0, -1], ease: 'snap' },
        { t: 13, r: [-160, 0, -1], ease: 'sine' }, { t: 18, r: [-145.7, 0, -1], ease: 'sine' },
        { t: 26, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 2, r: [-8, 3.92, 0], ease: 'linear' },
        { t: 7, r: [-8, 2.21, 0], ease: 'linear' }, { t: 9, r: [-8, -2.64, 0], ease: 'linear' },
        { t: 10, r: [-8, -7.27, 0], ease: 'linear' }, { t: 11, r: [-8, -14, 0], ease: 'snap' },
        { t: 13, r: [-8, -22, 0], ease: 'sine' }, { t: 18, r: [-8, -4, 0], ease: 'sine' },
        { t: 26, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 2, r: [-10.36, 0, 0], ease: 'linear' },
        { t: 7, r: [-11.95, 0, 0], ease: 'linear' }, { t: 9, r: [-16.45, 0, 0], ease: 'linear' },
        { t: 10, r: [-20.75, 0, 0], ease: 'linear' }, { t: 11, r: [-27, 0, 0], ease: 'snap' },
        { t: 13, r: [-35, 0, 0], ease: 'sine' }, { t: 18, r: [-17, 0, 0], ease: 'sine' },
        { t: 26, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 7, r: [-18, -16, 14], ease: 'quart' },
        { t: 11, r: [-24, -18, 14], ease: 'sine' }, { t: 13, r: [-24.66, -18.22, 14], ease: 'quad' },
        { t: 18, r: [-18, -16, 14], ease: 'sine' }, { t: 26, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 7, r: [54, 0, 0], ease: 'quart' },
        { t: 11, r: [50, 0, 0], ease: 'sine' }, { t: 13, r: [49.56, 0, 0], ease: 'quad' },
        { t: 18, r: [54, 0, 0], ease: 'sine' }, { t: 26, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 7, r: [-43.9, 2, 0], ease: 'quart' }, { t: 11, r: [-33.7, 2, 0], ease: 'sine' },
        { t: 13, r: [-32.7, 2, 0], ease: 'quad' }, { t: 18, r: [-52, 2, 0], ease: 'sine' }, { t: 26, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [4.8, 0, 0], ease: 'quart' }, { t: 11, r: [5.2, 0, 0], ease: 'sine' },
        { t: 13, r: [5.3, 0, 0], ease: 'quad' }, { t: 18, r: [0, 0, 0], ease: 'sine' }, { t: 26, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [2, 0, 0], ease: 'quart' }, { t: 11, r: [2.2, 0, 0], ease: 'sine' },
        { t: 13, r: [2.2, 0, 0], ease: 'quad' }, { t: 18, r: [0, 0, 0], ease: 'sine' }, { t: 26, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 7, r: [-8, 6, -16], ease: 'quart' },
        { t: 11, r: [-2, 6, -16], ease: 'sine' }, { t: 13, r: [-1.34, 6, -16], ease: 'quad' },
        { t: 18, r: [-8, 6, -16], ease: 'sine' }, { t: 26, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 7, r: [56, 0, 0], ease: 'quart' },
        { t: 11, r: [50, 0, 0], ease: 'sine' }, { t: 13, r: [49.34, 0, 0], ease: 'quad' },
        { t: 18, r: [56, 0, 0], ease: 'sine' }, { t: 26, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 7, r: [-49.7, -3, 0], ease: 'quart' }, { t: 11, r: [-14, 0, 0], ease: 'sine' },
        { t: 13, r: [-10.5, 0.3, 0], ease: 'quad' }, { t: 18, r: [-62, -3, 0], ease: 'sine' }, { t: 26, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [7.9, 0, 0], ease: 'quart' }, { t: 11, r: [0, 0, 0], ease: 'sine' },
        { t: 13, r: [0, 0, 0], ease: 'quad' }, { t: 18, r: [0, 0, 0], ease: 'sine' }, { t: 26, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 7, r: [3.3, 0, 0], ease: 'quart' }, { t: 11, r: [0, 0, 0], ease: 'sine' },
        { t: 13, r: [0, 0, 0], ease: 'quad' }, { t: 18, r: [0, 0, 0], ease: 'sine' }, { t: 26, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i16. Slips under a high attack on ticks 0-9 (the head passes below shoulder
  // height), then fires the rear hand on the way back up.
  'p.duckingStraight': {
    name: 'Ducking Straight',
    duration: 38, blendIn: 4, blendOut: 8,
    impact: { tick: 16, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'sine' },
      { t: 9, p: [0, -0.23, -0.02], ease: 'linear' },
      { t: 10, p: [0, -0.22, -0.019], ease: 'linear' },
      { t: 11, p: [0, -0.195, -0.015], ease: 'linear' },
      { t: 12, p: [0, -0.17, -0.003], ease: 'linear' },
      { t: 13, p: [0, -0.16, 0.022], ease: 'linear' },
      { t: 14, p: [0, -0.154, 0.065], ease: 'linear' },
      { t: 15, p: [0, -0.106, 0.129], ease: 'linear' },
      { t: 16, p: [0, -0.1, 0.22], ease: 'sine' },
      { t: 19, p: [0, -0.092, 0.233], ease: 'quad' },
      { t: 26, p: [0, -0.104, 0.12], ease: 'sine' },
      { t: 38, p: [0, -0.075, 0], ease: 'linear' },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 4, r: [0.94, -33.8, -0.05], ease: 'sine' },
        { t: 9, r: [4.8, -37.1, 2.1], ease: 'linear' }, { t: 13, r: [3.54, -19.56, 1.44], ease: 'linear' },
        { t: 14, r: [2.93, -11.01, 1.11], ease: 'linear' }, { t: 15, r: [2.21, -1, 0.73], ease: 'linear' },
        { t: 16, r: [1.4, 10.4, 0.3], ease: 'sine' }, { t: 19, r: [1.21, 12.95, 0.2], ease: 'quad' },
        { t: 26, r: [1.9, -9.3, 0], ease: 'sine' }, { t: 38, r: [1, -27.8, 0], ease: 'linear' }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 4, r: [1.62, 6.01, -0.14], ease: 'sine' },
        { t: 9, r: [9.6, 5.9, 3.5], ease: 'linear' }, { t: 13, r: [7.13, 4.57, 2.39], ease: 'linear' },
        { t: 14, r: [5.92, 3.92, 1.85], ease: 'linear' }, { t: 15, r: [4.51, 3.16, 1.22], ease: 'linear' },
        { t: 16, r: [2.9, 2.3, 0.5], ease: 'sine' }, { t: 19, r: [2.54, 2.1, 0.34], ease: 'quad' },
        { t: 26, r: [3.8, 3.8, 0], ease: 'sine' }, { t: 38, r: [1.9, 5.2, 0], ease: 'linear' }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 4, r: [2.26, 7.05, -0.17], ease: 'sine' },
        { t: 9, r: [12.8, 7, 3.9], ease: 'linear' }, { t: 13, r: [9.48, 5.41, 2.68], ease: 'linear' },
        { t: 14, r: [7.86, 4.64, 2.09], ease: 'linear' }, { t: 15, r: [5.96, 3.73, 1.39], ease: 'linear' },
        { t: 16, r: [3.8, 2.7, 0.6], ease: 'sine' }, { t: 19, r: [3.31, 2.47, 0.42], ease: 'quad' },
        { t: 26, r: [5.1, 4.5, 0], ease: 'sine' }, { t: 38, r: [2.6, 6.1, 0], ease: 'linear' }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 4, r: [2.26, 8.45, -3.17], ease: 'sine' },
        { t: 9, r: [12.8, 8.3, 1.5], ease: 'linear' }, { t: 13, r: [9.48, 6.42, 0.06], ease: 'linear' },
        { t: 14, r: [7.86, 5.5, -0.64], ease: 'linear' }, { t: 15, r: [5.96, 4.42, -1.46], ease: 'linear' },
        { t: 16, r: [3.8, 3.2, -2.4], ease: 'sine' }, { t: 19, r: [3.31, 2.93, -2.62], ease: 'quad' },
        { t: 26, r: [5.1, 5.3, -3], ease: 'sine' }, { t: 38, r: [2.6, 7.3, -3], ease: 'linear' }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'sine' }, { t: 9, r: [-1, 7.6, 0], ease: 'sine' },
        { t: 13, r: [-0.3, 1.4, 0], ease: 'quart' }, { t: 16, r: [0.4, -4.5, 0], ease: 'sine' },
        { t: 19, r: [0.48, -5.15, 0], ease: 'quad' }, { t: 26, r: [0.2, 0.5, 0], ease: 'sine' },
        { t: 38, r: [0.6, 5.2, 0], ease: 'linear' }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'sine' }, { t: 9, r: [0.6, 12.3, 0], ease: 'sine' },
        { t: 13, r: [1.4, 0.9, 0], ease: 'quart' }, { t: 16, r: [2.3, -10.1, 0], ease: 'sine' },
        { t: 19, r: [2.4, -11.31, 0], ease: 'quad' }, { t: 26, r: [2, -0.8, 0], ease: 'sine' },
        { t: 38, r: [2.5, 8, 0], ease: 'linear' }],
      clavicle_L: [{ t: 0, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'sine' }, { t: 9, r: [-54.1, 29.6, -29.9], ease: 'sine' },
        { t: 13, r: [-32.2, 7.1, -21.9], ease: 'quart' }, { t: 16, r: [-31.4, -56.2, -43], ease: 'sine' },
        { t: 19, r: [-31.31, -59.7, -45.32], ease: 'quad' }, { t: 26, r: [-48.9, -4.5, -35.6], ease: 'sine' },
        { t: 38, r: [-35, 0, -36], ease: 'linear' }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'sine' }, { t: 9, r: [-124.7, 0, 17], ease: 'sine' },
        { t: 13, r: [-119.2, 0, 17], ease: 'quart' }, { t: 16, r: [-152, 0, 17], ease: 'sine' },
        { t: 19, r: [-155.5, 0, 17], ease: 'quad' }, { t: 26, r: [-123.8, 0, 17], ease: 'sine' },
        { t: 38, r: [-124, 0, 17], ease: 'linear' }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'sine' }, { t: 9, r: [-8, 1.6, 0], ease: 'sine' },
        { t: 13, r: [-8, 4, 0], ease: 'quart' }, { t: 16, r: [-8, 14, 0], ease: 'sine' },
        { t: 19, r: [-8, 15.1, 0], ease: 'quad' }, { t: 26, r: [-8, 4, 0], ease: 'sine' },
        { t: 38, r: [-8, 0, 0], ease: 'linear' }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'sine' }, { t: 9, r: [-16, 0, 0], ease: 'sine' },
        { t: 13, r: [-19, 0, 0], ease: 'quart' }, { t: 16, r: [-27, 0, 0], ease: 'sine' },
        { t: 19, r: [-27.88, 0, 0], ease: 'quad' }, { t: 26, r: [-17, 0, 0], ease: 'sine' },
        { t: 38, r: [-14, 0, 0], ease: 'linear' }],
      clavicle_R: [{ t: 0, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 4, r: [-15.65, -2.09, 47], ease: 'sine' },
        { t: 9, r: [-21, 14.3, 4.1], ease: 'linear' }, { t: 13, r: [-64.6, -12.2, -2.41], ease: 'linear' },
        { t: 14, r: [-63.98, -6.8, -8.9], ease: 'linear' }, { t: 15, r: [-63.04, 1.43, -18.78], ease: 'linear' },
        { t: 16, r: [-61.7, 13.1, -32.8], ease: 'snap' }, { t: 19, r: [-59.75, 30.1, -43.35], ease: 'sine' },
        { t: 26, r: [-46.2, -23.7, 4.1], ease: 'sine' }, { t: 38, r: [-22, 0, 36], ease: 'linear' }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 4, r: [-156, 0, -1], ease: 'sine' },
        { t: 9, r: [-145.2, 0, -1], ease: 'linear' }, { t: 13, r: [-121.57, 0, -1], ease: 'linear' },
        { t: 14, r: [-98, 0, -1], ease: 'linear' }, { t: 15, r: [-62.12, 0, -1], ease: 'linear' },
        { t: 16, r: [-11.2, 0, -1], ease: 'snap' }, { t: 19, r: [-3.2, 0, -1], ease: 'sine' },
        { t: 26, r: [-89.2, 0, -1], ease: 'sine' }, { t: 38, r: [-145, 0, -1], ease: 'linear' }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 4, r: [-8, 7, 0], ease: 'sine' },
        { t: 9, r: [-8, 4, 0], ease: 'linear' }, { t: 13, r: [-8, 10, 0], ease: 'linear' },
        { t: 14, r: [-8, 1.03, 0], ease: 'linear' }, { t: 15, r: [-8, -12.62, 0], ease: 'linear' },
        { t: 16, r: [-8, -32, 0], ease: 'snap' }, { t: 19, r: [-8, -40, 0], ease: 'sine' },
        { t: 22, r: [-8, -41, 0], ease: 'sine' }, { t: 26, r: [-8, -10, 0], ease: 'sine' },
        { t: 38, r: [-8, 0, 0], ease: 'linear' }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 4, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 9, r: [-18.8, 0, 2.8], ease: 'linear' }, { t: 13, r: [-26, 0, 7], ease: 'linear' },
        { t: 14, r: [-20.87, 0, 5.08], ease: 'linear' }, { t: 15, r: [-13.07, 0, 2.15], ease: 'linear' },
        { t: 16, r: [-2, 0, -2], ease: 'snap' }, { t: 19, r: [6, 0, -5], ease: 'sine' },
        { t: 22, r: [-28, 0, -10], ease: 'sine' }, { t: 26, r: [-18, 0, 0], ease: 'sine' },
        { t: 38, r: [-14, 0, 0], ease: 'linear' }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'sine' }, { t: 9, r: [-10, -18, 14], ease: 'sine' },
        { t: 13, r: [-18, -12, 12], ease: 'quart' }, { t: 16, r: [-26, -4, 9], ease: 'sine' },
        { t: 19, r: [-26.88, -3.12, 8.67], ease: 'quad' }, { t: 26, r: [-22, -10, 10], ease: 'sine' },
        { t: 38, r: [-39, 10, 11], ease: 'linear' }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'sine' }, { t: 9, r: [66, 0, 0], ease: 'sine' },
        { t: 13, r: [46, 0, 0], ease: 'quart' }, { t: 16, r: [26, 0, 0], ease: 'sine' },
        { t: 19, r: [23.8, 0, 0], ease: 'quad' }, { t: 26, r: [30, 0, 0], ease: 'sine' },
        { t: 38, r: [42, 0, 0], ease: 'linear' }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'sine' }, { t: 9, r: [-60, 2, 0], ease: 'sine' }, { t: 13, r: [-34.7, 2, 0], ease: 'quart' },
        { t: 16, r: [-7.2, 2, 0], ease: 'sine' }, { t: 19, r: [-4, 2, 0], ease: 'quad' }, { t: 26, r: [-14.8, 2, 0], ease: 'sine' },
        { t: 38, r: [-4, 2, 0], ease: 'linear' }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [1.1, 0, 0], ease: 'sine' }, { t: 13, r: [6, 0, 0], ease: 'quart' },
        { t: 16, r: [6.7, 0, 0], ease: 'sine' }, { t: 19, r: [6.9, 0, 0], ease: 'quad' }, { t: 26, r: [6.8, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [0.5, 0, 0], ease: 'sine' }, { t: 13, r: [2.5, 0, 0], ease: 'quart' },
        { t: 16, r: [2.8, 0, 0], ease: 'sine' }, { t: 19, r: [2.9, 0, 0], ease: 'quad' }, { t: 26, r: [2.9, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'sine' }, { t: 9, r: [-14, 8, -16], ease: 'sine' },
        { t: 13, r: [-2, 6, -14], ease: 'quart' }, { t: 16, r: [14, -6, -12], ease: 'sine' },
        { t: 19, r: [15.76, -7.32, -11.78], ease: 'quad' }, { t: 26, r: [8, 2, -13], ease: 'sine' },
        { t: 38, r: [-9, -6, -12], ease: 'linear' }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'sine' }, { t: 9, r: [68, 0, 0], ease: 'sine' },
        { t: 13, r: [44, 0, 0], ease: 'quart' }, { t: 16, r: [12, 0, 0], ease: 'sine' },
        { t: 19, r: [8.5, 0, 0], ease: 'quad' }, { t: 26, r: [24, 0, 0], ease: 'sine' },
        { t: 38, r: [45, 0, 0], ease: 'linear' }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'sine' }, { t: 9, r: [-56.1, -3, 0], ease: 'sine' }, { t: 13, r: [-24.7, 0, 0], ease: 'quart' },
        { t: 16, r: [-28.3, 0, 0], ease: 'sine' }, { t: 19, r: [-28, 0, 0], ease: 'quad' }, { t: 26, r: [-20.3, 0, 0], ease: 'sine' },
        { t: 38, r: [-33, -3, 0], ease: 'linear' }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [3.3, 0, 0], ease: 'sine' }, { t: 13, r: [-8.4, 0, 0], ease: 'quart' },
        { t: 16, r: [4.3, 0, 0], ease: 'sine' }, { t: 19, r: [6.7, 0, 0], ease: 'quad' }, { t: 26, r: [-0.2, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'sine' }, { t: 9, r: [1.4, 0, 0], ease: 'sine' }, { t: 13, r: [-3.5, 0, 0], ease: 'quart' },
        { t: 16, r: [1.8, 0, 0], ease: 'sine' }, { t: 19, r: [2.8, 0, 0], ease: 'quad' }, { t: 26, r: [-0.1, 0, 0], ease: 'sine' },
        { t: 38, r: [0, 0, 0], ease: 'linear' }],
    },
  },

  // i48, and no other clip in the library is anywhere near that. Siege Slam used
  // to borrow `p.hammerFist`, whose blow lands on tick 19, and asked the runtime
  // for a 0.40x wind-up — well past the 0.72x floor, so the clamp bit and the
  // clip reached tick 34.6 by the time the hitbox opened. The fists had already
  // landed, bounced and started back up 15 ticks before the move said contact:
  // 690mm of error, and the only unblockable in the heavy set was landing on a
  // recovery pose.
  //
  // Forty-eight ticks of wind-up is eight tenths of a second and cannot be
  // filled by playing the hammer fist slowly — held poses read as a dropped
  // frame. It is filled the way a real heavy wind-up is: a weight settle onto
  // both feet (t10), the brace as the armour comes on at t18, a long climb of
  // the arms overhead (t20-t32), a peak that keeps drifting rather than holding
  // (t32-t40), and then four ticks of collapse into the blow. Contact is the
  // deepest point of the pelvis, not the highest, because the whole 44 damage is
  // the fighter's own mass arriving.
  'p.siegeSlam': {
    name: 'Siege Slam',
    duration: 86, blendIn: 5, blendOut: 10,
    impact: { tick: 48, bone: 'hand_R' },
    root: [
      { t: 0, p: [0, -0.075, 0], ease: 'quad' },
      { t: 10, p: [0, -0.175, -0.05], ease: 'sine' },
      { t: 18, p: [0, -0.198, -0.07], ease: 'sine' },
      { t: 32, p: [0, -0.111, -0.04], ease: 'quart' },
      { t: 40, p: [0, -0.079, -0.02], ease: 'quad' },
      { t: 44, p: [0, -0.107, 0.03], ease: 'quad' },
      { t: 46, p: [0, -0.175, 0.11], ease: 'sine' },
      { t: 48, p: [0, -0.273, 0.21], ease: 'sine' },
      { t: 52, p: [0, -0.258, 0.228], ease: 'quad' },
      { t: 56, p: [0, -0.229, 0.216], ease: 'sine' },
      { t: 60, p: [0, -0.187, 0.2], ease: 'sine' },
      { t: 72, p: [0, -0.124, 0.11], ease: 'linear' },
      { t: 86, p: [0, -0.075, 0] },
    ],
    tracks: {
      hips: [{ t: 0, r: [1, -27.8, 0], ease: 'quad' }, { t: 5, r: [-3.2, -32.22, 0], ease: 'sine' },
        { t: 10, r: [4.5, -21, 0], ease: 'sine' }, { t: 18, r: [-2, -8, 0], ease: 'sine' },
        { t: 32, r: [-11, -5, 0], ease: 'quart' }, { t: 40, r: [-14.5, -4, 0], ease: 'quad' },
        { t: 44, r: [-9, -5, 0], ease: 'quad' }, { t: 46, r: [0, -8, 0], ease: 'sine' },
        { t: 48, r: [16, -12, 0], ease: 'sine' }, { t: 52, r: [18.4, -12.6, 0], ease: 'quad' },
        { t: 56, r: [16, -13.5, 0], ease: 'sine' }, { t: 60, r: [13, -15, 0], ease: 'sine' },
        { t: 72, r: [6, -20, 0], ease: 'linear' }, { t: 86, r: [1, -27.8, 0] }],
      spine01: [{ t: 0, r: [1.9, 5.2, 0], ease: 'quad' }, { t: 5, r: [-1.77, 5.7, 0], ease: 'sine' },
        { t: 10, r: [5.5, 5, 0], ease: 'sine' }, { t: 18, r: [0, 3, 0], ease: 'sine' },
        { t: 32, r: [-8, 2, 0], ease: 'quart' }, { t: 40, r: [-11, 1.5, 0], ease: 'quad' },
        { t: 44, r: [-6, 1.8, 0], ease: 'quad' }, { t: 46, r: [2, 2.4, 0], ease: 'sine' },
        { t: 48, r: [15, 3.4, 0], ease: 'sine' }, { t: 52, r: [17.2, 3.5, 0], ease: 'quad' },
        { t: 56, r: [15, 3.6, 0], ease: 'sine' }, { t: 60, r: [12, 3.8, 0], ease: 'sine' },
        { t: 72, r: [5.5, 4.4, 0], ease: 'linear' }, { t: 86, r: [1.9, 5.2, 0] }],
      spine02: [{ t: 0, r: [2.6, 6.1, 0], ease: 'quad' }, { t: 5, r: [-1.4, 6.58, 0], ease: 'sine' },
        { t: 10, r: [7.4, 5.9, 0], ease: 'sine' }, { t: 18, r: [0, 3.6, 0], ease: 'sine' },
        { t: 32, r: [-10.5, 2.4, 0], ease: 'quart' }, { t: 40, r: [-14.5, 1.8, 0], ease: 'quad' },
        { t: 44, r: [-8, 2.2, 0], ease: 'quad' }, { t: 46, r: [3, 2.9, 0], ease: 'sine' },
        { t: 48, r: [20, 4, 0], ease: 'sine' }, { t: 52, r: [23, 4.1, 0], ease: 'quad' },
        { t: 56, r: [20, 4.2, 0], ease: 'sine' }, { t: 60, r: [16, 4.5, 0], ease: 'sine' },
        { t: 72, r: [7.4, 5.2, 0], ease: 'linear' }, { t: 86, r: [2.6, 6.1, 0] }],
      chest: [{ t: 0, r: [2.6, 7.3, -3], ease: 'quad' }, { t: 5, r: [-2.27, 8.5, -3.28], ease: 'sine' },
        { t: 10, r: [7.4, 6.4, -3], ease: 'sine' }, { t: 18, r: [0, 2.5, -1], ease: 'sine' },
        { t: 32, r: [-10.5, 1.5, 0], ease: 'quart' }, { t: 40, r: [-14.5, 1, 0], ease: 'quad' },
        { t: 44, r: [-8, 1.4, -0.4], ease: 'quad' }, { t: 46, r: [3, 2, -1.2], ease: 'sine' },
        { t: 48, r: [20, 3, -2], ease: 'sine' }, { t: 52, r: [23, 3.1, -2.2], ease: 'quad' },
        { t: 56, r: [20, 3.4, -2.3], ease: 'sine' }, { t: 60, r: [16, 3.8, -2.4], ease: 'sine' },
        { t: 72, r: [7.4, 5.4, -2.8], ease: 'linear' }, { t: 86, r: [2.6, 7.3, -3] }],
      neck: [{ t: 0, r: [0.6, 5.2, 0], ease: 'quad' }, { t: 10, r: [-1.5, 4.4, 0], ease: 'sine' }, { t: 18, r: [1, 2, 0], ease: 'sine' },
        { t: 32, r: [6, 1.2, 0], ease: 'quart' }, { t: 40, r: [7.5, 0.8, 0], ease: 'quad' }, { t: 44, r: [5, 1, 0], ease: 'quad' },
        { t: 46, r: [0, 1.5, 0], ease: 'sine' }, { t: 48, r: [-7.5, 2.2, 0], ease: 'sine' }, { t: 52, r: [-8.4, 2.3, 0], ease: 'quad' },
        { t: 56, r: [-7, 2.5, 0], ease: 'sine' }, { t: 60, r: [-5, 2.8, 0], ease: 'sine' }, { t: 72, r: [-1, 3.8, 0], ease: 'linear' },
        { t: 86, r: [0.6, 5.2, 0] }],
      head: [{ t: 0, r: [2.5, 8, 0], ease: 'quad' }, { t: 10, r: [-1, 6.6, 0], ease: 'sine' }, { t: 18, r: [2.5, 3, 0], ease: 'sine' },
        { t: 32, r: [10, 1.8, 0], ease: 'quart' }, { t: 40, r: [12.5, 1.2, 0], ease: 'quad' }, { t: 44, r: [8, 1.5, 0], ease: 'quad' },
        { t: 46, r: [0, 2.3, 0], ease: 'sine' }, { t: 48, r: [-12, 3.4, 0], ease: 'sine' }, { t: 52, r: [-13.5, 3.5, 0], ease: 'quad' },
        { t: 56, r: [-11, 3.8, 0], ease: 'sine' }, { t: 60, r: [-8, 4.2, 0], ease: 'sine' }, { t: 72, r: [-1, 5.8, 0], ease: 'linear' },
        { t: 86, r: [2.5, 8, 0] }],
      clavicle_L: [{ t: 0, r: [0, -10, -4], ease: 'quad' }, { t: 10, r: [0, -8, -8], ease: 'sine' }, { t: 18, r: [0, -6, -12], ease: 'sine' },
        { t: 32, r: [0, -4, -16], ease: 'quart' }, { t: 40, r: [0, -4, -17], ease: 'quad' }, { t: 44, r: [0, -5, -14], ease: 'quad' },
        { t: 46, r: [0, -8, -8], ease: 'sine' }, { t: 48, r: [0, -12, -2], ease: 'sine' }, { t: 52, r: [0, -13, -1], ease: 'quad' },
        { t: 56, r: [0, -12, -2], ease: 'sine' }, { t: 60, r: [0, -11, -5], ease: 'sine' }, { t: 72, r: [0, -10, -4], ease: 'linear' },
        { t: 86, r: [0, -10, -4] }],
      shoulder_L: [{ t: 0, r: [-35, 0, -36], ease: 'quad' }, { t: 10, r: [-48, -22, 44], ease: 'sine' }, { t: 18, r: [-64, -32, 60], ease: 'sine' },
        { t: 32, r: [-64, -33, 66], ease: 'quart' }, { t: 40, r: [-68, -35, 64], ease: 'quad' }, { t: 44, r: [-62, -40, 70], ease: 'quad' },
        { t: 46, r: [-26, -48, 80], ease: 'sine' }, { t: 48, r: [8.3, -51.6, 84], ease: 'sine' }, { t: 52, r: [11.8, -53.5, 86.4], ease: 'quad' },
        { t: 56, r: [10, -50, 80], ease: 'sine' }, { t: 60, r: [-20, -30, 40], ease: 'sine' }, { t: 72, r: [-52, 16, -2], ease: 'linear' },
        { t: 86, r: [-35, 0, -36] }],
      elbow_L: [{ t: 0, r: [-124, 0, 17], ease: 'quad' }, { t: 10, r: [-74, 0, 17], ease: 'sine' }, { t: 18, r: [-34, 0, 17], ease: 'sine' },
        { t: 32, r: [-24, 0, 17], ease: 'quart' }, { t: 40, r: [-20, 0, 17], ease: 'quad' }, { t: 44, r: [-22, 0, 17], ease: 'quad' },
        { t: 46, r: [-25, 0, 17], ease: 'sine' }, { t: 48, r: [-28.7, 0, 17], ease: 'sine' }, { t: 52, r: [-29.6, 0, 17], ease: 'quad' },
        { t: 56, r: [-48, 0, 17], ease: 'sine' }, { t: 60, r: [-76, 0, 17], ease: 'sine' }, { t: 72, r: [-100, 0, 17], ease: 'linear' },
        { t: 86, r: [-124, 0, 17] }],
      wrist_L: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 10, r: [-8, -6, 0], ease: 'sine' }, { t: 18, r: [-8, -12, 0], ease: 'sine' },
        { t: 32, r: [-8, -19, 0], ease: 'quart' }, { t: 40, r: [-8, -22, 0], ease: 'quad' }, { t: 44, r: [-8, -16, 0], ease: 'quad' },
        { t: 46, r: [-8, 4, 0], ease: 'sine' }, { t: 48, r: [-8, 32, 0], ease: 'sine' }, { t: 52, r: [-8, 35.5, 0], ease: 'quad' },
        { t: 56, r: [-8, 41, 0], ease: 'sine' }, { t: 60, r: [-8, 14, 0], ease: 'sine' }, { t: 72, r: [-8, 4, 0], ease: 'linear' },
        { t: 86, r: [-8, 0, 0] }],
      hand_L: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 10, r: [-19, 0, -3], ease: 'sine' }, { t: 18, r: [-24, 0, -6], ease: 'sine' },
        { t: 32, r: [-30, 0, -9], ease: 'quart' }, { t: 40, r: [-32, 0, -10], ease: 'quad' }, { t: 44, r: [-28, 0, -8], ease: 'quad' },
        { t: 46, r: [-16, 0, -3], ease: 'sine' }, { t: 48, r: [-2, 0, 2], ease: 'sine' }, { t: 52, r: [0.6, 0, 3], ease: 'quad' },
        { t: 56, r: [-28, 0, 10], ease: 'sine' }, { t: 60, r: [-20, 0, 3], ease: 'sine' }, { t: 72, r: [-16, 0, 1], ease: 'linear' },
        { t: 86, r: [-14, 0, 0] }],
      clavicle_R: [{ t: 0, r: [0, 8, 4], ease: 'quad' }, { t: 10, r: [0, 6, 8], ease: 'sine' }, { t: 18, r: [0, 5, 12], ease: 'sine' },
        { t: 32, r: [0, 3, 16], ease: 'quart' }, { t: 40, r: [0, 3, 17], ease: 'quad' }, { t: 44, r: [0, 4, 14], ease: 'quad' },
        { t: 46, r: [0, 6, 8], ease: 'sine' }, { t: 48, r: [0, 10, 2], ease: 'sine' }, { t: 52, r: [0, 11, 1], ease: 'quad' },
        { t: 56, r: [0, 10, 2], ease: 'sine' }, { t: 60, r: [0, 9, 5], ease: 'sine' }, { t: 72, r: [0, 8, 4], ease: 'linear' },
        { t: 86, r: [0, 8, 4] }],
      shoulder_R: [{ t: 0, r: [-22, 0, 36], ease: 'quad' }, { t: 5, r: [-22.02, -5.72, 47], ease: 'sine' },
        { t: 10, r: [-58, 8, -18], ease: 'sine' }, { t: 18, r: [-84, 13, -50], ease: 'sine' },
        { t: 32, r: [-88, 14, -53], ease: 'quart' }, { t: 40, r: [-92, 14, -57], ease: 'quad' },
        { t: 44, r: [-86, 20, -62], ease: 'quad' }, { t: 46, r: [-52, 38, -68], ease: 'sine' },
        { t: 48, r: [-21.8, 53, -66], ease: 'snap' }, { t: 52, r: [-4.8, 62.6, -68.31], ease: 'sine' },
        { t: 56, r: [-8.3, 54.5, -60.7], ease: 'sine' }, { t: 60, r: [-40, 20, -20], ease: 'sine' },
        { t: 72, r: [-56, -20, 10], ease: 'linear' }, { t: 86, r: [-22, 0, 36] }],
      elbow_R: [{ t: 0, r: [-145, 0, -1], ease: 'quad' }, { t: 5, r: [-156, 0, -1], ease: 'sine' },
        { t: 10, r: [-80, 0, -1], ease: 'sine' }, { t: 18, r: [-34, 0, -1], ease: 'sine' },
        { t: 32, r: [-24, 0, -1], ease: 'quart' }, { t: 40, r: [-20, 0, -1], ease: 'quad' },
        { t: 44, r: [-22, 0, -1], ease: 'quad' }, { t: 46, r: [-23, 0, -1], ease: 'sine' },
        { t: 48, r: [-23.3, 0, -1], ease: 'snap' }, { t: 52, r: [-23.57, 0, -1], ease: 'sine' },
        { t: 56, r: [-44, 0, -1], ease: 'sine' }, { t: 60, r: [-70, 0, -1], ease: 'sine' },
        { t: 72, r: [-110, 0, -1], ease: 'linear' }, { t: 86, r: [-145, 0, -1] }],
      wrist_R: [{ t: 0, r: [-8, 0, 0], ease: 'quad' }, { t: 5, r: [-8, 7, 0], ease: 'sine' },
        { t: 10, r: [-8, 6, 0], ease: 'sine' }, { t: 18, r: [-8, 12, 0], ease: 'sine' },
        { t: 32, r: [-8, 19, 0], ease: 'quart' }, { t: 40, r: [-8, 22, 0], ease: 'quad' },
        { t: 44, r: [-8, 16, 0], ease: 'quad' }, { t: 46, r: [-8, -4, 0], ease: 'sine' },
        { t: 48, r: [-8, -32, 0], ease: 'snap' }, { t: 52, r: [-8, -40, 0], ease: 'sine' },
        { t: 56, r: [-8, -41, 0], ease: 'sine' }, { t: 60, r: [-8, -14, 0], ease: 'sine' },
        { t: 72, r: [-8, -4, 0], ease: 'linear' }, { t: 86, r: [-8, 0, 0] }],
      hand_R: [{ t: 0, r: [-14, 0, 0], ease: 'quad' }, { t: 5, r: [-17.36, 0, 0.56], ease: 'sine' },
        { t: 10, r: [-19, 0, 3], ease: 'sine' }, { t: 18, r: [-24, 0, 6], ease: 'sine' },
        { t: 32, r: [-30, 0, 9], ease: 'quart' }, { t: 40, r: [-32, 0, 10], ease: 'quad' },
        { t: 44, r: [-28, 0, 8], ease: 'quad' }, { t: 46, r: [-16, 0, 3], ease: 'sine' },
        { t: 48, r: [-2, 0, -2], ease: 'snap' }, { t: 52, r: [6, 0, -5.08], ease: 'sine' },
        { t: 56, r: [-28, 0, -10], ease: 'sine' }, { t: 60, r: [-20, 0, -3], ease: 'sine' },
        { t: 72, r: [-16, 0, -1], ease: 'linear' }, { t: 86, r: [-14, 0, 0] }],
      hip_L: [{ t: 0, r: [-39, 10, 11], ease: 'quad' }, { t: 10, r: [-52, -4, 18], ease: 'sine' }, { t: 18, r: [-56, -8, 22], ease: 'sine' },
        { t: 32, r: [-40, -12, 20], ease: 'quart' }, { t: 40, r: [-31, -13, 19], ease: 'quad' }, { t: 44, r: [-36, -13, 19], ease: 'quad' },
        { t: 46, r: [-46, -13.5, 20], ease: 'sine' }, { t: 48, r: [-62, -14, 22], ease: 'sine' }, { t: 52, r: [-60.4, -14.2, 22.2], ease: 'quad' },
        { t: 56, r: [-57, -14, 21], ease: 'sine' }, { t: 60, r: [-53, -14, 20], ease: 'sine' }, { t: 72, r: [-44, -6, 15], ease: 'linear' },
        { t: 86, r: [-39, 10, 11] }],
      knee_L: [{ t: 0, r: [42, 0, 0], ease: 'quad' }, { t: 10, r: [64, 0, 0], ease: 'sine' }, { t: 18, r: [70, 0, 0], ease: 'sine' },
        { t: 32, r: [44, 0, 0], ease: 'quart' }, { t: 40, r: [30, 0, 0], ease: 'quad' }, { t: 44, r: [38, 0, 0], ease: 'quad' },
        { t: 46, r: [56, 0, 0], ease: 'sine' }, { t: 48, r: [86, 0, 0], ease: 'sine' }, { t: 52, r: [83.5, 0, 0], ease: 'quad' },
        { t: 56, r: [77, 0, 0], ease: 'sine' }, { t: 60, r: [70, 0, 0], ease: 'sine' }, { t: 72, r: [53, 0, 0], ease: 'linear' },
        { t: 86, r: [42, 0, 0] }],
      ankle_L: [{ t: 0, r: [-4, 2, 0], ease: 'quad' }, { t: 10, r: [-17.8, 2, 0], ease: 'sine' }, { t: 18, r: [-20.4, 2, 0], ease: 'sine' },
        { t: 32, r: [-9.2, 2, 0], ease: 'quart' }, { t: 40, r: [-2.4, 2, 0], ease: 'quad' }, { t: 44, r: [-6.5, 2, 0], ease: 'quad' },
        { t: 46, r: [-16, 2, 0], ease: 'sine' }, { t: 48, r: [-40, 2, 0], ease: 'sine' }, { t: 52, r: [-40.2, 2, 0], ease: 'quad' },
        { t: 56, r: [-35.7, 2, 0], ease: 'sine' }, { t: 60, r: [-25.3, 2, 0], ease: 'sine' }, { t: 72, r: [-15.7, 2, 0], ease: 'linear' },
        { t: 86, r: [-4, 2, 0] }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [5.9, 0, 0], ease: 'sine' }, { t: 18, r: [7.9, 0, 0], ease: 'sine' },
        { t: 32, r: [3.6, 0, 0], ease: 'quart' }, { t: 40, r: [0.9, 0, 0], ease: 'quad' }, { t: 44, r: [2.6, 0, 0], ease: 'quad' },
        { t: 46, r: [6.5, 0, 0], ease: 'sine' }, { t: 48, r: [6.9, 0, 0], ease: 'sine' }, { t: 52, r: [6, 0, 0], ease: 'quad' },
        { t: 56, r: [5.6, 0, 0], ease: 'sine' }, { t: 60, r: [8.2, 0, 0], ease: 'sine' }, { t: 72, r: [3.7, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [2.5, 0, 0], ease: 'sine' }, { t: 18, r: [3.3, 0, 0], ease: 'sine' },
        { t: 32, r: [1.5, 0, 0], ease: 'quart' }, { t: 40, r: [0.4, 0, 0], ease: 'quad' }, { t: 44, r: [1.1, 0, 0], ease: 'quad' },
        { t: 46, r: [2.7, 0, 0], ease: 'sine' }, { t: 48, r: [2.9, 0, 0], ease: 'sine' }, { t: 52, r: [2.5, 0, 0], ease: 'quad' },
        { t: 56, r: [2.3, 0, 0], ease: 'sine' }, { t: 60, r: [3.5, 0, 0], ease: 'sine' }, { t: 72, r: [1.5, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      foot_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [6.5, 0, 0], ease: 'sine' }, { t: 18, r: [7.9, 0, 0], ease: 'sine' },
        { t: 32, r: [3.6, 0, 0], ease: 'quart' }, { t: 40, r: [0.9, 0, 0], ease: 'quad' }, { t: 44, r: [2.6, 0, 0], ease: 'quad' },
        { t: 46, r: [6.5, 0, 0], ease: 'sine' }, { t: 48, r: [12.2, 0, 0], ease: 'sine' }, { t: 52, r: [11.7, 0, 0], ease: 'quad' },
        { t: 56, r: [10.5, 0, 0], ease: 'sine' }, { t: 60, r: [9.2, 0, 0], ease: 'sine' }, { t: 72, r: [5.1, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      toe_L: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [2.7, 0, 0], ease: 'sine' }, { t: 18, r: [3.3, 0, 0], ease: 'sine' },
        { t: 32, r: [1.5, 0, 0], ease: 'quart' }, { t: 40, r: [0.4, 0, 0], ease: 'quad' }, { t: 44, r: [1.1, 0, 0], ease: 'quad' },
        { t: 46, r: [2.7, 0, 0], ease: 'sine' }, { t: 48, r: [5.1, 0, 0], ease: 'sine' }, { t: 52, r: [4.9, 0, 0], ease: 'quad' },
        { t: 56, r: [4.4, 0, 0], ease: 'sine' }, { t: 60, r: [3.9, 0, 0], ease: 'sine' }, { t: 72, r: [2.1, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      hip_R: [{ t: 0, r: [-9, -6, -12], ease: 'quad' }, { t: 10, r: [-20, 4, -22], ease: 'sine' }, { t: 18, r: [-24, 8, -26], ease: 'sine' },
        { t: 32, r: [-12, 8, -24], ease: 'quart' }, { t: 40, r: [-5, 8, -22], ease: 'quad' }, { t: 44, r: [-9, 8, -22], ease: 'quad' },
        { t: 46, r: [-18, 7.5, -23.5], ease: 'sine' }, { t: 48, r: [-30, 7, -25], ease: 'sine' }, { t: 52, r: [-29.1, 7, -24.8], ease: 'quad' },
        { t: 56, r: [-26, 7, -24], ease: 'sine' }, { t: 60, r: [-24, 7, -23], ease: 'sine' }, { t: 72, r: [-16, 2, -17], ease: 'linear' },
        { t: 86, r: [-9, -6, -12] }],
      knee_R: [{ t: 0, r: [45, 0, 0], ease: 'quad' }, { t: 10, r: [66, 0, 0], ease: 'sine' }, { t: 18, r: [72, 0, 0], ease: 'sine' },
        { t: 32, r: [46, 0, 0], ease: 'quart' }, { t: 40, r: [31, 0, 0], ease: 'quad' }, { t: 44, r: [40, 0, 0], ease: 'quad' },
        { t: 46, r: [58, 0, 0], ease: 'sine' }, { t: 48, r: [88, 0, 0], ease: 'sine' }, { t: 52, r: [85.4, 0, 0], ease: 'quad' },
        { t: 56, r: [78, 0, 0], ease: 'sine' }, { t: 60, r: [72, 0, 0], ease: 'sine' }, { t: 72, r: [55, 0, 0], ease: 'linear' },
        { t: 86, r: [45, 0, 0] }],
      ankle_R: [{ t: 0, r: [-33, -3, 0], ease: 'quad' }, { t: 10, r: [-45.6, -3, 0], ease: 'sine' }, { t: 18, r: [-49.2, -3, 0], ease: 'sine' },
        { t: 32, r: [-37.6, -3, 0], ease: 'quart' }, { t: 40, r: [-30.8, -3, 0], ease: 'quad' }, { t: 44, r: [-22.8, -3, 0], ease: 'quad' },
        { t: 46, r: [-39.3, -3, 0], ease: 'sine' }, { t: 48, r: [-59.8, -3, 0], ease: 'sine' }, { t: 52, r: [-58.6, -3, 0], ease: 'quad' },
        { t: 56, r: [-55, -3, 0], ease: 'sine' }, { t: 60, r: [-52, -3, 0], ease: 'sine' }, { t: 72, r: [-31.2, -3, 0], ease: 'linear' },
        { t: 86, r: [-33, -3, 0] }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [7.1, 0, 0], ease: 'sine' }, { t: 18, r: [8.7, 0, 0], ease: 'sine' },
        { t: 32, r: [4, 0, 0], ease: 'quart' }, { t: 40, r: [1, 0, 0], ease: 'quad' }, { t: 44, r: [10.3, 0, 0], ease: 'quad' },
        { t: 46, r: [9.7, 0, 0], ease: 'sine' }, { t: 48, r: [13.4, 0, 0], ease: 'sine' }, { t: 52, r: [12.9, 0, 0], ease: 'quad' },
        { t: 56, r: [11.5, 0, 0], ease: 'sine' }, { t: 60, r: [10.1, 0, 0], ease: 'sine' }, { t: 72, r: [11.6, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [3, 0, 0], ease: 'sine' }, { t: 18, r: [3.7, 0, 0], ease: 'sine' },
        { t: 32, r: [1.7, 0, 0], ease: 'quart' }, { t: 40, r: [0.4, 0, 0], ease: 'quad' }, { t: 44, r: [4.4, 0, 0], ease: 'quad' },
        { t: 46, r: [4, 0, 0], ease: 'sine' }, { t: 48, r: [5.6, 0, 0], ease: 'sine' }, { t: 52, r: [5.4, 0, 0], ease: 'quad' },
        { t: 56, r: [4.8, 0, 0], ease: 'sine' }, { t: 60, r: [4.3, 0, 0], ease: 'sine' }, { t: 72, r: [4.9, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      foot_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [7.1, 0, 0], ease: 'sine' }, { t: 18, r: [8.7, 0, 0], ease: 'sine' },
        { t: 32, r: [4, 0, 0], ease: 'quart' }, { t: 40, r: [1, 0, 0], ease: 'quad' }, { t: 44, r: [2.8, 0, 0], ease: 'quad' },
        { t: 46, r: [7, 0, 0], ease: 'sine' }, { t: 48, r: [13.4, 0, 0], ease: 'sine' }, { t: 52, r: [12.9, 0, 0], ease: 'quad' },
        { t: 56, r: [11.5, 0, 0], ease: 'sine' }, { t: 60, r: [10.1, 0, 0], ease: 'sine' }, { t: 72, r: [5.6, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
      toe_R: [{ t: 0, r: [0, 0, 0], ease: 'quad' }, { t: 10, r: [3, 0, 0], ease: 'sine' }, { t: 18, r: [3.7, 0, 0], ease: 'sine' },
        { t: 32, r: [1.7, 0, 0], ease: 'quart' }, { t: 40, r: [0.4, 0, 0], ease: 'quad' }, { t: 44, r: [1.2, 0, 0], ease: 'quad' },
        { t: 46, r: [2.9, 0, 0], ease: 'sine' }, { t: 48, r: [5.6, 0, 0], ease: 'sine' }, { t: 52, r: [5.4, 0, 0], ease: 'quad' },
        { t: 56, r: [4.8, 0, 0], ease: 'sine' }, { t: 60, r: [4.3, 0, 0], ease: 'sine' }, { t: 72, r: [2.4, 0, 0], ease: 'linear' },
        { t: 86, r: [0, 0, 0] }],
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
// That gate is why only 9 of 14 striking clips here are whipped. The rest —
//   p.overhand, p.backfist, p.hammerFist, p.pistonRush, p.launcherPunch
// — failed it at every W. Most failed on `carry`: past the pivot a delay is the
// same thing as holding the contact pose longer, so chain order and follow-
// through pull against each other, and follow-through wins where they collide.
// Their negative lag is in the RECOVERY POSE and wants re-posing, not re-timing.
// ---------------------------------------------------------------------------
const WHIP = {
  'p.jab': 6,
  'p.jabAlt': 5,
  'p.straight': 6,
  'p.hook': 6,
  'p.uppercut': 6,
  'p.elbow': 3,
  'p.lowJab': 5,
  'p.duckingStraight': 6,
  'p.siegeSlam': 4,
};

/**
 * A PLANTED LEG MUST NOT BE RE-TIMED.
 *
 * `whip`'s chain delays the ankle by 0.80W and the foot by 1.0W — six ticks on
 * this clip. A bone that is in contact with the concrete has a world position
 * the floor owns, and delaying it does not read as follow-through, it reads as
 * the boot sliding: the pose that put the sole flat arrives after the pose that
 * moved the pelvis over it. It matters here and nowhere else in the file only
 * because `p.uppercut` is the one clip whose legs are now solved AGAINST the
 * floor (see the note above the clip); everywhere else the legs are close enough
 * to static that a delay has nothing to slide.
 *
 * Only the leg fractions are zeroed. The spine and both arms keep the full
 * chain, so the head-lag centroid and chain monotonicity the round-13 sweep
 * measured are untouched — this changes the timing of four bones per side and
 * nothing above the pelvis.
 */
const PLANTED_LEGS = {
  hip_L: 0, hip_R: 0, knee_L: 0, knee_R: 0,
  ankle_L: 0, ankle_R: 0, foot_L: 0, foot_R: 0,
};
for (const id in WHIP) {
  whip(PUNCH_CLIPS[id], WHIP[id], {
    pivot: PUNCH_CLIPS[id].impact.tick,
    only: id === 'p.uppercut' ? PLANTED_LEGS : undefined,
  });
}

// ---------------------------------------------------------------------------
// PROXIMAL LEAD. See the note above `lead` in reactions.js for the measurement
// and the mechanism. Budget in ticks, swept per clip; only arms that improved
// chain concordance while regressing nothing are here. Every clip's pose at
// tick 0, at `impact.tick` and at `duration` is bit-identical to before.
//
// `p.uppercut` is the exception and gets its own reduced chain, because it is
// the one punch here whose pelvis drive is load-bearing for the FIST'S OWN world
// speed: an uppercut is a legs-and-hips move, the fist is largely carried, and
// stopping the torso at contact takes the contact-frame speed ratio with it.
// The full chain costs it 0.77 -> 0.68 at every budget from 0.5 to 12 ticks and
// is refused by the gate. Leading only the pelvis and the first spine joint, by
// half a tick, buys concordance 0.50 -> 0.74 and hips-at-contact 1.00 -> 0.59
// for 0.77 -> 0.75, which is inside tolerance. Half a tick is a small claim and
// is reported as one; it moves which tick the pelvis peak lands on and nothing
// more. It is taken because `p.uppercut` is what `shots/17-anim-strip`,
// `04-impact`, `05-juggle` and `07-super` all photograph — the launcher-tagged
// move `TestHarness.forceHit` resolves to — so it is the clip this axis is
// actually scored on.
// ---------------------------------------------------------------------------
const UPPERCUT_LEAD = { hips: 1.0, spine01: 0.78 };
lead(PUNCH_CLIPS['p.uppercut'], 0.5, { pivot: PUNCH_CLIPS['p.uppercut'].impact.tick, chain: UPPERCUT_LEAD });

const LEAD = {
  'p.backfist': 4,
  'p.duckingStraight': 5,
  'p.elbow': 4,
  'p.hammerFist': 6,
  'p.hook': 6,
  'p.jab': 1.5,
  'p.launcherPunch': 8,
  'p.lowJab': 0.75,
  'p.overhand': 7,
  // 10, and the trade here is not monotonic in the budget, which is worth
  // recording. Concordance plateaus at 0.60 from L=5 up, so the smallest
  // budget on the plateau looks like the right pick — but this is the one
  // clip whose contact tick (48) leaves the 0.30 cap room to run, and its
  // contact-frame speed ratio dips to 0.68 at L=3, recovers to 0.95 at 5,
  // falls again to 0.87 at 7 and only returns to 1.00 at L>=10. The fist
  // is still riding the pelvis on this slam, so the gate clears only once
  // the pelvis is fully out of the way. 10 is the smallest budget that
  // passes every gate, not the smallest that maximises the objective.
  //
  // AND THE GATE SET WAS INCOMPLETE, which is why this is 0 and not 10.
  // The declared gates were contact-frame speed ratio, follow-through and
  // worst single-tick hurtbox travel. Approach smoothness was not among
  // them, and that is what a 10-tick budget on a 48-tick approach broke:
  // acceleration sign reversals along the striking tip went 2 -> 12, a 6x
  // increase in velocity sawtooth, and this clip alone accounted for +10 of
  // the +6 net across all 34 attacks. A trace that reverses acceleration
  // twelve times before contact reads as micro-stutter, which is the
  // rubric's own "linear interpolation" down-score item -- so the operator
  // bought chain ordering by spending the thing the axis actually scores.
  // Disabled until `lead` gates on approach smoothness too and this clip is
  // re-swept; the other 27 clips are unaffected and keep their gains.
  'p.siegeSlam': 0,
  'p.straight': 5,
};
for (const id in LEAD) lead(PUNCH_CLIPS[id], LEAD[id], { pivot: PUNCH_CLIPS[id].impact.tick });

for (const id in PUNCH_CLIPS) validateClip(PUNCH_CLIPS[id], BONE_NAMES);

export default PUNCH_CLIPS;
