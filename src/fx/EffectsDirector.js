/**
 * Knockbots — the effects director.
 *
 * One subscriber to the event bus, one owner of every particle system, one
 * per-frame entry point. Nothing else in the game knows that FX exist: the
 * simulation emits `hit` and this file decides that a heavy counter-hit on the
 * head means a thousand white-hot sparks down the line the fist was travelling,
 * a screen-facing shock with real refraction, five armour shards, a coolant
 * spray that will splat on the floor two hundred milliseconds from now, a point
 * light that flashes the robot's chrome, and three frames of radial speed lines.
 *
 * Two properties decide whether that reads as an impact or as confetti, and
 * neither is a particle-system problem:
 *
 *  - **Direction.** Every element orients off `hit.velocity`, the striking
 *    bone's measured world displacement over the tick that landed — not off the
 *    capsule separation normal, which describes where two boxes happened to be
 *    rather than where the blow was going. See `#blowDir`.
 *  - **Time.** A hit does not fire everything on one tick. The move carries a
 *    beat table (`MoveSchema.resolveFx`) and this file schedules the flare,
 *    lance, burst, front, shards and dust across two to eight ticks of the FX
 *    clock. Hitstop stretches that clock, so the opening beats land inside the
 *    freeze and the tail arrives as the reaction starts to move.
 *
 * The architecture is deliberately narrow:
 *
 *  - **Fixed pools, ring allocation, zero steady-state garbage.** Every system
 *    is sized at boot from the quality tier's particle budget. Nothing in
 *    `update()` allocates; the scratch vectors and colours at the top of this
 *    file are the entire working set.
 *  - **GPU-parameterised simulation.** Sparks, fluid, smoke, rings and decals
 *    are integrated from their spawn state inside the vertex shader, so a
 *    thousand live particles cost one attribute upload on the frame they were
 *    born and nothing at all afterwards. Only the debris shards run on the CPU,
 *    because their whole value is that they behave like rigid bodies.
 *  - **Screen space is a separate layer.** Impact frames, speed lines,
 *    shockwave refraction and the overdrive takeover live in `OverlayPass`,
 *    appended to the render pipeline's composer after the output pass and gated
 *    so it costs one texture fetch when nothing is happening.
 *
 * Trails deserve a note. They are driven primarily by measured bone speed
 * rather than by move metadata, because that works for every attack, every
 * character and every animation without a table to maintain — a limb moving at
 * eight metres a second gets a ribbon, and a move that names a `trail` bone
 * forces one on regardless of speed. The bones are found by name in the scene
 * graph, so this module needs no reference to the `Fighter` instances to draw
 * them.
 */

import * as THREE from 'three';
import { bus } from '../core/Bus.js';
import {
  WEIGHT, GROUND_Y, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, TICK_DT, FIGHTER_HEIGHT,
} from '../core/Constants.js';
import { FX_SHAPE, FX_PART } from '../combat/MoveSchema.js';
import { bakeFxTextures } from './FxTextures.js';
import { SparkSystem } from './SparkSystem.js';
import { FlashSystem } from './FlashSystem.js';
import { DebrisSystem } from './DebrisSystem.js';
import { SmokeSystem } from './SmokeSystem.js';
import { FluidSystem } from './FluidSystem.js';
import { ShockwaveSystem, MAX_DISTORT_RINGS } from './ShockwaveSystem.js';
import { DecalSystem, DECAL } from './DecalSystem.js';
import { TrailSystem } from './TrailSystem.js';
import { OverlayPass } from './OverlayPass.js';

// --- scratch ---------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _roll = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _size = new THREE.Vector2();
const _eye = new THREE.Vector3();
const _lightDir = new THREE.Vector3(0.4, -0.8, 0.35);

/**
 * Per-weight impact recipe. Every number here is a readability decision.
 *
 * The persistence hierarchy is deliberate: `flashLife` is two to four frames,
 * `sparkLife` is ten to eighteen, and `coreLife` is the only element still
 * visible half a second later. A hit is an instantaneous event and the sparks
 * are the loudest part of it, so they have to be gone before the eye has
 * finished reading the reaction pose.
 *
 * The sparks used to burn for one to two seconds. Over that long the ballistic
 * integrator does exactly what it should — drag bleeds the horizontal speed off,
 * gravity brings everything down, and the whole population settles into a
 * glowing carpet on the floor between the fighters' feet. That carpet is not an
 * impact; it is a campfire, and it sits there under a reaction animation that
 * has moved on. Short lives put the mass back on the strike line where the blow
 * happened, which is the only place it means anything.
 *
 * The spark counts stay large. `SparkSystem` splits every burst into three size
 * tiers, and a tier that only gets a dozen particles does not read as a
 * population — it reads as a handful of stray dots. A launcher throwing eight
 * hundred sparks is one buffer upload and one draw call. `ember` is the
 * exception: it is a small garnish of slower motes at the contact, not a second
 * burst, so it is counted in tens.
 *
 * The contact ring is small, and that is the correction it needed most. A
 * screen-facing front with a metre and a half of radius covers a third of the
 * frame; drawn additively through a soft profile it is not a shockwave but a
 * low-contrast wash sitting over the fighters, the crowd and the floor at once —
 * a smudge on the lens. A pressure front is legible because it is *tight*: half
 * a metre across, bright enough to clip while it lives, and gone inside four
 * frames. Anything that survives long enough to be seen expanding has already
 * stopped being an impact.
 *
 * `light` and `impact` are the two numbers here measured against the struck
 * robot rather than against the effect, and between them they were the ENTIRE
 * over-exposure of the contact frame. Measured by in-page ablation on one
 * frozen `04-impact` contact frame — launcher, +1 rendered frame, camera
 * stubbed, grain and chroma off, so nothing whatever moves between grabs —
 * over a 340 px-radius disc on the contact point, counting pixels at
 * luma >= 250/255:
 *
 *     everything on                     8.27 %
 *     impact light silenced             3.94 %      -4.34 pp
 *     ...and the overlay impact frame   0.54 %      -3.40 pp
 *     ...and the flare/heat core        0.43 %      -0.11 pp
 *     ...and every spark                0.428 %     -0.001 pp
 *     ...and the shockwave              0.428 %      0.00 pp
 *
 * The stage alone delivers 0.43 %. Tekken 8's own contact frame, measured
 * identically, is 0.74 %. So the arena was never the problem and neither were
 * the particles: **97 % of the excess is the impact point light plus the
 * screen-space impact frame**, in roughly a 56/44 split. The sparks, the flare,
 * the heat core and the shockwave together move the number by one part in a
 * thousand — which is the whole argument for cutting the light rather than the
 * counts. A spark field inside a white blob is not a spark field.
 *
 * Two things were disproved on the way and are recorded so nobody re-tries them:
 *
 *  - **The flare is not the flashbulb.** Hiding the entire `FlashSystem` —
 *    flare and heat core, the elements this file's own comments call "the
 *    brightest thing in the game" — changes the clipped fraction by 0.11 pp out
 *    of 7.85. It is bright, but it is small and it is not what covers the plate.
 *  - **Tightening the light's falloff does nothing.** `impactLight.distance`
 *    taken from 6.5 m to 4.0 m and to 3.0 m changed the frame by 0.001 pp and
 *    0.002 pp — identical to three decimal places. The struck plate is a few
 *    tens of centimetres from the light, far inside the window, so `distance`
 *    only trims a periphery that was never clipping. Amplitude is the only
 *    lever the light has.
 *
 * `light` is therefore compressed at the TOP of the ladder and left alone at the
 * bottom. The over-exposure is entirely a heavy/launcher/ultra problem — the jab
 * frame `15-impact-light` carries 30 clipped pixels in the whole image — and the
 * bottom two rungs were raised once already, on measurement, because a landed
 * jab was indistinguishable from no jab. So LIGHT moves 3.6 -> 3.4 and ULTRA
 * moves 17.0 -> 6.8, and the ladder stays strictly monotonic.
 *
 * `impact` — the amplitude of `OverlayPass`'s radial smear and its heat spill —
 * is cut to about a quarter. It costs nothing at the bottom of the ladder
 * because the two light tiers never fired one, and it is the single largest
 * contributor to the *shape* of the defect rather than just its size: the smear
 * is a seven-tap zoom blur toward the contact, so it takes the compact hot core
 * and drags it across the plate as one continuous mass. That is why the frame
 * read as "a few huge white blobs" against the reference's many small ones.
 * The largest connected clipped blob falls 23,736 px -> 3,384 px on the same
 * frozen frame with the smear at 0.30 and the light at 0.40.
 *
 * The speed lines were measured separately and are NOT touched: zeroing
 * `impact.lines` on the same frozen frame changed the clipped fraction by
 * 0.000 pp. They are additive white, but they live at 0.28-0.58 of the frame
 * height from the contact and never overlap the blown region.
 *
 * The other `#flashLight` call sites — block, parry, armour, part break, super
 * — are deliberately left alone. They fire on frames this was not measured on,
 * at different framings and distances, and a number changed without a frame to
 * check it against is not a fix.
 *
 * ---
 *
 * ROUND 18: THE LIGHT'S AMPLITUDE WAS NEVER THE PROBLEM. ITS POSITION WAS.
 *
 * (Its conclusion that position is the lever stands and is the basis of the
 * round below. Its *sign* does not: `lightLift` is now -0.20, not +0.60, and the
 * +0.60 figures in this section are the superseded ones. Read ROUND 19 first.)
 *
 * The round that cut the amplitude was right that the impact light owns the
 * over-exposure and wrong about which of its numbers to reach for. Measured by
 * toggling one frozen `04-impact` contact frame in place — launcher, +1
 * rendered frame, sim paused, render clock pinned to 1/60 through the freeze
 * and 0 after it, `FightCamera.render` stubbed, adaptive resolution pinned,
 * grain and chroma off — the control repeats to the last digit, so every number
 * below has a noise floor of **0.000**:
 *
 *                                clipped %   hot px    detail   core sat
 *     round 17                     4.103      62303     22.73    0.1304
 *     ...hue only                  3.524      55666     23.69    0.1513
 *     ...position only             2.408      52656     25.33    0.1357
 *     BOTH (shipped)               2.371      48665     25.72    0.1463
 *     impact light silenced        2.311      43521     27.59    0.1272
 *
 * over a 340 px disc on the projected contact. `hot px` is the region at
 * luma >= 200/255; `detail` is the RMS of ( L - box9(L) ) inside it, which is
 * the high-frequency energy — panel lines, bevels, edge wear — that a blown-out
 * region does not have; `core sat` is mean (max-min)/max over the same region.
 *
 * Read the first and last rows together and the defect is stated exactly: the
 * light was contributing **1.79 of the 4.10 percentage points of clipped white
 * — 44% of it — and taking a third of the frame's local contrast with it.** The
 * same ablation on the untouched `16-impact-heavy` frame gives 0.805% with the
 * light and 0.791% without: **1.7%**. That is the whole difference between the
 * tier that works and the tier that does not, and it is not a difference of
 * radiance. It is that a launcher's contact point lands under a large plate
 * facing the camera with the light buried a few centimetres inside it.
 *
 * So `lightLift` is the same correction this file has already made four times.
 * `e.point` is a capsule intersection, i.e. INSIDE the armour: the flare, the
 * heat core, the spark spawn and the contact front have each had to be moved out
 * along the view ray to be seen at all, and the light was the last element still
 * buried in the robot, lighting a plate from 5 cm at 1/r^2. Moved 0.60 m out —
 * along the VIEW RAY, so its screen position does not move one pixel — its share
 * of the clipped white falls to **2.5%, the heavy tier's number**, while it
 * still puts 5,000 hot pixels on the plate that the silenced light does not.
 * The lift was swept on one frozen frame: 0.30 / 0.45 / 0.60 / 0.80 / 1.00 /
 * 1.30 m give clipped 0.651 / 0.520 / 0.512 / 0.507 / 0.506 / 0.506 against a
 * 0.504 floor. Clipping is already at the floor by 0.60; past it the light only
 * fades toward being switched off, so 0.60 is the knee and not a guess.
 *
 * `lightHex` is the other half, and it is the "re-spend it as colour" step. At
 * 0xffd0a0 all three channels saturate together and the plate goes cream; at
 * 0xff9d4a the blue channel keeps most of its headroom, so the trim colour, the
 * stencils and the panel gaps survive the same candela. It buys 0.58 pp of
 * clipped white and +16% core saturation on its own, and after it the struck
 * plate is MORE saturated than the same frame with the light switched off
 * entirely (0.1463 against 0.1272) — which is what "the energy is being
 * delivered as colour rather than as luminance" means as a number.
 *
 * **`light` itself is deliberately unchanged, and the ladder stays strictly
 * monotonic.** A sweep of the amplitude on the frozen frame — 0.85 / 0.70 /
 * 0.55 of the shipped value — moves clipped white by 0.003 pp and detail by
 * 0.26 once the position is fixed. The brief for this round named the 5.1 as
 * the constant to cut; on the frame it does almost nothing, and the camera is
 * not closer on `04-impact` either (contact-to-camera 4.87 m against the
 * heavy's 4.41 m — the heavy shot is the closer one).
 *
 * Three more things were disproved on the same frame and are recorded so nobody
 * re-tries them:
 *
 *  - **`FRONT_HEAT_GAIN` is not a lever here.** Silencing the camera-facing
 *    contact front outright — the other constant this round was pointed at —
 *    moves clipped white by 0.09 pp and detail by 0.09. It is doing its job on
 *    the light tier, where it was measured into existence, and it is not what
 *    blows out a launcher.
 *  - **`impact` (the radial smear) is usually not even in the frame.** At
 *    `decay: 18` and the 0.6 hitstop FX clock, a launcher's 0.17 is gone in
 *    9 ms of FX time, which is less than one rendered frame at contact. It was
 *    measured at 0.00 to 0.12 across runs depending only on how long that one
 *    frame took. The previous round's -3.40 pp for the overlay was measured
 *    before its own cut and does not describe the current constants.
 *  - **The flare's tint is not a lever either.** Pulling the flash and heat
 *    core tints toward amber by 0.35 and 0.55 changes core saturation by 0.0002.
 *    The flare saturates to white at its centre by construction and it is small;
 *    the colour that reaches the eye off a hit is the colour the LIGHT puts on
 *    the armour.
 *
 * ULTRA takes the hue and NOT the lift, on measurement. The only ULTRA contact
 * the harness can produce is a ground-level slam (`siegeSlam`; the overdrive
 * super frames at 10 m and shows nothing), and there the lift spreads the wash
 * across the floor instead of concentrating it: clipped 0.448 -> 0.219 but hot
 * area 42.9k -> 51.4k and detail 25.31 -> 22.87. The hue alone is better or
 * neutral on every metric (clipped 0.336, detail 25.14, sat 0.1529 -> 0.1660),
 * so that is what ships. A chest-height ultra would probably want the lift;
 * there is no frame to prove it on, so it does not get one.
 *
 * One property of the capture worth knowing before trusting any number off
 * `04-impact`: the harness does not pin the clock between contact and its +1
 * shutter, and the light's envelope is `peak * d^2` with `d` falling at 18/s of
 * FX time. At a 16 ms frame it delivers 0.67 of peak; at 93 ms it delivers
 * ZERO. Three probe runs of an unchanged build measured 4.63%, 4.35% and 0.65%
 * clipped for exactly that reason — on a loaded machine the scored frame is
 * sometimes photographed with the impact light already extinguished.
 *
 * ---
 *
 * ROUND 19: THE LIFT WAS THE RIGHT KNOB AND IT WAS TURNED THE WRONG WAY.
 * `lightLift` GOES FROM +0.60 TO -0.20 — BEHIND THE CONTACT, NOT IN FRONT.
 *
 * The round above optimised the launcher's light against **clipped white**, and
 * clipped white is not the defect. Measured on one frozen `04-impact` contact
 * frame with the light moved in place — same session, same frame, sim paused,
 * render clock pinned to 0, camera stubbed, grain and chroma off, so the
 * control repeats to the last digit and the noise floor is **0.000** — the
 * whole-frame clipped fraction is 0.173 % at lift +0.60 and 0.171 % at lift 0.
 * It does not move. It cannot: the blow-out that a critic sees on this frame is
 * not white, it is a **mid-tone additive veil** at luma 200-250 that fills the
 * panel gaps and takes the armour's local contrast with it, and no
 * clipped-white statistic can see it.
 *
 * The statistic that does see it is the fraction of the contact ROI with **any
 * channel saturated**, and on that the tier gap the brief describes is real and
 * large. Over a 260 px disc on the projected contact, both tiers at ~5.0 m,
 * everything below from ONE frozen frame per tier:
 *
 *                       hot px    local     mid-tone   ROI    core    any-chan
 *                        >=235   contrast   contrast   p05    sat     clipped
 *     launcher, +0.60    30872    10.388     11.162    23.5   .1738    14.19 %
 *     launcher, -0.20    22086    11.863     12.169    15.4   .1632     7.19 %
 *     16-impact-heavy    16973    10.245      9.714    11.9   .1630     7.27 %
 *
 * `local contrast` is the RMS of ( L - box9(L) ) over the whole ROI;
 * `mid-tone contrast` is the same restricted to 60 <= L < 200, the band the
 * panel lines and edge wear actually live in; `p05` is the 5th percentile of
 * luma, i.e. how dark the darkest gaps still are.
 *
 * Read the three rows together. The launcher was running **1.95x the heavy's
 * saturated-channel area**; it now runs 0.99x of it — the rung it is supposed to
 * be one step above, reached without touching a single count. Every contrast
 * statistic goes the other way at the same time: local contrast +14.2 %,
 * mid-tone +9.0 %, and the 5th percentile falls from 23.5 to 15.4, which is the
 * panel gaps getting their shadow back. It still puts 5,100 hot pixels on the
 * plate that switching the light off does not, and it keeps 30 % more hot area
 * than the heavy, so the ladder still reads. At 3x the struck chest plates go
 * from a single cream slab to plates with gaps, bevels and saturated blue trim,
 * with the flare's pinpoint still the brightest thing in the frame.
 *
 * The only thing it costs is 6 % of the hot region's colour saturation
 * (.1738 -> .1632), which lands it on the heavy's .1630.
 *
 * `04b-impact-decay`, the +8-frame shot, moves the same way for free: hot pixels
 * 8,026 -> 6,864 and saturated-channel area 4.14 % -> 3.05 %.
 *
 * **Why behind and not in front.** A point light 0.6 m off a large
 * camera-facing plate is a soft, even, low-gradient wash across the whole plate
 * — the worst possible thing to add to a surface whose readability is entirely
 * in its high frequencies. Put the same light *inside* the plate and its
 * camera-facing face gets almost nothing (N·L points away), while the gap
 * walls, the bevels and the plates canted away from it get raked. The energy
 * lands on the edges instead of on the faces. That is also the honest physical
 * story: the flash is struck *in* the metal, and what the camera sees is what
 * escapes through the gaps.
 *
 * The whole sweep, on one frozen frame, lift in metres along the view ray
 * (positive = toward the camera), amplitude unchanged at 5.1. `off` is the same
 * frame with the light silenced, which is the floor every column runs to:
 *
 *     lift      +0.60  +0.45  +0.30  +0.15   0.00  -0.10  -0.20  -0.35  -0.50    off
 *     hot px    30872  33893  36182  29797  23156  22560  22086  21841  21758  21591
 *     any-chan  14.19  16.45  17.19  13.13   8.00   7.55   7.19   6.83   6.65   6.41
 *     contrast  10.39  10.09  10.04  10.89  11.79  11.85  11.86  11.88  11.88  11.62
 *     mid-tone  11.16  10.93  10.84  11.48  12.19  12.21  12.17  12.18  12.16  12.02
 *     core sat  .1738  .1733  .1643  .1705  .1648  .1639  .1632  .1620  .1609  .1590
 *
 * **+0.30 is the worst point of the entire curve** — a light sitting just clear
 * of the surface is the maximum-wash position — and the previous round swept
 * 0.30 / 0.45 / 0.60 / 0.80 / 1.00 / 1.30, which is only the descending arm on
 * the far side of that peak. Every number it saw improved with distance, so it
 * concluded the answer was further out. It was, in that range. The range
 * excluded the answer.
 *
 * -0.20 is the knee and it is chosen on the whole row, not on one column. By
 * -0.20 the contrast columns have flattened to within 0.02 of their floor and
 * the saturated-channel area is already below the heavy's 7.27; past it only
 * the colour keeps draining toward the light-off floor, which is spending the
 * light for nothing. Note also that everything from 0.00 outward beats the
 * light-off row on contrast as well as on brightness — the light is not merely
 * being dimmed, it is being spent on edges instead of on faces.
 *
 * **The amplitude was tested again and is deliberately unchanged.** Compensating
 * the negative lift with gain buys a little of the lost saturation back and
 * costs the same amount of saturated-channel area — at -0.20, x1.6 gives core
 * sat .1656 and any-chan 7.58, x2.0 gives .1667 and 7.82, against .1632 and
 * 7.19 at x1.0. It is a wash, and it is not worth breaking the `light` ladder
 * for: 5.1 x 1.6 is 8.2, which would overtake ULTRA's 6.8 and make the ladder
 * non-monotonic in a field this file has twice been corrected for. One constant
 * moves; nothing else does.
 *
 * Two things were re-measured on the same frame and are NOT levers, confirming
 * the round above rather than contradicting it:
 *
 *  - **`distance` still does nothing.** 6.5 -> 4.0 -> 2.6 -> 1.8 -> 1.2 m gives
 *    local contrast 10.759 / 10.759 / 10.761 / 10.787 / 10.891 against a 0.000
 *    noise floor. The struck plate is far inside the window at every value.
 *  - **`decay` is worse, not better.** Steepening the falloff to 3.0, with the
 *    amplitude compensated to hold the illuminance at the contact, takes hot
 *    pixels from 31.0k to 32.0k and local contrast from 10.80 to 10.64; at 3.0
 *    uncompensated it is 36.7k and 10.16. A steeper curve concentrates *more*
 *    energy in the near field, which is the direction the defect already runs.
 *
 * Three cautions about the instrument, all found while building it, because two
 * of them will silently corrupt any table produced this way:
 *
 *  - **Do not measure the first frame after the freeze.** One run in several,
 *    the frame grabbed immediately after `paused = true` is still settling and
 *    reads 30 % darker over the whole ROI (mean luma 104.7 against 138.5). Every
 *    later grab of that same frozen frame is then identical to the last digit.
 *    Render one throwaway variant first and treat the second as the control.
 *  - **Largest-connected-component statistics are not comparable across
 *    variants.** "Detail inside the hot core" flips which blob it is measuring
 *    when the impact's own core stops being the biggest one in the ROI, so it
 *    jumps 3.66 -> 1.85 between lift -0.10 and -0.20 while every other column
 *    moves by a hundredth. Total hot area and RMS over the whole ROI do not have
 *    that failure mode; prefer them.
 *  - **All-channels-clipped on this frame is mostly the stage.** It reads 0.83 %
 *    for the launcher against 0.002 % for the heavy, which looks like a
 *    hundredfold tier defect and is not one: with the whole director silenced
 *    the launcher's ROI still reads 0.786 %, because an arena light bar crosses
 *    the frame at chest height behind the fighter. Any tier comparison here has
 *    to be run against a director-silenced baseline before it means anything.
 *
 * Finally, one number this round could not reproduce and does not believe. The
 * brief for it reported `04-impact` at "detail inside the hot core 11.23 against
 * 22.81 for the heavy tier, over a hot region 40 % larger". Measured on frozen
 * frames with a 0.000 noise floor, the two tiers' local contrast sits at 10.39
 * and 10.25 — within 1.4 % of each other, not 2x — and the launcher's hot region
 * is 82 % larger, not 40 %. The tier defect is real and it is the one in the
 * table above; the 2x contrast gap is not, and is most likely a cross-run
 * comparison of two differently-posed captures. See docs/PROFILING.md, trap 5.
 */
const HIT_FX = {
  /**
   * `sparkWindow` — the emission window, in seconds of FX time, and it is the
   * field that decides whether the contact frame shows sparks or shows a blob.
   *
   * Every other number in this table is a magnitude. This one is a *phase*: the
   * burst is spawned already spread along its own trajectories rather than
   * piled on one point, because the frame this axis is scored on is one
   * rendered frame past contact and at the 0.6 hitstop FX clock that is ten
   * milliseconds of travel. `SparkSystem.burst` carries the measurement — the
   * short version is that on a frozen `04-impact` the launcher's clipped white
   * fell from 1.343% to 0.633% with no spark removed, and 0.633 is the floor
   * with the sparks hidden entirely.
   *
   * It is not spent where the counts are: an ablation on the same frozen frame
   * puts the sparks at 16,000 of the launcher's 20,700 FX-added hot pixels and
   * at 2.35 of its 4.16 lost points of local contrast, against 3,300 and 0.54
   * for the flare and 1,900 and 0.28 for the contact front. The blow-out on
   * this tier is overdraw, and the count was never the thing to reach for.
   */
  /**
   * THE BOTTOM RUNG HAS TO BE VISIBLE, and it was not.
   *
   * Measured on the certified `15-impact-light` frame — a jab, landed, frozen
   * one rendered frame past contact — against the same frame with the whole
   * director silenced: the hit put **164 hot pixels** (luma > 0.93, r-b > 0.18)
   * on a 2.07-megapixel frame, 0.008% of it, against 1,865 for the launcher on
   * `04-impact`. A ladder whose bottom rung is eleven times below its middle
   * one is not a ladder, it is a hit that did not happen, and a critic reading
   * that frame is right to say a jab landing is indistinguishable from no jab
   * landing.
   *
   * The scale of the miss is worth stating precisely, because the temptation is
   * to reach for the counts. At the shutter the light tier had already emitted
   * all 254 of its sparks. They are invisible for three compounding reasons and
   * none of them is the count: the particles are 0.028 m against the launcher's
   * 0.04, they are thrown at 7.4 m/s against 11.4 so a frame later they have
   * barely cleared the plate they came off, and the flare is 0.26 m of radius
   * carrying 3.2 of radiance, which resolves to a twenty-pixel dot sitting on a
   * brightly lit chest. Size, speed and radiance are what deliver a hit on the
   * one frame anyone sees it; the count only decides how dense it looks once it
   * has travelled.
   *
   * So the two bottom rungs come up on exactly those three, and the ladder
   * stays strictly monotonic in every field: a light is still below a medium is
   * still below a heavy in count, size, speed, radiance, flare and candela.
   * Nothing above MEDIUM is touched — the top of the ladder was never the
   * complaint.
   */
  [WEIGHT.LIGHT]: {
    sparks: 260, jet: 92, speed: 8.4, size: 0.032, heat: 2.9, sparkLife: 0.18,
    sparkWindow: 0.040,
    ring: 0.33, ringLife: 0.13, thick: 0.095, ringHeat: 2.6,
    flash: 0.35, flashHeat: 3.9, flashLife: 0.075,
    core: 0.13, coreHeat: 3.1, coreLife: 0.42, ember: 14,
    debris: 0, fluid: 0, light: 3.4, impact: 0, dust: 0,
  },
  [WEIGHT.MEDIUM]: {
    sparks: 400, jet: 130, speed: 9.3, size: 0.035, heat: 3.2, sparkLife: 0.20,
    sparkWindow: 0.048,
    ring: 0.44, ringLife: 0.15, thick: 0.10, ringHeat: 3.0,
    flash: 0.44, flashHeat: 4.3, flashLife: 0.09,
    core: 0.16, coreHeat: 3.7, coreLife: 0.55, ember: 20,
    debris: 0, fluid: 5, light: 4.0, impact: 0, dust: 2,
  },
  [WEIGHT.HEAVY]: {
    sparks: 680, jet: 200, speed: 10.4, size: 0.038, heat: 3.4, sparkLife: 0.24,
    sparkWindow: 0.055,
    ring: 0.62, ringLife: 0.19, thick: 0.11, ringHeat: 3.4,
    flash: 0.56, flashHeat: 4.6, flashLife: 0.11,
    core: 0.19, coreHeat: 4.4, coreLife: 0.72, ember: 26,
    debris: 8, fluid: 12, light: 4.7, impact: 0.15, dust: 6,
  },
  [WEIGHT.LAUNCHER]: {
    sparks: 780, jet: 225, speed: 11.4, size: 0.04, heat: 3.5, sparkLife: 0.26,
    sparkWindow: 0.060,
    ring: 0.72, ringLife: 0.21, thick: 0.115, ringHeat: 3.6,
    flash: 0.62, flashHeat: 5.0, flashLife: 0.12,
    core: 0.21, coreHeat: 4.8, coreLife: 0.8, ember: 30,
    debris: 10, fluid: 14, light: 5.1, impact: 0.17, dust: 8,
    lightLift: -0.20, lightHex: 0xff9d4a, lightHexCounter: 0xffb877,
  },
  [WEIGHT.ULTRA]: {
    sparks: 1150, jet: 330, speed: 14.5, size: 0.048, heat: 4.0, sparkLife: 0.30,
    sparkWindow: 0.070,
    ring: 1.20, ringLife: 0.28, thick: 0.135, ringHeat: 4.2,
    flash: 0.7, flashHeat: 6.0, flashLife: 0.16,
    core: 0.28, coreHeat: 5.6, coreLife: 0.9, ember: 42,
    debris: 18, fluid: 26, light: 6.8, impact: 0.30, dust: 14,
    lightHex: 0xff9d4a, lightHexCounter: 0xffb877,
  },
};

/** Where the impact light sits, and what colour it is, when a tier says nothing. */
const LIGHT_HEX = 0xffd0a0;
const LIGHT_HEX_COUNTER = 0xfff0d8;
const LIGHT_LIFT_M = 0;

/**
 * How each impact shape throws its material.
 *
 * `HIT_FX` decides *how much* a hit produces, from its weight. This table
 * decides *where it goes*, from the geometry of the blow, and the two are
 * orthogonal on purpose: a heavy hook and a heavy piston should throw the same
 * mass of sparks in visibly different directions. Before this existed the only
 * input to an impact's appearance was its weight class, so every heavy hit in
 * the game looked the same however it had been thrown.
 *
 *   fanSpread  cone half-angle of the wide burst, 0 = pencil, 1 = hemisphere
 *   jetSpread  the same for the tight lance down the line of travel
 *   jetSpeed   how much faster the lance runs than the burst
 *   lift       how far the fan is tilted off the strike line toward vertical
 *   carry      share of the blow's speed inherited by the whole population
 *   ringAspect elongation of the pressure front along the blow
 *   ringScale  the front's size relative to the weight's nominal radius
 *   debris     shard and dust multipliers, because a blunt blow shatters more
 */
const SHAPE_FX = {
  [FX_SHAPE.THRUST]: {
    fanSpread: 0.44, jetSpread: 0.10, jetSpeed: 1.70, lift: 0.18, carry: 0.46,
    ringAspect: 2.3, ringScale: 0.60, debris: 0.9, dust: 0.8,
  },
  [FX_SHAPE.SLASH]: {
    fanSpread: 0.66, jetSpread: 0.20, jetSpeed: 1.40, lift: 0.10, carry: 0.54,
    ringAspect: 3.1, ringScale: 0.72, debris: 1.2, dust: 1.0,
  },
  [FX_SHAPE.RISING]: {
    fanSpread: 0.50, jetSpread: 0.13, jetSpeed: 1.60, lift: 0.52, carry: 0.42,
    ringAspect: 2.6, ringScale: 0.66, debris: 1.0, dust: 0.7,
  },
  [FX_SHAPE.CRUSH]: {
    fanSpread: 0.80, jetSpread: 0.30, jetSpeed: 1.15, lift: 0.06, carry: 0.34,
    ringAspect: 1.25, ringScale: 0.92, debris: 1.5, dust: 1.9,
  },
  [FX_SHAPE.DRILL]: {
    fanSpread: 0.30, jetSpread: 0.06, jetSpeed: 2.10, lift: 0.14, carry: 0.60,
    ringAspect: 2.9, ringScale: 0.50, debris: 0.8, dust: 0.6,
  },
};

/** Beats for a payload that arrives with no move metadata at all. */
const DEFAULT_TIMELINE = [
  { at: 0, parts: [FX_PART.FLASH, FX_PART.LIGHT, FX_PART.JET, FX_PART.PUNCH] },
  { at: 1, parts: [FX_PART.FAN, FX_PART.CORE] },
  { at: 2, parts: [FX_PART.RING, FX_PART.DEBRIS] },
  { at: 4, parts: [FX_PART.EMBER, FX_PART.FLUID] },
  { at: 6, parts: [FX_PART.DUST] },
];

/** Live hit contexts, and the beats scheduled against them. Fixed, never grown. */
const MAX_HIT_CONTEXTS = 8;
const MAX_BEATS = 128;

/**
 * Impact dust, once and for all. It is pulverised paint, concrete and oxide —
 * a warm neutral grey that the arena light colours, never the palette of
 * whichever robot happened to get hit.
 */
const DUST = new THREE.Color(0.46, 0.42, 0.37);

/**
 * The contact front — the pressure front ON the frame of contact.
 *
 * `docs/CRITIC.md` names "a shockwave with real expansion easing" as one of the
 * four things a 90 on this axis looks like. There is one, and until this it was
 * not in any of the frames the axis is scored on. Measured by hiding
 * `fx.shockwaves` on a genuinely frozen contact frame — one page session, one
 * frame, nothing else moving, control-shot noise floor 0.012-0.055 / 255 (the
 * camera has to be neutered to get that; see the report):
 *
 *                                          before          after
 *     04-impact       (launcher, +1 f)   0.000 / 255    1.564 / 255   3.5 % of ROI >= 8
 *     15-impact-light (jab,      +1 f)   0.000 / 255    2.311 / 255   5.2 % of ROI >= 8
 *
 * Zero before. Not "small" — the shockwave system was contributing no pixels at all to
 * two of the three certified contact frames. The cause is structural rather
 * than a tuning miss: `MoveSchema`'s beat tables put `RING` two to three ticks
 * after contact, and the shutter on those shots is ~1.2 ticks of FX time past
 * it, so the ring is still a pending beat when the frame is taken. The one ring
 * alive on `04-impact` belongs to the launch, not to the hit.
 *
 * The answer is not to move the authored beat. A front that has expanded away
 * from the flare is a *different* element from the front at the moment of
 * contact, and a real shock has both: an instantaneous compression at the
 * contact patch, and the ring that runs outward from it. So this fires on the
 * `FLASH` beat, which is tick 0 in every table in the game and is therefore the
 * one beat guaranteed to be on the money frame, and the authored `RING` is left
 * exactly where it is.
 *
 * Two of these numbers are load-bearing:
 *
 *  - **`RADIUS_FLOOR` is the contact patch, and it is deliberately almost
 *    weight-independent.** A fist is a fist. Scaling the front's radius off the
 *    weight recipe the way the expanded ring does reproduces the ladder's worst
 *    failure — at `15-impact-light`'s spacing a proportional front resolves to
 *    an 18-pixel smudge, which is the same "a jab landing is indistinguishable
 *    from no jab landing" the light tier was already corrected for once. The
 *    weight is carried by radiance and by how long the front lives, which is
 *    what actually differs between a jab and a launcher hitting the same plate.
 *  - **`LIFE_SHARE` is 0.6 of the authored ring's life**, which puts the front
 *    at 60-90% of its final radius on the money frame and gone within three to
 *    five rendered frames of the freeze. Anything that survives longer stops
 *    being a compression front and starts being the smoke ring this file's
 *    header warns about.
 *
 * **`FRONT_BAND_M` is the one that decides whether any of this is on screen at
 * all, and the first attempt got it wrong.** `ShockwaveSystem.thickness` is a
 * *fraction of the radius*, and the shader's razor front occupies about an
 * eighth of that band — so the front's world width is `0.04 * thickness *
 * radius` and shrinks with the ring. Passed the same 0.1-ish thickness the
 * expanded rings use, a 0.27 m contact front resolves to a razor **half a pixel
 * wide** at this framing. It rasterised, it was in the right place, it was
 * elongated along the blow, and it measured **0.109/255** over the contact ROI
 * because the only part of it wide enough to sample was the 0.17-amplitude
 * shoulder. Expressing the band as a width in metres and dividing by the radius
 * is what puts it back: it is the same correction the shader already applies
 * across a single ring's expansion, applied across rings of different size.
 *
 * **`FRONT_LIFT_M` is the second thing that decides whether it is on screen,
 * and it is the same defect this file has now fixed three times.** `e.point` is
 * a capsule intersection: it is inside the armour, and the armour plates stand
 * well proud of the capsule. The ring is depth-tested and has no soft-particle
 * fade, so at the flare's 0.2-0.28 m lift the front came out as a handful of
 * disconnected slivers where it happened to clear a plate edge — measured
 * **0.625/255**, and at 3x it read as speckle rather than as a front. Lifted
 * 0.6 m along the view ray, which is about half the body's depth plus the
 * plates, it clears the whole silhouette and measures **1.520/255**. The lift
 * is along the view ray, so it moves the front not one pixel sideways and grows
 * its projected size by about a tenth.
 *
 * `ringAspect` is taken as a **square root** here. The shader's anisotropy is
 * area-preserving — `vec2(a, 1/a)` — so the 2.3-3.1 the shape table hands the
 * expanded ring is a 5:1 to 10:1 sliver. That is right for a front that has run
 * a metre outward along the blow and wrong for the compression at the contact
 * patch, which is barely elongated at all. The square root keeps the direction
 * of the blow legible at about 2.5:1 and roughly doubles the pixels the front
 * covers: 1.520 -> 2.311 on the jab frame, and it is the step at which the
 * front stopped reading as a bright line and started reading as a front.
 *
 * The four steps, all on the same ROI and the same shot (jab, `15-impact-light`
 * geometry), because the order they were found in is the useful part:
 *
 *     nothing at all                                    0.000 / 255
 *     front spawned, expanded-ring thickness            0.109      razor sub-pixel
 *     band expressed in metres, radiance up             0.625      still occluded
 *     lifted 0.6 m clear of the armour                  1.520      visible at 3x
 *     aspect softened to sqrt                           2.311      reads as a front
 *
 * `distort` is 0 on purpose: the screen-space refraction stays on the authored
 * ring so that hiding `fx.shockwaves` removes exactly this element and nothing
 * else, which is what makes the before/after above a measurement rather than an
 * assertion.
 */
const FRONT_RADIUS_FLOOR = 0.16;
const FRONT_RADIUS_SHARE = 0.22;
const FRONT_LIFE_SHARE = 0.6;
const FRONT_HEAT_GAIN = 3.2;
const FRONT_BAND_M = 0.10;
const FRONT_LIFT_M = 0.60;

/**
 * How fast the impact light's envelope runs, in 1/seconds of FX time. 18 is a
 * 56ms window, which the 0.6 hitstop FX clock delivers in four to five rendered
 * frames — the 2-4 frame screen event `docs/CRITIC.md` asks for, with one frame
 * of grace because a light on geometry has to be seen falling, not just seen.
 */
const IMPACT_LIGHT_RATE = 18.0;

/**
 * The impact light's second term, and the answer to "there is no warm spill on
 * the armour" rather than to "the flash is too short".
 *
 * The flash above is a 2-4 frame screen event and it should stay one. But a hit
 * leaves a patch of metal at a few thousand kelvin, and that patch goes on
 * lighting everything within half a metre of it for as long as it glows — which
 * is `coreLife`, 0.42s to 0.9s, an order of magnitude longer than the flash.
 * Nothing in the frame was doing that: measured by ablation on a frozen contact
 * frame, the entire FlashSystem delivered 18 blown pixels at +4 rendered frames
 * against a scene-only 58, so four frames after contact the impact was leaving
 * no trace at the contact point at all.
 *
 * This is the one element of that glow that cannot be occluded by the plate it
 * sits on, and it is free: the light is already in the scene and permanently
 * visible (see the note on `impactLight`), so this is an intensity ramp on an
 * object that is billed whether it is lit or not. Creating or toggling a light
 * costs 437-831ms of material recompiles; modulating one costs nothing.
 *
 * `EMBER_SHARE` is a fraction of the same peak, so it scales with weight for
 * free. `EMBER_LIGHT_RATE` is 1/0.7s, the middle of the `coreLife` band, so the
 * spill dies with the heat that justifies it rather than outstaying it.
 */
const EMBER_SHARE = 0.085;
const EMBER_LIGHT_RATE = 1.45;

/** Bones that can carry a trail, with the joint that forms the ribbon's inner edge. */
const TRAIL_BONES = [
  ['hand_R', 'elbow_R', 1.0],
  ['hand_L', 'elbow_L', 1.0],
  ['foot_R', 'knee_R', 0.75],
  ['foot_L', 'knee_L', 0.75],
];

const TRAIL_START_SPEED = 7.2;   // m/s at the bone before a ribbon appears
const TRAIL_STOP_SPEED = 4.0;

/** Fallback identity colours when a fighter's palette is not known yet. */
const DEFAULT_ACCENT = [new THREE.Color('#FF7A2A'), new THREE.Color('#39D6FF')];

export class EffectsDirector {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/RenderPipeline.js').RenderPipeline} renderPipeline
   */
  constructor(scene, renderPipeline) {
    this.scene = scene;
    this.pipeline = renderPipeline;
    this.camera = renderPipeline?.camera || null;

    this.time = 0;
    this.floorY = GROUND_Y;
    this.quality = renderPipeline?.quality || 'ultra';
    this.budget = renderPipeline?.particleBudget ?? 1;
    this.enabled = true;

    /** Fighter instances, discovered from bus payloads. */
    this.fighters = [null, null];
    /** Cached scene-graph handles for the two fighter rigs. */
    this.rigs = [null, null];

    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.group.matrixAutoUpdate = false;

    /**
     * Screen-space punctuation state, decayed every frame on the FX clock.
     *
     * `docs/CRITIC.md` asks for screen effects that last 2-4 frames, and these
     * rates are what deliver that once the hitstop FX clock runs at 0.6 (see
     * `HITSTOP_FX_RATE`). Measured, launcher, clock pinned to 1/60: at decay 9
     * the radial smear was still on screen six frames after contact — and at
     * the old 0.08 FX clock, sixteen. The numbers here are chosen against the
     * delivered frame count, not against a nominal duration in seconds.
     */
    this.impact = { level: 0, decay: 18, lines: 0, linesDecay: 21, invert: 0, invertDecay: 30 };
    this.flash = { amount: 0, decay: 8 };
    this.overdrive = {
      on: false, t: 0, hold: 0, level: 0, desat: 0, flash: 0, bar: 0,
      fighter: null, color: new THREE.Color(0.4, 0.75, 1),
    };
    this.overlayCenter = new THREE.Vector2();
    this._speedSeed = 0;
    this._lightScan = 60;

    this._ringData = new Float32Array(MAX_DISTORT_RINGS * 4);

    // Presentation timeline. A hit fills one context and posts a handful of
    // beats against it; `update()` drains whatever has come due. Both rings are
    // built here so nothing on the hit path ever allocates.
    this._hits = [];
    for (let i = 0; i < MAX_HIT_CONTEXTS; i++) {
      this._hits.push({
        point: new THREE.Vector3(), spawn: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0),
        fan: new THREE.Vector3(), ember: new THREE.Vector3(), inherit: new THREE.Vector3(),
        hot: new THREE.Color(), ring: new THREE.Color(),
        shard: new THREE.Color(), coolant: new THREE.Color(),
        recipe: null, shape: null, roll: 0, scale: 1, counter: false, ultra: false,
      });
    }
    this._hitCursor = 0;
    this._beats = [];
    for (let i = 0; i < MAX_BEATS; i++) this._beats.push({ due: -1, part: '', hit: null });
    this._beatCursor = 0;
    /** Bound once; `update()` must not build a closure every frame. */
    this._onSplat = (x, y, z, size, r, g, b) => {
      this.decals.add(DECAL.OIL, x, z, size, {
        life: 22, strength: 0.85, tint: _c.setRGB(r, g, b),
      });
    };
    this._unsub = [];
    this._installedComposer = null;
    this._pass = null;
    this._ready = false;

    // MEASUREMENT ONLY, no behaviour change. Every number in the comments above
    // was produced by toggling one of these tables on a single frozen contact
    // frame, which is the only A/B on this axis with a zero noise floor -- a
    // fresh hit re-rolls the camera spring and the shutter frame, a mutation on
    // the live table does not. Handing the tables to the page is what makes
    // that possible without editing the file between arms of a pair.
    if (typeof window !== 'undefined') window.__kbFx = { HIT_FX, SHAPE_FX, director: this };
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  /** Bakes every texture, builds every pool, and wires the bus. */
  async init() {
    const renderer = this.pipeline?.renderer;
    const aniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
    this.textures = bakeFxTextures(this.quality, Math.min(aniso, 8));

    const b = this.budget;
    const n = (x) => Math.max(24, Math.round(x * b));

    // Sized against the worst realistic case rather than the theoretical one: a
    // three-hit juggle of launchers is a little under four thousand live sparks,
    // so this is a shade over two times headroom before the ring starts eating
    // the oldest burst.
    this.sparks = new SparkSystem(this.textures.spark, n(8192), this.floorY);
    this.fluid = new FluidSystem(this.textures.droplet, n(768), this.floorY);
    this.smoke = new SmokeSystem(this.textures.smoke, this.textures.curl, n(720));
    this.debris = new DebrisSystem(n(176), this.textures.shard, this.floorY);
    this.shock = new ShockwaveSystem(this.textures.ring, 48);
    this.flashes = new FlashSystem(64);
    this.decals = new DecalSystem(this.textures.decals, 160, this.floorY);
    // Eighteen samples is a third of a second of arc at 60Hz. Half a second of
    // history is long enough that the ribbon is still on screen after the limb
    // has changed direction twice, which reads as a smear rather than a swing.
    this.trails = new TrailSystem(10, 18);

    this.group.add(
      this.decals.mesh, this.smoke.mesh, this.fluid.mesh,
      this.debris.mesh, this.sparks.mesh, this.shock.mesh, this.trails.mesh,
      this.flashes.mesh,
    );

    // The impact light. Added to the scene once and never removed OR HIDDEN.
    //
    // Two separate mistakes were measured out of this one object.
    //
    // The first was `visible`. three.js counts only *visible* lights when it
    // builds a material's shader key, so flashing a hidden light on impact walked
    // `numPointLights` 4 -> 5 -> 6 and recompiled every material that got drawn.
    // Diffing `renderer.info.programs` across the stall frame showed 12, 20 and 8
    // new programs on those transitions, blocking a single frame for 494ms, 831ms
    // and 437ms. That is the mid-combat hitch. It also recurs once per light-count
    // variant, so three flashes overlapping would have bought a 7-light variant
    // and a fourth stall. The light now stays visible for the life of the scene
    // and is silenced with `intensity = 0`, which is not part of any shader key.
    //
    // The second was the pool size. Holding three of them visible fixes the
    // stall and then charges for it forever: measured by slow alternation with
    // the sim frozen and adaptive resolution pinned (fast toggling is invalid
    // here — see docs/PROFILING.md), 1 light costs 28.8ms/frame and 3 cost
    // 32.5ms, five cycles each, spread under 0.2ms. 3.7ms of a 29ms frame to
    // light flashes that cannot be told apart: a flash decays in 0.11s and even
    // juggle filler hits are 0.33s apart, so the second and third light were
    // almost always idle and always billed. One light, retargeted per impact,
    // with the brightest live flash winning — see `#flashLight`.
    this.impactLight = new THREE.PointLight(0xffd9a8, 0, 9, 2);
    this.impactLight.castShadow = false;
    this.impactLight.userData.decay = 0;
    this.impactLight.userData.ember = 0;
    this.impactLight.userData.hot = 0;
    this.group.add(this.impactLight);

    this.scene.add(this.group);

    this.#findStageLight();
    this.#applyQuality(this.quality);
    this.#subscribe();
    this._ready = true;
  }

  /**
   * Locates the arena key light so dust and smoke are lit by the same rig, and
   * calibrates the impact light against it.
   *
   * Lights are in physical units here, and the two kinds are not interchangeable:
   * a directional light's intensity is irradiance, a point light's is candela,
   * and a point light delivers `I / d^2`. So a flash that reads as "one key light
   * at arm's length" is `keyIntensity * d^2` candela, roughly `2.25 x` at 1.5m —
   * a couple of dozen, not a couple of hundred. Getting this wrong by the factor
   * a naive guess produces blows the entire frame to white through the bloom.
   */
  #findStageLight() {
    let best = null;
    let bestPower = -1;
    this.scene.traverse((o) => {
      if (!o.isDirectionalLight && !o.isSpotLight) return;
      const p = o.intensity * (o.isDirectionalLight ? 6 : 1);
      if (p > bestPower) { bestPower = p; best = o; }
    });
    this.keyLight = best;
    const key = best?.isDirectionalLight ? best.intensity : 3.0;
    this.lightScale = THREE.MathUtils.clamp(key / 3.0, 0.35, 3.0);
  }

  // -------------------------------------------------------------------------
  // bus wiring
  // -------------------------------------------------------------------------

  #subscribe() {
    const on = (evt, fn) => this._unsub.push(bus.on(evt, fn));

    // Fighters are never handed to this module, so they are learned from the
    // payloads that carry them. Trails do not depend on this; palettes do.
    this._unsub.push(bus.onAny((p) => {
      if (!p || typeof p !== 'object') return;
      this.#learn(p.fighter); this.#learn(p.attacker); this.#learn(p.defender);
    }));

    on('hit', (e) => this.#onHit(e));
    on('block', (e) => this.#onBlock(e));
    on('parry', (e) => this.#onParry(e));
    on('armorAbsorb', (e) => this.#onArmor(e));
    on('partBreak', (e) => this.#onPartBreak(e));
    on('launch', (e) => this.#onLaunch(e));
    on('knockdown', (e) => this.#onKnockdown(e));
    on('wallSplat', (e) => this.#onWallSplat(e));
    on('groundImpact', (e) => this.#onGroundImpact(e));
    on('footstep', (e) => this.#onFootstep(e));
    on('dash', (e) => this.#onDash(e));
    on('jump', (e) => this.#onJump(e));
    on('meterFull', (e) => this.#onMeterFull(e));
    on('superStart', (e) => this.#onSuperStart(e));
    on('superHit', (e) => this.#onSuperHit(e));
    on('roundStart', () => this.reset());
    on('roundEnd', (e) => this.#onRoundEnd(e));
    on('phase', (e) => { if (e?.phase === 'menu' || e?.phase === 'select') this.reset(); });
  }

  #learn(f) {
    if (!f || typeof f.index !== 'number' || !f.def) return;
    if (this.fighters[f.index] !== f) this.fighters[f.index] = f;
  }

  /**
   * Character colour lookup with a safe default, returned in a scratch colour.
   * @param {any} fighter
   * @param {'accent'|'emissive'|'primary'|'trim'} key
   * @param {THREE.Color} out
   */
  #palette(fighter, key, out) {
    const hex = fighter?.def?.palette?.[key];
    if (typeof hex === 'string') return out.set(hex);
    if (typeof hex === 'number') return out.setHex(hex);
    const idx = typeof fighter?.index === 'number' ? fighter.index & 1 : 0;
    return out.copy(DEFAULT_ACCENT[idx]);
  }

  /**
   * Billboard roll that puts a quad's local x-axis along a world direction as
   * the camera sees it. Impact effects that ignore this are identical whichever
   * way the blow travelled, which is the single clearest tell that a hit was
   * drawn rather than caused.
   * @param {THREE.Vector3} dir world-space direction of travel
   * @returns {number} roll in radians
   */
  #screenRoll(dir) {
    if (!this.camera) return 0;
    _roll.copy(dir).transformDirection(this.camera.matrixWorldInverse);
    if (_roll.x * _roll.x + _roll.y * _roll.y < 1e-8) return 0;
    return Math.atan2(_roll.y, _roll.x);
  }

  /**
   * How far the attacker's crown and feet sit from `cy`, in the aspect-corrected
   * half-heights `OverlayPass` measures its radii in: the frame is one unit
   * tall about its centre and `aspect` units wide. `cy` is the takeover's own
   * centre, so this is the subject's on-screen size as the overlay sees it.
   *
   * The overdrive treatment is keyed to this rather than to fixed fractions of
   * the frame. Measured across the super cinematic, the attacker goes from 24%
   * of the frame height at tick 45 to 74% at tick 149 — the camera dollies from
   * ten metres to under four while the move plays. A vignette written in screen
   * fractions is a ring around two small figures at the start of that shot and
   * a stain across both bodies at the end of it.
   *
   * Height, specifically, and only the attacker's. Two earlier versions were
   * wrong in the same way — both folded the distance across to the defender
   * into a number that is supposed to describe how big the subject is.
   * Measuring the furthest of the four foot-and-crown points read 0.81 against
   * a frame half-width of 0.89, so every radius downstream was larger than the
   * frame and the drain never engaged: background luma 0.295 against the
   * subject's 0.351, a ratio of 1.19. Restricting it to the vertical axis but
   * keeping both fighters still read 0.363 while the attacker occupied 28% of
   * the frame, because the defender is launched and is nowhere near the
   * attacker's chest in frame. Horizontal reach belongs in the vignette's own
   * aspect; the defender's height belongs to the defender.
   */
  #subjectScreenRadius(fighter, cy) {
    const cam = this.camera;
    if (!cam || !fighter?.position) return 0.2;
    const p = fighter.position;
    const h = FIGHTER_HEIGHT * (fighter.def?.proportions?.height ?? 1);
    let r = 0;
    for (let k = 0; k < 2; k++) {
      _v2.set(p.x, p.y + (k ? h : 0), p.z).project(cam);
      const d = Math.abs(_v2.y - cy) * 0.5;
      if (d > r) r = d;
    }
    return THREE.MathUtils.clamp(r, 0.07, 0.46);
  }

  // -------------------------------------------------------------------------
  // combat events
  // -------------------------------------------------------------------------

  /**
   * The direction of the blow, written to `out` as a unit vector.
   *
   * `velocity` is the striking bone's measured world displacement over the tick
   * that landed the hit — the direction the limb was actually travelling.
   * `normal` is the capsule separation axis, which is a property of where the
   * two boxes happened to be rather than of the strike, and using it is why
   * sparks used to spray along an arbitrary line. It stays as the fallback for
   * events that carry no swept velocity.
   * @param {Object} e bus payload
   * @param {THREE.Vector3} out
   */
  #blowDir(e, out) {
    const v = e.velocity;
    if (v && v.lengthSq() > 1.0) return out.copy(v).normalize();
    if (e.normal && e.normal.lengthSq() > 1e-6) return out.copy(e.normal).normalize();
    return out.set(e.attacker?.facing || 1, 0.2, 0).normalize();
  }

  /**
   * Fills a hit context from a bus payload and returns it.
   *
   * Everything the beats will need is frozen here, at contact: the direction of
   * the blow, the two derived spray axes, the shape table, and the palettes.
   * Beats fire over the following tenth of a second and the scratch registers at
   * the top of this file will have been reused a hundred times by then, so a
   * beat may not read anything it did not capture.
   */
  #openHit(e, recipe, counter, scale) {
    const c = this._hits[this._hitCursor];
    this._hitCursor = (this._hitCursor + 1) % this._hits.length;

    const shape = SHAPE_FX[e.move?.fx?.shape] || SHAPE_FX[FX_SHAPE.THRUST];
    c.point.copy(e.point);
    // Where the MATERIAL comes off, as against where the collision happened.
    //
    // `e.point` is a capsule intersection and is inside the armour by
    // construction, so a burst spawned there is behind the plate it came off
    // and the depth test discards it until the particles have flown clear. On a
    // launcher that is invisible because the fan is moving at eleven metres a
    // second and is out in one frame. On a jab it is the whole hit: 260 sparks
    // at 8.4 m/s have travelled 0.14 m at the frame `15-impact-light` freezes
    // on, which is still inside the chest they were struck out of.
    //
    // A fifth of a metre along the view ray. That is a smaller offset than the
    // fighter capsule's radius, it moves nothing sideways in frame, and it is
    // the same correction the heat core has carried since the round that
    // measured it — this only extends it to the material, which is the part of
    // a light hit that has to be seen.
    this.#towardCamera(e.point, 0.2, c.spawn);
    this.#blowDir(e, c.dir);
    c.shape = shape;
    c.recipe = recipe;
    c.counter = counter;
    c.scale = scale;
    c.ultra = e.move?.weight === WEIGHT.ULTRA;
    c.roll = this.#screenRoll(c.dir);

    // The wide fan carries the volume of the burst, tilted off the strike line
    // toward vertical so it stays legible against the floor. How far depends on
    // the shape: an uppercut drives its material straight up the front of the
    // body, a body check throws it sideways and barely lifts at all.
    c.fan.copy(c.dir).setY(c.dir.y * (1 - shape.lift) + shape.lift * 1.25).normalize();
    c.ember.set(c.dir.x * 0.28, 1.0, c.dir.z * 0.28).normalize();
    // Inherited velocity shifts the whole population downrange, so even the slow
    // motes drift the way the hit went.
    c.inherit.copy(c.dir).multiplyScalar(recipe.speed * shape.carry);

    this.#palette(e.attacker, 'emissive', _c2);
    c.hot.copy(_c2).lerp(_c.setRGB(1, 0.95, 0.88), 0.7);
    // A compression front is white-hot. The attacker's palette belongs in the
    // wake as a hint, not across the whole band: at 0.45 the ring came out a
    // flat salmon that read as painted plastic against the arena.
    c.ring.copy(_c2).lerp(_c.setRGB(1, 1, 1), 0.82);
    this.#palette(e.defender, 'trim', c.shard);
    this.#palette(e.defender, 'emissive', c.coolant);
    return c;
  }

  /**
   * Posts a move's beats against a hit context.
   *
   * `at` is in simulation ticks but the queue runs on the FX clock, which is
   * what makes this behave: hitstop stretches the clock, so the first two or
   * three beats land inside the freeze — the frames the player is actually
   * looking at — and the tail arrives as the reaction starts moving.
   */
  #schedule(c, timeline) {
    for (let i = 0; i < timeline.length; i++) {
      const beat = timeline[i];
      const due = this.time + Math.max(0, beat.at || 0) * TICK_DT;
      const parts = beat.parts;
      for (let k = 0; k < parts.length; k++) {
        const b = this._beats[this._beatCursor];
        this._beatCursor = (this._beatCursor + 1) % MAX_BEATS;
        b.due = due;
        b.part = parts[k];
        b.hit = c;
      }
    }
  }

  /** Drains every beat that has come due. Called once per frame. */
  #runBeats() {
    const beats = this._beats;
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.due < 0 || b.due > this.time) continue;
      b.due = -1;
      if (b.hit) this.#fire(b.part, b.hit);
    }
  }

  /**
   * Moves a contact point `d` metres along the view ray toward the camera and
   * writes it to `out`.
   *
   * A hit's `point` is a capsule intersection, which is *inside* the armour by
   * construction. Anything drawn there is depth-tested against the plate it is
   * supposed to be coming off. The lift is along the view ray specifically:
   * that is the one direction that cannot move the effect sideways in frame, so
   * it changes which side of the surface the sprite is on and nothing else.
   * @param {THREE.Vector3} point
   * @param {number} d metres
   * @param {THREE.Vector3} out
   */
  #towardCamera(point, d, out) {
    _eye.setFromMatrixPosition(this.camera ? this.camera.matrixWorld : this.scene.matrixWorld);
    out.copy(_eye).sub(point);
    const len = out.length();
    if (len > 1e-4) out.multiplyScalar(d / len);
    else out.set(0, 0, 0);
    return out.add(point);
  }

  /**
   * Spawns one element of an impact. Every case reads its geometry from the
   * context and its magnitude from the weight recipe, and nothing here knows
   * what tick it is on — the schedule already decided that.
   */
  #fire(part, c) {
    const r = c.recipe;
    const s = c.shape;
    const k = c.scale;

    switch (part) {
      // The flare at the contact point: the brightest element in the game and
      // the one the bloom pass actually feeds on. Its streak lies along the blow.
      //
      // Lifted off the struck surface for the same reason the core is, and it
      // is the same defect: `e.point` is a capsule intersection, so a flare
      // centred there is half inside opaque armour and the depth test and the
      // soft-particle fade take the half that matters. `FlashSystem` keeps only
      // 0.62 of its hot term where `dfade` is zero and kills the halo outright,
      // so a flare drawn *on* the plate loses a third of its core and all of
      // its bloom feed — which is most of what a light hit has.
      //
      // Half its own radius, capped: the lift is along the VIEW RAY, so it
      // moves the flare not one pixel sideways and changes its projected size
      // by a few percent. All it changes is which side of the plate it is on.
      case FX_PART.FLASH: {
        this.#towardCamera(c.point, Math.max(0.2, Math.min(0.28, r.flash * 0.55 * k)), _v3);
        this.flashes.pop(_v3, {
          size: r.flash * k, life: r.flashLife, heat: r.flashHeat * k,
          roll: c.roll, tint: c.hot,
        });
        // The compression at the contact patch, on the frame of contact. See
        // FRONT_* above: this is the beat the money frames are actually taken
        // on, and until this fired there was no shockwave in any of them.
        // Lifted FURTHER than the flare: the ring is depth-tested with no
        // soft-particle fade, so anything short of clearing the armour plates
        // outright comes back as disconnected slivers. `_v3` is rewritten here
        // after the flare has already consumed it.
        const frontR = FRONT_RADIUS_FLOOR + r.ring * s.ringScale * k * FRONT_RADIUS_SHARE;
        this.#towardCamera(c.point, FRONT_LIFT_M, _v3);
        this.shock.spawn(_v3, {
          mode: 'facing', tilt: c.roll, aspect: Math.sqrt(s.ringAspect),
          radius: frontR,
          life: r.ringLife * FRONT_LIFE_SHARE,
          thickness: Math.min(1, FRONT_BAND_M / (0.3 * frontR)),
          heat: r.ringHeat * FRONT_HEAT_GAIN * k,
          tint: c.ring,
          distort: 0,
        });
        break;
      }

      // The heat the flare leaves behind. Without it the contact point is dark
      // again four frames in, while the reaction animation is still playing.
      //
      // It has to be lifted off the surface it was struck on, and that is not a
      // fudge — it is the difference between a sphere *centred* on the contact
      // and a sphere *tangent* to it. `e.point` is the capsule intersection, so
      // a core spawned there is half inside opaque armour by construction, and
      // the half that is buried is the half that matters: `FlashSystem`'s cool
      // mode puts essentially all of its energy in a `exp(-56 r^2)` pinpoint
      // occupying the innermost fifth of the quad. The depth test discards it
      // and the soft-particle fade kills the halo around it.
      //
      // Measured by ablation on a frozen contact frame (launcher, fight
      // framing, ROI 220px on the projected contact, blown = L>240):
      //
      //                          +1f    +4f    +8f   +16f
      //     scene only          6777     58     52      0
      //     + whole FlashSystem 6863     18     53    112   <- delivers nothing
      //     + depthTest off     7062    223    204    113
      //     + origin pulled     7360    370    354    152
      //
      // while the shader was feeding that same core 89% and 79% of its peak
      // radiance at +4 and +8. The lifetimes were never the problem; the core
      // was inside the robot. Lifting it along the view ray by its own radius
      // both passes the depth test and lets the halo fade in against the plate,
      // which is what puts warm light back on the armour under the reaction.
      case FX_PART.CORE: {
        this.#towardCamera(c.point, Math.min(0.4, Math.max(0.11, r.core * 1.7 * k)), _v3);
        this.flashes.pop(_v3, {
          size: r.core * k, life: r.coreLife, heat: r.coreHeat * k, cool: true,
        });
        break;
      }

      // The tight lance straight down the line of travel. This is what makes the
      // direction readable in a single frame instead of leaving an isotropic ball.
      case FX_PART.JET:
        this.sparks.burst(c.spawn, c.dir, {
          count: r.jet * k, speed: r.speed * s.jetSpeed * k, spread: s.jetSpread,
          life: r.sparkLife * 0.8,
          inherit: _v3.copy(c.dir).multiplyScalar(r.speed * 0.5),
          size: r.size * 1.15, heat: r.heat * 1.15,
          // The lance runs ahead of the fan, so it is spread over a shorter
          // window: it is the leading edge of the ejecta, not the body of it.
          window: r.sparkWindow * 0.7,
        });
        break;

      case FX_PART.FAN:
        this.sparks.burst(c.spawn, c.fan, {
          count: r.sparks * k, speed: r.speed * k, spread: s.fanSpread,
          life: r.sparkLife, inherit: c.inherit, size: r.size, heat: r.heat,
          tint: c.counter ? _c.setRGB(1.0, 0.86, 0.72) : null,
          window: r.sparkWindow,
        });
        break;

      // Slow motes lofted out of the contact, so the burst has a near field that
      // is not travelling at ten metres a second. They are the tail of the same
      // event, not a second one: no inherited velocity, and dead a handful of
      // frames after the fast sparks are.
      case FX_PART.EMBER:
        if (!r.ember) break;
        this.sparks.burst(c.spawn, c.ember, {
          count: r.ember * k, speed: r.speed * 0.22, spread: 0.85,
          life: r.sparkLife * 1.25, size: r.size * 0.8, heat: r.heat * 0.85,
          window: r.sparkWindow,
        });
        break;

      // The pressure front, rolled onto the line of the hit and stretched along
      // it, so its long axis reads as the direction the force went.
      case FX_PART.RING:
        this.shock.spawn(c.spawn, {
          mode: 'facing', tilt: c.roll, aspect: s.ringAspect,
          radius: r.ring * s.ringScale * k,
          life: r.ringLife * (c.counter ? 1.15 : 1),
          thickness: r.thick, heat: r.ringHeat * k, tint: c.ring,
          distort: r.impact > 0 ? 1.1 * k : 0.45,
        });
        break;

      case FX_PART.DEBRIS:
        if (!r.debris) break;
        this.debris.burst(c.point, c.dir, {
          count: r.debris * s.debris * k, speed: 4.6, spread: 0.9,
          size: 0.055, life: 4.5, color: c.shard,
        });
        break;

      case FX_PART.FLUID:
        if (!r.fluid) break;
        this.fluid.spray(c.point, c.dir, {
          count: r.fluid * k, speed: 4.0, spread: 0.9,
          life: 1.2, size: 0.04, tint: c.coolant,
        });
        break;

      // Thrown clear of the contact along the blow, so the puff never sits on
      // top of the heat core and swallows the one bright thing in the frame.
      case FX_PART.DUST:
        if (!r.dust) break;
        _v3.copy(c.point).addScaledVector(c.dir, 0.18);
        this.smoke.puff(_v3, {
          count: Math.max(1, Math.round(r.dust * s.dust)), dir: c.dir,
          speed: 2.6, spread: 1.5, radius: 0.13, size: 0.15, growth: 1.7,
          life: 0.6, buoyancy: 0.32, curl: 1.1, tint: DUST,
        });
        break;

      // The impact light. Two things about it are decided here rather than in
      // `#flashLight`, because both are per-weight: WHERE it sits relative to
      // the plate it lights, and how much of its energy is delivered as colour
      // rather than as luminance. See the note above `HIT_FX` for the frames.
      case FX_PART.LIGHT: {
        // A NEGATIVE lift is meaningful and is what the launcher ships: it puts
        // the light *behind* the contact, inside the plate it just struck. See
        // ROUND 19 above. `#towardCamera` takes a signed distance along the view
        // ray, so the only thing to get right here is not to gate on `> 0`.
        const lift = r.lightLift ?? LIGHT_LIFT_M;
        const at = lift !== 0 ? this.#towardCamera(c.point, lift, _v3) : c.point;
        this.#flashLight(at, r.light * k,
          c.counter ? (r.lightHexCounter ?? LIGHT_HEX_COUNTER) : (r.lightHex ?? LIGHT_HEX));
        break;
      }

      case FX_PART.PUNCH:
        if (r.impact > 0) this.#punch(c.point, r.impact * k, c.ultra);
        break;

      default:
        break;
    }
  }

  /**
   * A hit no longer dumps every element onto one tick. It opens a context and
   * hands the move's own beat table to the scheduler; `#fire` does the spawning
   * over the following two to eight ticks. Moves that never authored a timeline
   * still get one, derived from their own data by `MoveSchema.resolveFx`.
   */
  #onHit(e) {
    if (!this.enabled || !e?.point) return;
    const recipe = HIT_FX[e.move?.weight] || HIT_FX[WEIGHT.MEDIUM];
    const counter = !!e.counter;
    const c = this.#openHit(e, recipe, counter, counter ? 1.35 : 1);
    this.#schedule(c, e.move?.fx?.timeline || DEFAULT_TIMELINE);
  }

  #onBlock(e) {
    if (!this.enabled || !e?.point) return;
    this.#palette(e.defender, 'emissive', _c);
    // A guard throws the blow's own energy back the way it came, so the spray
    // is the reverse of the swept limb rather than a fixed sideways puff.
    this.#blowDir(e, _n).negate().setY(0.25).normalize();
    const roll = this.#screenRoll(_n);

    this.sparks.burst(e.point, _n, {
      count: 210, speed: 7.2, spread: 0.34, life: 0.2, size: 0.028,
      heat: 2.6, tint: _c2.copy(_c).lerp(_c3.setRGB(1, 1, 1), 0.6),
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.9, radius: 0.42, life: 0.16,
      thickness: 0.15, heat: 2.6, tint: _c, distort: 0.4,
    });
    this.flashes.pop(e.point, { size: 0.3, life: 0.08, heat: 3.4, roll, tint: _c });
    this.flashes.pop(e.point, { size: 0.13, life: 0.34, heat: 2.2, cool: true });
    this.#flashLight(e.point, 4, 0xbfe4ff);
  }

  #onParry(e) {
    if (!this.enabled || !e?.point) return;
    this.#palette(e.defender, 'emissive', _c);
    this.shock.spawn(e.point, {
      mode: 'facing', radius: 0.8, life: 0.26, thickness: 0.14,
      heat: 4.6, tint: _c2.copy(_c).lerp(_c3.setRGB(1, 1, 1), 0.5), distort: 1.2,
    });
    this.sparks.burst(e.point, _v.set(0, 1, 0), {
      count: 320, speed: 8.5, spread: 1.0, life: 0.26, size: 0.032, heat: 3.2, tint: _c,
    });
    this.flashes.pop(e.point, { size: 0.6, life: 0.11, heat: 4.4, tint: _c });
    this.flashes.pop(e.point, { size: 0.24, life: 0.55, heat: 3.2, cool: true });
    this.#flashLight(e.point, 9, 0xd8f0ff);
    this.#punch(e.point, 0.3, false);
  }

  #onArmor(e) {
    if (!this.enabled || !e?.point) return;
    this.sparks.burst(e.point, _v.set(0, 0.6, 0).normalize(), {
      count: 260, speed: 5.4, spread: 1.0, life: 0.22, size: 0.032, heat: 2.7,
    });
    this.shock.spawn(e.point, {
      mode: 'facing', radius: 0.52, life: 0.19, thickness: 0.2, aspect: 1.3,
      heat: 2.4, tint: _c.setRGB(1, 0.62, 0.24), distort: 0.5,
    });
    this.flashes.pop(e.point, { size: 0.4, life: 0.085, heat: 3.4, tint: _c.setRGB(1, 0.62, 0.24) });
    this.flashes.pop(e.point, { size: 0.18, life: 0.5, heat: 2.8, cool: true });
    this.#flashLight(e.point, 6, 0xffb066);
  }

  #onPartBreak(e) {
    if (!this.enabled || !e?.point) return;
    _n.set(e.fighter?.facing ? -e.fighter.facing : 1, 0.5, 0).normalize();
    const roll = this.#screenRoll(_n);
    this.#palette(e.fighter, 'trim', _c);

    this.debris.burst(e.point, _n, {
      count: 18, speed: 6.4, spread: 1.3, size: 0.085, life: 6.5, color: _c,
    });
    this.sparks.burst(e.point, _n, {
      count: 700, speed: 9.6, spread: 0.72, life: 0.28, size: 0.04, heat: 3.4,
    });
    this.#palette(e.fighter, 'emissive', _c2);
    this.fluid.spray(e.point, _n, {
      count: 40, speed: 5.0, spread: 1.1, life: 1.6, size: 0.05, tint: _c2,
    });
    this.smoke.puff(e.point, {
      count: 10, dir: _n, speed: 2.4, spread: 1.6, radius: 0.2,
      size: 0.32, growth: 1.5, life: 1.2, buoyancy: 0.5, curl: 1.1,
      tint: _c.setRGB(0.34, 0.31, 0.28),
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.6, radius: 0.85, life: 0.26, thickness: 0.2,
      heat: 3.6, tint: _c2, distort: 1.0,
    });
    this.flashes.pop(e.point, { size: 0.7, life: 0.13, heat: 5.0, roll });
    this.flashes.pop(e.point, { size: 0.34, life: 0.95, heat: 4.6, cool: true });
    this.#flashLight(e.point, 16, 0xffc48a);
    this.#punch(e.point, 0.5, false);
  }

  #onLaunch(e) {
    if (!this.enabled || !e?.fighter) return;
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.1, life: 0.55, thickness: 0.22,
      heat: 1.6, tint: _c.setRGB(0.9, 0.86, 0.78), distort: 0.7,
    });
    this.#groundDust(_v, 7, 2.6, 0.26);
    // Boots tearing off the floor scrape a short ember shower out of the
    // concrete. It has to die with the launch itself: this burst is spawned at
    // floor level, so anything that outlives its own upward arc lands straight
    // back down and becomes a glowing pool at the fighters' feet — exactly where
    // there is no longer anything happening.
    _v3.copy(_v).setY(this.floorY + 0.12);
    this.sparks.burst(_v3, _v2.set(0, 1, 0), {
      count: 90, speed: 5.4, spread: 0.9, life: 0.26, size: 0.032, heat: 2.6,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.9, { life: 14, strength: 0.34 });
  }

  #onKnockdown(e) {
    if (!this.enabled || !e?.point) return;
    _v.copy(e.point); _v.y = this.floorY;
    this.#groundDust(_v, 11, 3.4, 0.32);
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.6, life: 0.6, thickness: 0.24,
      heat: 1.2, tint: _c.setRGB(0.86, 0.82, 0.76), distort: 0.6,
    });
    this.#palette(e.fighter, 'trim', _c);
    this.debris.burst(_v, _v2.set(0, 1, 0), {
      count: 6, speed: 3.4, spread: 1.4, size: 0.05, life: 5, color: _c,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 1.35, { life: 20, strength: 0.45 });
    this.decals.add(DECAL.FRACTURE, _v.x, _v.z, 0.8, { life: 22, strength: 0.35 });
    this.#flashLight(_v, 4, 0xd8c8b0);
  }

  #onWallSplat(e) {
    if (!this.enabled || !e?.point) return;
    _n.copy(e.normal && e.normal.lengthSq() > 1e-6 ? e.normal : _v.set(0, 1, 0)).normalize();
    const roll = this.#screenRoll(_n);
    this.sparks.burst(e.point, _n, {
      count: 820, speed: 11.6, spread: 0.62, life: 0.3, size: 0.046, heat: 3.6,
    });
    this.#palette(e.fighter, 'trim', _c);
    this.debris.burst(e.point, _n, {
      count: 12, speed: 6.0, spread: 1.0, size: 0.07, life: 5.5, color: _c,
    });
    this.smoke.puff(e.point, {
      count: 12, dir: _n, speed: 3.0, spread: 1.5, radius: 0.26,
      size: 0.36, growth: 1.6, life: 1.3, buoyancy: 0.4, curl: 1.0,
      tint: DUST,
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.5, radius: 1.25, life: 0.3, thickness: 0.22,
      heat: 3.8, tint: _c2.setRGB(1, 0.92, 0.82), distort: 1.3,
    });
    // The impact dust settles at the base of the wall.
    const fx = THREE.MathUtils.clamp(e.point.x, -ARENA_HALF_WIDTH + 0.3, ARENA_HALF_WIDTH - 0.3);
    const fz = THREE.MathUtils.clamp(e.point.z, -ARENA_HALF_DEPTH + 0.3, ARENA_HALF_DEPTH - 0.3);
    this.decals.add(DECAL.SCORCH, fx, fz, 1.1, { life: 24, strength: 0.55 });
    this.flashes.pop(e.point, { size: 0.8, life: 0.13, heat: 5.2, roll });
    this.flashes.pop(e.point, { size: 0.4, life: 1.0, heat: 4.8, cool: true });
    this.#flashLight(e.point, 18, 0xffd0a0);
    this.#punch(e.point, 0.7, false);
  }

  #onGroundImpact(e) {
    if (!this.enabled || !e?.point) return;
    const speed = Math.max(0, e.speed || 0);
    if (speed < 3) return;
    const k = THREE.MathUtils.clamp(speed / 12, 0.2, 1.6);
    _v.copy(e.point); _v.y = this.floorY;

    this.#groundDust(_v, Math.round(6 + 9 * k), 2.2 + 2.0 * k, 0.22 + 0.13 * k);
    this.shock.spawn(_v, {
      mode: 'ground', radius: 1.4 + 1.8 * k, life: 0.4 + 0.25 * k,
      thickness: 0.24, heat: 1.4 + k, tint: _c.setRGB(0.88, 0.84, 0.78),
      distort: 0.5 * k,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.7 + 0.8 * k, { life: 16, strength: 0.3 + 0.22 * k });
    if (k > 0.9) {
      this.sparks.burst(_v, _v2.set(0, 1, 0), {
        count: 240, speed: 5.0, spread: 1.0, life: 0.24, size: 0.03, heat: 2.5,
      });
      this.decals.add(DECAL.FRACTURE, _v.x, _v.z, 0.9, { life: 20, strength: 0.4 });
    }
  }

  #onFootstep(e) {
    if (!this.enabled || !e?.point) return;
    const force = THREE.MathUtils.clamp(e.force ?? 0.5, 0, 2);
    if (force < 0.15) return;
    _v.copy(e.point); _v.y = this.floorY + 0.02;
    this.smoke.puff(_v, {
      count: Math.round(1 + force * 3), dir: _v2.set(0, 1, 0), speed: 0.5 + force,
      spread: 0.9, radius: 0.14, size: 0.18 + force * 0.1, growth: 1.0,
      life: 0.65 + force * 0.3, buoyancy: 0.16, curl: 0.7,
      tint: _c.setRGB(0.42, 0.4, 0.37),
    });
    if (force > 0.8) this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.28, { life: 9, strength: 0.22 });
  }

  #onDash(e) {
    if (!this.enabled || !e?.fighter) return;
    const f = e.fighter;
    _v.copy(f.position);
    _v.y = this.floorY;

    // Ground wash behind the dash.
    const dir = e.dir || -(f.facing || 1);
    _v2.set(-dir * 1.4, 0.9, 0).normalize();
    _v3.copy(_v).setY(this.floorY + 0.12);
    this.smoke.puff(_v3, {
      count: 7, dir: _v2, speed: 2.4, spread: 1.2, radius: 0.3,
      size: 0.22, growth: 1.2, life: 0.8, buoyancy: 0.2, curl: 1.0,
      tint: DUST,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.5, { life: 8, strength: 0.28 });

    // Thruster plume from the dorsal unit, in the character's own light.
    this.#palette(f, 'emissive', _c2);
    _v.copy(f.position);
    _v.y += 1.15;
    _v.x += (f.facing || 1) * -0.22;
    this.smoke.puff(_v, {
      count: 14, dir: _v2, speed: 5.0, spread: 0.5, radius: 0.07,
      size: 0.11, growth: 1.6, life: 0.3, buoyancy: 0.05, curl: 0.45,
      tint: _c2, emissive: 0.9,
    });
    this.sparks.burst(_v, _v2, {
      count: 90, speed: 6.5, spread: 0.35, life: 0.3, size: 0.022,
      heat: 2.2, tint: _c2,
    });
    this.#flashLight(_v, 3, _c2.getHex());
  }

  #onJump(e) {
    if (!this.enabled || !e?.fighter) return;
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.#groundDust(_v, 6, 2.0, 0.24);
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.44, { life: 8, strength: 0.24 });
  }

  #onMeterFull(e) {
    if (!this.enabled || !e?.fighter) return;
    this.#palette(e.fighter, 'emissive', _c);
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.2, life: 0.75, thickness: 0.22,
      heat: 2.6, tint: _c, distort: 0.8,
    });
    _v3.copy(_v).setY(this.floorY + 0.4);
    this.smoke.puff(_v3, {
      count: 16, dir: _v2.set(0, 1, 0), speed: 2.6, spread: 0.9, radius: 0.42,
      size: 0.28, growth: 1.1, life: 1.1, buoyancy: 0.9, curl: 0.8,
      tint: _c, emissive: 0.55,
    });
    this.sparks.burst(_v.setY(this.floorY + 0.2), _v2.set(0, 1, 0), {
      count: 340, speed: 7.0, spread: 0.55, life: 0.45, size: 0.028, heat: 2.8, tint: _c,
    });
  }

  #onSuperStart(e) {
    if (!this.enabled || !e?.fighter) return;
    const f = e.fighter;
    this.#palette(f, 'emissive', _c);
    this.overdrive.on = true;
    this.overdrive.t = 0;
    // Long enough to cover the cinematic that runs over it. `FightCamera` holds
    // `super` for 220 ticks and the move slows the simulation to 0.35 for the
    // first 40 of them, which is 4.9 seconds of wall time; the treatment used
    // to build for 0.32s, hold for 1.1s and be gone by 1.65s. It therefore
    // covered the charge-up and none of the shot the camera had spent eighty
    // ticks pushing in to compose — the money frame played out against a fully
    // lit arena with no takeover on it at all. Held to the end of the dolly and
    // a little past the connect.
    this.overdrive.hold = 3.5;
    this.overdrive.fighter = f;
    this.overdrive.color.copy(_c);

    _v.copy(f.position);
    _v.y = this.floorY;

    // A column of charge: ground ring, rising embers, a coloured plume and a
    // scorch ring that stays on the floor after the move.
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.4, life: 0.75, thickness: 0.24,
      heat: 1.8, tint: _c, distort: 1.0,
    });
    _v3.copy(_v).setY(this.floorY + 0.1);
    this.sparks.burst(_v3, _v2.set(0, 1, 0), {
      count: 560, speed: 9.0, spread: 0.5, life: 0.5, size: 0.028,
      heat: 2.8, tint: _c,
    });
    // The plume is charged, not incandescent — in theory. In practice a soft
    // sprite this large, this dense (20 of them, each growing to 1.5x over a
    // life of 1.1s) and this close to a cinematic that dollies the camera in
    // over its first 60 ticks stops reading as volume and starts reading as an
    // opaque wall: measured against the contact-frame harness, it was the
    // largest single contributor to the charge-up whiteout, well ahead of the
    // spark burst or the point light (both tried and ruled out first). Smaller,
    // fewer, faster to clear and less self-lit keeps the coloured haze around
    // the fighter without it ever becoming the frame.
    _v3.setY(this.floorY + 0.7);
    this.smoke.puff(_v3, {
      count: 9, dir: _v2.set(0, 1, 0), speed: 3.6, spread: 1.0, radius: 0.24,
      size: 0.1, growth: 0.9, life: 0.6, buoyancy: 1.3, curl: 1.3,
      tint: _c, emissive: 0.1,
    });
    this.decals.add(DECAL.SCORCH, _v.x, _v.z, 1.9, {
      life: 26, strength: 0.7, tint: _c2.copy(_c).lerp(_c3.setRGB(0.2, 0.2, 0.2), 0.55),
    });
    _v3.setY(this.floorY + 1.1);
    this.#flashLight(_v3, 16, _c.getHex());
  }

  #onSuperHit(e) {
    if (!this.enabled) return;
    const d = e?.defender;
    _v.copy(d?.position || new THREE.Vector3());
    _v.y += 1.05;
    this.#palette(e?.attacker, 'emissive', _c);

    this.overdrive.flash = 1;
    _n.set(e?.attacker?.facing || 1, 0.2, 0).normalize();
    const roll = this.#screenRoll(_n);
    this.sparks.burst(_v, _v2.copy(_n).setY(0.55).normalize(), {
      count: 900, speed: 14.0, spread: 0.7, life: 0.34, size: 0.038, heat: 3.6,
    });
    this.shock.spawn(_v, {
      mode: 'facing', tilt: roll, aspect: 2.2, radius: 1.5, life: 0.32, thickness: 0.24,
      heat: 3.4, tint: _c, distort: 1.6,
    });
    this.shock.spawn(_v.clone().setY(this.floorY), {
      mode: 'ground', radius: 3.4, life: 0.65, thickness: 0.26,
      heat: 1.5, tint: _c, distort: 0.9,
    });
    this.#palette(d, 'trim', _c2);
    this.debris.burst(_v, _v2.set(0, 0.6, 0).normalize(), {
      count: 26, speed: 8.0, spread: 1.4, size: 0.09, life: 6, color: _c2,
    });
    // The super's flare is the brightest thing in the game and the camera is a
    // metre and a half away on this cinematic. It is sized for radiance, not for
    // coverage — `FlashSystem` caps its projected radius, and the drama comes
    // from the frame around it still being readable.
    this.flashes.pop(_v, { size: 0.62, life: 0.16, heat: 3.6, roll, tint: _c });
    this.flashes.pop(_v, { size: 0.26, life: 0.7, heat: 3.0, cool: true });
    this.#punch(_v, 1.0, true);
    this.#flashLight(_v, 10, 0xffffff);
  }

  #onRoundEnd(e) {
    if (!this.enabled) return;
    this.flash.amount = e?.ko ? 0.45 : 0.2;
    this.overdrive.on = false;
    this.overdrive.hold = 0;
  }

  // -------------------------------------------------------------------------
  // shared spawn helpers
  // -------------------------------------------------------------------------

  /**
   * A ring of dust kicked outward along the floor. Spawned a little above the
   * floor plane: a billboard whose centre sits on the ground cuts a hard line
   * across it on tiers that have no depth prepass to fade against.
   *
   * The life is short for the same reason the sparks' is. A puff that grows for
   * a second is at its largest and its most opaque at the end, so it is still a
   * solid tan mass sitting on the fighter's boots long after the blow that threw
   * it — which is the one place in the frame nothing should be drawing the eye.
   */
  #groundDust(at, count, speed, size) {
    const c = Math.max(1, Math.round(count * this.budget));
    _v3.copy(at).setY(at.y + size * 0.55);
    for (let i = 0; i < c; i += 4) {
      const a = Math.random() * Math.PI * 2;
      _v2.set(Math.cos(a), 0.42, Math.sin(a)).normalize();
      this.smoke.puff(_v3, {
        count: Math.min(4, c - i), dir: _v2, speed, spread: 0.7, radius: 0.24,
        size, growth: 1.2, life: 0.62, buoyancy: 0.18, curl: 1.1, tint: DUST,
      });
    }
  }

  /**
   * Aims the single impact light at a contact point. Nothing is created, added
   * or shown; the light already lives in the scene, so no material recompiles.
   *
   * With one light there is a contention rule to get right. Several beats can
   * flash in the same frame — a heavy connecting at 18 candela while a ground
   * scuff asks for 3 — and last-writer-wins would let the scuff extinguish the
   * hit. The brightest live flash keeps the light instead, which is also what
   * the eye would have read off three overlapping lights anyway.
   */
  #flashLight(at, intensity, hex) {
    const l = this.impactLight;
    if (!l || !this.lightsEnabled) return;
    const want = intensity * (this.lightScale ?? 1);
    // Contention is decided on the FLASH term alone. The ember tail deliberately
    // keeps a little intensity alive for most of a second, and comparing against
    // the total would let a dead hit's afterglow lock out the next live one.
    if (want < (l.userData.hot || 0)) return;
    l.position.copy(at);
    l.color.setHex(hex);
    l.intensity = want;
    l.userData.peak = want;
    l.userData.hot = want;
    l.distance = 6.5;
    l.userData.decay = 1;
    l.userData.ember = 1;
    // Born this frame, so it has not aged yet. `#runBeats` fires the flash and
    // `#updateLights` runs later in the same `update()`, which was charging the
    // contact frame — the one frame the whole effect exists for — a full step
    // of decay before it was ever drawn. Measured: 8.6 candela delivered on the
    // contact frame against a 14.6 authored peak, a 41% loss on the brightest
    // moment in the game. The same one-frame tax applied to the impact overlay.
    l.userData.fresh = true;
  }

  /**
   * Impact frame. Restrained on purpose: a short radial smear toward the
   * contact point, a few frames of speed lines, and — only for ULTRA — a single
   * inverted frame. Overusing this is the fastest way to make a game unreadable.
   */
  #punch(point, strength, extreme) {
    if (!this.camera) return;
    _v2.copy(point).project(this.camera);
    this.overlayCenter = this.overlayCenter || new THREE.Vector2();
    this.overlayCenter.set(
      THREE.MathUtils.clamp(_v2.x, -1, 1),
      THREE.MathUtils.clamp(_v2.y, -1, 1),
    );
    const s = Math.min(1, strength);
    this.impact.level = Math.max(this.impact.level, s);
    this.impact.lines = Math.max(this.impact.lines, s * 0.85);
    if (extreme) this.impact.invert = Math.max(this.impact.invert, 0.85);
    this._speedSeed = Math.random() * 90;
    this.impact.fresh = true;   // do not age it before it has been drawn once
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  /**
   * The one per-frame entry point.
   *
   * `alpha` is accepted for interface symmetry but deliberately unused: every
   * particle here is parameterised on the FX clock rather than on sim ticks, and
   * the bone matrices trails read from have already been interpolated by
   * `Fighter.render()` before this runs.
   *
   * @param {number} dt seconds of *visual* time (already scaled by hitstop)
   * @param {number} alpha simulation interpolation factor, 0..1
   */
  update(dt, alpha) {
    if (!this._ready) return;
    const step = Math.min(dt, 0.1);
    this.time += step;

    if (this.pipeline && this.pipeline.quality !== this.quality) {
      this.#applyQuality(this.pipeline.quality);
    }
    this.camera = this.pipeline?.camera || this.camera;
    // The environment can swap its rig when the lighting mood cross-fades.
    // Rescanning is a full scene traverse, so it is throttled to once a second.
    if ((!this.keyLight || !this.keyLight.parent) && --this._lightScan <= 0) {
      this._lightScan = 60;
      this.#findStageLight();
    }

    // Scheduled impact beats first: anything that comes due this frame must be
    // in the buffers before the systems flush them.
    this.#runBeats();

    this.#updateTrails(step);
    this.debris.update(step);

    this.sparks.update(this.time);
    this.fluid.update(this.time);
    this.smoke.update(this.time);
    this.shock.update(this.time);
    this.flashes.update(this.time);
    this.decals.update(this.time);

    // Coolant that has finished falling leaves a splat where it landed.
    this.fluid.drainSplats(this.time, this._onSplat);

    this.#updateLights(step);
    this.#updateLighting();
    this.#updateOverlay(step);
  }

  /**
   * Trails are driven by measured bone speed, so every fast limb streaks
   * whether or not its move declared one, and a move that *does* declare one
   * forces the ribbon on through its active frames.
   */
  #updateTrails(dt) {
    if (dt <= 0) return;
    if (!this._trailState) {
      this._trailState = [];
      for (let i = 0; i < 2; i++) {
        const slots = [];
        for (let k = 0; k < TRAIL_BONES.length; k++) {
          slots.push({ bone: null, joint: null, handle: -1, last: new THREE.Vector3(), primed: false });
        }
        this._trailState.push(slots);
      }
    }

    for (let fi = 0; fi < 2; fi++) {
      let rig = this.rigs[fi];
      if (!rig || !rig.parent) {
        rig = this.scene.getObjectByName(`fighter${fi}`) || null;
        this.rigs[fi] = rig;
        if (rig) for (const s of this._trailState[fi]) { s.bone = null; s.primed = false; }
      }
      if (!rig) continue;

      const fighter = this.fighters[fi];
      const forced = fighter?.currentMove?.trail || null;
      this.#palette(fighter, 'accent', _c);

      const slots = this._trailState[fi];
      for (let k = 0; k < TRAIL_BONES.length; k++) {
        const [boneName, jointName, width] = TRAIL_BONES[k];
        const s = slots[k];
        if (!s.bone) {
          s.bone = rig.getObjectByName(boneName) || null;
          s.joint = rig.getObjectByName(jointName) || null;
          s.primed = false;
          if (!s.bone) continue;
        }

        _v.setFromMatrixPosition(s.bone.matrixWorld);
        if (!s.primed) { s.last.copy(_v); s.primed = true; continue; }
        const speed = _v.distanceTo(s.last) / dt;
        s.last.copy(_v);

        const wanted = forced === boneName || speed > TRAIL_START_SPEED;
        const keep = forced === boneName || speed > TRAIL_STOP_SPEED;

        if (s.handle < 0 && wanted) {
          s.handle = this.trails.acquire(s.bone, s.joint, {
            tint: _c, extend: 0.5, width,
          });
        } else if (s.handle >= 0 && !keep) {
          this.trails.release(s.handle, 0.14);
          s.handle = -1;
        }
      }
    }

    this.trails.update(dt);
  }

  /**
   * Decays the impact light.
   *
   * A flash has to *snap*, and it has to reach zero on its own. The previous
   * envelope did neither: an `exp(-11 dt)` ramp gated by a separate linear
   * counter running at 9/s, which meant the light was still at 37% of peak when
   * the counter expired and cut it to zero outright. Measured on a launcher
   * with the clock pinned to 1/60: 14.6 candela at contact, still 5.4 nine
   * frames later, then a hard step to 0. A slow glow that ends in a pop is why
   * a bright impact still reads as a decal composited over the scene rather
   * than a light event inside it — the surrounding armour does brighten (+21%
   * measured against the same frame with the light silenced), it just never
   * brightens *suddenly*.
   *
   * One envelope now, `peak * d^2` over a fixed short window, which is fast at
   * the front, lands exactly on zero, and needs no cutoff. Nothing is created,
   * shown or hidden here — see the note on `impactLight` in the constructor for
   * why toggling a light's visibility is forbidden in this file.
   */
  #updateLights(dt) {
    const l = this.impactLight;
    if (!l || !this.lightsEnabled) return;
    const u = l.userData;
    if ((u.decay || 0) <= 0 && (u.ember || 0) <= 0) return;
    if (u.fresh) { u.fresh = false; return; }
    const peak = u.peak || l.intensity;
    const d = Math.max(0, (u.decay || 0) - dt * IMPACT_LIGHT_RATE);
    const e = Math.max(0, (u.ember || 0) - dt * EMBER_LIGHT_RATE);
    u.decay = d;
    u.ember = e;
    u.hot = peak * d * d;
    l.intensity = u.hot + peak * EMBER_SHARE * e * e;
    if (d <= 0 && e <= 0) l.intensity = 0;
  }

  /** Feeds the arena lighting and the depth prepass into the smoke shader. */
  #updateLighting() {
    if (!this.camera) return;
    const key = this.keyLight;
    if (key) {
      key.getWorldDirection(_lightDir);
      if (key.target) {
        _v.setFromMatrixPosition(key.matrixWorld);
        _v2.setFromMatrixPosition(key.target.matrixWorld);
        _lightDir.copy(_v2).sub(_v).normalize();
      }
      _c.copy(key.color).multiplyScalar(Math.min(2.4, 0.35 + key.intensity * 0.22));
    } else {
      _lightDir.set(0.4, -0.85, 0.32).normalize();
      _c.setRGB(1.0, 0.94, 0.86);
    }
    const env = this.scene.environment;
    _c2.setRGB(0.14, 0.17, 0.24);
    if (env && this.scene.environmentIntensity) _c2.multiplyScalar(this.scene.environmentIntensity);
    this.smoke.setLighting(_lightDir, _c, _c2, this.camera);

    // Soft particles, when the pipeline is running its depth prepass. The
    // flashes need it as much as the smoke does: a contact flare sits right on
    // the surface it struck, and without the fade its halo cuts a hard circular
    // arc across the fighter that reads as a sphere hanging in the air.
    const gbuffer = this.pipeline?._passes?.gbuffer;
    const depth = gbuffer?.depthTexture || null;
    const size = this.pipeline?.renderer?.getDrawingBufferSize?.(_size) || null;
    const w = size ? size.x : 1920;
    const h = size ? size.y : 1080;
    const near = this.camera.near ?? 0.15;
    const far = this.camera.far ?? 260;
    this.smoke.setDepth(depth, w, h, near, far);
    this.flashes.setDepth(depth, w, h, near, far);
  }

  /** Drives the composer overlay: refraction rings, impact frames, overdrive. */
  #updateOverlay(dt) {
    this.#ensurePass();
    const pass = this._pass;
    if (!pass) return;
    const u = pass.uniforms;

    // Screen-space refraction from the live shockwaves.
    if (this.camera) {
      const n = this.shock.writeDistortion(this.camera, this._ringData);
      for (let i = 0; i < MAX_DISTORT_RINGS; i++) {
        const o = i * 4;
        u.uRings.value[i].set(
          this._ringData[o], this._ringData[o + 1],
          this._ringData[o + 2], i < n ? this._ringData[o + 3] : 0,
        );
      }
    }

    // Impact frame decay. A punch fired earlier in this same `update()` has not
    // been drawn yet, so it skips one step — see `#flashLight`.
    const imp = this.impact;
    if (imp.fresh) {
      imp.fresh = false;
    } else {
      imp.level = Math.max(0, imp.level - dt * imp.decay);
      imp.lines = Math.max(0, imp.lines - dt * imp.linesDecay);
      imp.invert = Math.max(0, imp.invert - dt * imp.invertDecay);
    }
    this.flash.amount = Math.max(0, this.flash.amount - dt * this.flash.decay);

    u.uImpact.value = imp.level;
    u.uSpeedLines.value = imp.lines;
    u.uInvert.value = imp.invert > 0.5 ? 1 : 0;
    u.uSpeedSeed.value = this._speedSeed || 0;
    u.uFlashAmount.value = this.flash.amount;
    if (this.overlayCenter) u.uImpactCenter.value.copy(this.overlayCenter);
    u.uImpactTint.value.setRGB(1.0, 0.86, 0.7);

    // Overdrive envelope: build, hold, release.
    const od = this.overdrive;
    if (od.on) {
      od.t += dt;
      od.level = Math.min(1, od.t / 0.32);
      od.hold -= dt;
      if (od.hold <= 0) od.on = false;
    } else if (od.level > 0) {
      od.level = Math.max(0, od.level - dt * 1.8);
    }
    od.flash = Math.max(0, od.flash - dt * 5.5);
    od.desat = od.level * 0.94;
    // The bars lead the drain in and lag it out, so the crop arrives before the
    // world drains and is the last thing to leave.
    od.bar = od.on
      ? Math.min(1, od.bar + dt * 5.5)
      : Math.max(0, od.bar - dt * 2.4);

    u.uSuper.value = od.level;
    u.uDesat.value = od.desat;
    u.uSuperFlash.value = od.flash;
    u.uSuperBar.value = od.bar;
    if (od.color) u.uSuperColor.value.copy(od.color);
    if (od.fighter && this.camera && (od.level > 0 || od.bar > 0)) {
      _v.copy(od.fighter.position);
      _v.y += 1.0;
      _v.project(this.camera);
      u.uSuperCenter.value.set(
        THREE.MathUtils.clamp(_v.x, -1.2, 1.2),
        THREE.MathUtils.clamp(_v.y, -1.2, 1.2),
      );
      u.uSuperRadius.value = this.#subjectScreenRadius(od.fighter, _v.y);
    }

    u.uTime.value = this.time;
    pass.refreshActive();
  }

  /**
   * Keeps the overlay pass installed at the end of the composer. The render
   * pipeline rebuilds its chain whenever the quality tier changes, so this
   * checks identity every frame rather than assuming a one-time install.
   */
  #ensurePass() {
    const composer = this.pipeline?.composer;
    if (!composer) { this._pass = null; this._installedComposer = null; return; }
    if (composer === this._installedComposer && composer.passes.includes(this._pass)) return;

    this._pass = new OverlayPass();
    this._pass.setBeamTexture(this.textures.beam);
    const size = this.pipeline.renderer?.getDrawingBufferSize?.(_size);
    this._pass.setSize(size ? size.x : 1920, size ? size.y : 1080);
    composer.addPass(this._pass);
    this._installedComposer = composer;
  }

  // -------------------------------------------------------------------------
  // quality / lifecycle
  // -------------------------------------------------------------------------

  /** @param {'ultra'|'high'|'medium'|'low'} q */
  #applyQuality(q) {
    this.quality = q;
    this.budget = this.pipeline?.particleBudget ?? 1;
    const ultra = q === 'ultra';
    const high = ultra || q === 'high';

    // Silenced, not hidden, on the lower tiers: the light stays in the scene so
    // that changing tier mid-session cannot recompile the world either. It costs
    // its 2.6ms on every tier, which is the price of the tier switch being free.
    this.lightsEnabled = high;
    if (!high && this.impactLight) {
      // Clear the decay too: `#updateLights` is gated on `lightsEnabled`, so a
      // flash interrupted by a tier change would otherwise keep a live countdown
      // that nothing is advancing.
      this.impactLight.intensity = 0;
      this.impactLight.userData.decay = 0;
      this.impactLight.userData.ember = 0;
      this.impactLight.userData.hot = 0;
      this.impactLight.userData.fresh = false;
    }
    this.debris.setShadows(ultra);
    this.trails.setIntensity(high ? 1.6 : 1.3);
    this.sparks.setScale(high ? 1 : 1.15);
    this.flashes.setScale(high ? 1 : 0.9);
    // Hard ceiling on how much of the frame any single flare may cover, in NDC
    // half-heights. 0.46 puts the outer falloff at under a quarter of the frame
    // height, and the hot core is a fraction of that again. This is what stops a
    // super connecting at close range from whiting out the shot.
    this.flashes.setMaxRadius(0.46);
    this.smoke.setScale(high ? 1 : 1.2);
    this.smoke.material.uniforms.uOpacity.value = q === 'low' ? 0.72 : 1;
    this.fluid.setScale(1);
    this.decals.material.uniforms.uOpacity.value = q === 'low' ? 0.7 : 1;
  }

  /** Retires every live particle, decal, trail and screen effect. */
  reset() {
    if (!this._ready) return;
    this.sparks.reset();
    this.fluid.reset();
    this.smoke.reset();
    this.debris.reset();
    this.shock.reset();
    this.flashes.reset();
    this.decals.reset();
    this.trails.reset();
    for (const b of this._beats) { b.due = -1; b.hit = null; }

    if (this._trailState) {
      for (const slots of this._trailState) {
        for (const s of slots) { s.handle = -1; s.primed = false; }
      }
    }
    if (this.impactLight) {
      this.impactLight.intensity = 0;
      this.impactLight.userData.decay = 0;
      this.impactLight.userData.ember = 0;
      this.impactLight.userData.hot = 0;
      this.impactLight.userData.peak = 0;
      this.impactLight.userData.fresh = false;
    }

    this.impact.level = 0; this.impact.lines = 0; this.impact.invert = 0;
    this.impact.fresh = false;
    this.flash.amount = 0;
    this.overdrive.on = false;
    this.overdrive.level = 0;
    this.overdrive.desat = 0;
    this.overdrive.flash = 0;
    this.overdrive.bar = 0;
    this.overdrive.hold = 0;

    if (this._pass) {
      const u = this._pass.uniforms;
      u.uImpact.value = 0; u.uSpeedLines.value = 0; u.uInvert.value = 0;
      u.uSuper.value = 0; u.uDesat.value = 0; u.uSuperFlash.value = 0;
      u.uSuperBar.value = 0; u.uFlashAmount.value = 0;
      for (const r of u.uRings.value) r.set(0, 0, 0, 0);
      u.uActive.value = 0;
    }
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub.length = 0;
    this.scene.remove(this.group);
    this.sparks?.dispose();
    this.fluid?.dispose();
    this.smoke?.dispose();
    this.debris?.dispose();
    this.shock?.dispose();
    this.flashes?.dispose();
    this.decals?.dispose();
    this.trails?.dispose();
    if (this.textures) for (const t of Object.values(this.textures)) t.dispose();
    if (this._pass && this._installedComposer) {
      const i = this._installedComposer.passes.indexOf(this._pass);
      if (i >= 0) this._installedComposer.passes.splice(i, 1);
      this._pass.dispose();
    }
    this._pass = null;
    this._ready = false;
  }
}

export default EffectsDirector;
