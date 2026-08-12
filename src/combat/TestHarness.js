/**
 * Knockbots — scripted-state harness for the headless visual QA pass.
 *
 * `tools/capture.mjs` drives the game through `window.KB.testHarness` to reach
 * moments that are hard to reproduce by playing: a launcher connecting, a
 * three-hit juggle, the overdrive cinematic, a KO, the whole roster lined up.
 *
 * Everything here works by pushing the *real* simulation into the state we want
 * and then letting it run — a forced hit is a genuine move started at its impact
 * frame, not a fake event. That means the screenshots show what the game
 * actually looks like, which is the only thing worth grading.
 *
 * The harness is QA-only. It is never referenced from the gameplay path.
 */

import * as THREE from 'three';
import { METER_MAX, MAX_HEALTH, GROUND_Y, TICK_DT } from '../core/Constants.js';
import { bus } from '../core/Bus.js';
import { Input } from '../core/Input.js';
import { SCENARIOS, physicalFor } from '../core/Scenarios.js';
import { MOVES, findMoveByTag, getMove } from './Moves.js';
import { STATE, retimeFor, strikeAim } from './Fighter.js';
import { segSegDistSq } from './CombatSystem.js';

/** Tag search order when a caller asks for a semantic move name. */
const TAG_ALIASES = {
  launcher: ['launcher', 'reversalLauncher', 'heavy'],
  jab: ['jab', 'poke'],
  mid: ['mid', 'poke'],
  low: ['low', 'sweep'],
  sweep: ['sweep', 'low'],
  heavy: ['heavy', 'armor', 'rush'],
  special: ['special', 'rush'],
  throw: ['throw'],
  super: ['super'],
  armor: ['armor', 'heavy'],
  parry: ['parry'],
  evade: ['evade'],
};

/**
 * @param {Object} game the Game instance (window.KB)
 * @returns {Object} the harness object to expose as `game.testHarness`
 */
/** Scratch for the roster lineup's facing solve. */
const _lq = new THREE.Quaternion();
const _lv = new THREE.Vector3();
/** Scratch for `traceMove`'s closest-point outputs. */
const _tc1 = new THREE.Vector3();
const _tc2 = new THREE.Vector3();

export function makeTestHarness(game) {
  /** @type {Array<{at:number, fn:Function}>} */
  const scheduled = [];
  let raf = 0;
  let lineup = null;

  const fighters = () => game.fighters;

  function pump() {
    raf = 0;
    for (let i = scheduled.length - 1; i >= 0; i--) {
      if (game.tick >= scheduled[i].at) {
        const job = scheduled.splice(i, 1)[0];
        try { job.fn(); } catch (e) { console.error('[testHarness]', e); }
      }
    }
    if (scheduled.length) raf = requestAnimationFrame(pump);
  }

  /** Run `fn` once the sim has advanced `ticks` further. */
  function after(ticks, fn) {
    scheduled.push({ at: game.tick + ticks, fn });
    if (!raf) raf = requestAnimationFrame(pump);
  }

  function resolveMove(fighter, key) {
    const set = MOVES[fighter.moveSetKey] || MOVES.standard;
    if (!key) return findMoveByTag(set, 'launcher');
    const direct = getMove(set, key);
    if (direct) return direct;
    const tags = TAG_ALIASES[key] || [key];
    for (const t of tags) {
      const m = findMoveByTag(set, t);
      if (m) return m;
    }
    return findMoveByTag(set, 'launcher') || Object.values(set)[0];
  }

  /** Put the pair face to face at `dist` metres, centred on the arena. */
  function stage(attacker, defender, dist = 1.05) {
    game.cpu[1] = null;
    if (game.phase !== 'fight') game.setPhase('fight');
    hideLineup();
    for (const f of fighters()) { f.group.visible = true; }
    const sign = attacker.index === 0 ? -1 : 1;
    attacker.position.set(sign * dist * 0.5, attacker.floorY, 0);
    defender.position.set(-sign * dist * 0.5, defender.floorY, 0);
    attacker.prevPosition.copy(attacker.position);
    defender.prevPosition.copy(defender.position);
    attacker.velocity.set(0, 0, 0);
    defender.velocity.set(0, 0, 0);
    attacker.facing = -sign;
    defender.facing = sign;
    attacker.state = STATE.IDLE;
    defender.state = STATE.IDLE;
    attacker.stunTicks = 0;
    defender.stunTicks = 0;
    attacker.currentMove = null;
    defender.currentMove = null;
    defender.isBlocking = false;
    defender.crouching = false;
    defender.airborne = false;
    defender.juggleCount = 0;
    attacker.inputBuffer.length = 0;
    defender.inputBuffer.length = 0;
    for (const f of [attacker, defender]) {
      f.upHeldTicks = 0;
      f.gravityScale = 1;
      f.throwData = null;
      f.throwPartner = null;
      f.connected.clear();
      f.hitboxes.length = 0;
    }
  }

  /**
   * Start `move` on `fighter` and skip forward to just before its first active
   * frame, so the very next simulated tick is the impact.
   */
  function armAtImpact(fighter, move, lead = 2) {
    fighter.startMove(move);
    // Carry the retime. `Animator.play` does `top.retime = opts.retime || null`,
    // so this second call was DISCARDING the two-anchor retime that
    // `Fighter#startMove` had just installed one line above -- and every shot
    // driven through this helper therefore rendered the clip UNRETIMED. For
    // straight3 the retime is inScale 0.889 / outScale 0.72, so the captures
    // ran the startup about 12% and the recovery about 39% faster than any
    // player ever sees. Every impact frame this project has scored was taken
    // that way. Found by an agent that measured animator.time against moveTick
    // and got an exact 1:1 where the retime says tick 22 should be clip 18.88.
    if (fighter.animator?.play) {
      fighter.animator.play(move.clip, { blend: 0, loop: false, retime: retimeFor(move) });
    }
    fighter.fastForward(Math.max(0, move.startup - lead));
  }

  /**
   * A `Command` with exactly the fields `Input#commandsFor` publishes, for the
   * probes that DRIVE the fighter rather than force its state. Shared, so the
   * three of them cannot drift apart on what a keypress looks like.
   *
   * `dir` is a notation direction token ('', 'f', 'b', 'u', 'df', 'ub', ...)
   * and is already facing-relative, the way `Input` hands it over.
   *
   * @param {string} dir
   * @param {number[]} [buttons]
   * @param {boolean} [guard]
   * @param {?string} [motion]
   * @returns {Object}
   */
  function mkCmd(dir = '', buttons = [], guard = false, motion = null) {
    const x = dir === 'f' || dir === 'df' || dir === 'uf' ? 1
      : dir === 'b' || dir === 'db' || dir === 'ub' ? -1 : 0;
    const y = dir === 'u' || dir === 'uf' || dir === 'ub' ? 1
      : dir === 'd' || dir === 'df' || dir === 'db' ? -1 : 0;
    return {
      x, y, fwd: x > 0, back: x < 0, up: y > 0, down: y < 0,
      guard, touchGuard: false,
      held: new Set(buttons), pressed: new Set(buttons),
      notation: '', buffer: [], motion,
    };
  }

  /**
   * Put `a` into a NEUTRAL JUMP and hold it near the top of the arc, with the
   * pair still `dist` apart horizontally.
   *
   * An air-only move cannot be probed from the ground. `probeMoves` forces the
   * move with `startMove`, which does not consult `canUse` — so a `requireAir`
   * move starts happily while the fighter is standing, and everything about the
   * measurement is then wrong: the striking foot is a metre and a half below
   * where it will ever be in play, and the answer the probe returns is about a
   * pose no player can produce. `airKick` was being scored that way.
   *
   * @returns {boolean} whether the fighter actually left the ground
   */
  function stageAir(a, d, dist, hold = 10) {
    for (let t = 0; t < 30 && !a.airborne; t++) { a.simulate(mkCmd('u')); d.simulate(null); }
    if (!a.airborne) return false;
    for (let t = 0; t < hold; t++) { a.simulate(mkCmd()); d.simulate(null); }
    if (!a.airborne) return false;
    // Re-pin the horizontal spacing without touching Y — `stage` would drop the
    // fighter back to the floor and undo the jump.
    const sign = a.index === 0 ? -1 : 1;
    a.position.x = sign * dist * 0.5;
    a.position.z = 0;
    d.position.x = -sign * dist * 0.5;
    d.position.z = 0;
    a.prevPosition.x = a.position.x;
    a.prevPosition.z = a.position.z;
    a.velocity.x = 0;
    a.velocity.z = 0;
    return true;
  }

  function hideLineup() {
    if (!lineup) return;
    for (const e of lineup) {
      game.scene.remove(e.group);
      if (e.robot?.dispose) e.robot.dispose();
      // One bone DataTexture per cast member, allocated lazily by
      // `THREE.Skeleton.computeBoneTexture` on the frame the lineup is first
      // drawn and freed only by `Skeleton.dispose()`. Tearing the robot down
      // does not touch it, so a run that photographed 09-roster left ten of
      // them behind — measured, and the single largest term in the +12 a full
      // capture pass used to accumulate. See the note in Fighter.setCharacter
      // for why this is a resource leak and not the frame-time one.
      e.bundle?.skeleton?.dispose?.();
    }
    lineup = null;
  }

  return {
    /**
     * Land one hit and hold the impact frame.
     * @param {{attacker?:number, defender?:number, move?:string, dist?:number}} o
     */
    forceHit(o = {}) {
      const [a, d] = [fighters()[o.attacker ?? 0], fighters()[o.defender ?? (1 - (o.attacker ?? 0))]];
      const move = resolveMove(a, o.move ?? 'launcher');
      stage(a, d, o.dist ?? (move.props.throw ? 0.9 : 1.02));
      d.health = Math.max(d.health, MAX_HEALTH * 0.7);
      armAtImpact(a, move);
      game.fightCamera?.cinematic?.('impact', { target: a, other: d });
      return move.id;
    },

    /**
     * Launch and juggle: a real launcher followed by `hits` airborne follow-ups.
     * @param {{attacker?:number, hits?:number}} o
     */
    forceJuggle(o = {}) {
      const ai = o.attacker ?? 0;
      const hits = Math.max(1, o.hits ?? 3);
      const a = fighters()[ai];
      const d = fighters()[1 - ai];
      const set = MOVES[a.moveSetKey] || MOVES.standard;
      stage(a, d, 1.0);
      d.health = MAX_HEALTH;

      const launcher = findMoveByTag(set, 'launcher') || resolveMove(a, 'launcher');
      armAtImpact(a, launcher);

      const filler = ['jab', 'poke', 'mid', 'string']
        .map((t) => findMoveByTag(set, t))
        .filter(Boolean);

      for (let i = 0; i < hits; i++) {
        after(26 + i * 20, () => {
          const mv = filler[i % filler.length] || launcher;
          a.state = STATE.IDLE;
          a.currentMove = null;
          a.stunTicks = 0;
          // Stay under the airborne opponent so the follow-up actually connects.
          a.position.x = d.position.x - d.facing * 0.95;
          a.prevPosition.copy(a.position);
          a.facing = Math.sign(d.position.x - a.position.x) || a.facing;
          armAtImpact(a, mv);
        });
      }
      return hits;
    },

    /**
     * Full meter, overdrive started, camera on the cinematic.
     * @param {{attacker?:number}} o
     */
    forceSuper(o = {}) {
      const ai = o.attacker ?? 0;
      const a = fighters()[ai];
      const d = fighters()[1 - ai];
      const set = MOVES[a.moveSetKey] || MOVES.standard;
      const move = findMoveByTag(set, 'super');
      stage(a, d, 1.1);
      a.meter = METER_MAX;
      d.health = MAX_HEALTH * 0.55;
      if (!move) return null;
      armAtImpact(a, move, move.startup);
      bus.emit('superStart', { fighter: a, move });
      bus.emit('timeScale', { scale: move.props.cinematic?.slow ?? 0.35, ticks: 40 });
      game.fightCamera?.cinematic?.('super', { target: a, other: d, move });
      return move.id;
    },

    /**
     * Drop a fighter with a real finishing blow so the KO cinematic plays.
     * @param {{loser?:number}} o
     */
    forceKO(o = {}) {
      const li = o.loser ?? 1;
      const d = fighters()[li];
      const a = fighters()[1 - li];
      const set = MOVES[a.moveSetKey] || MOVES.standard;
      const move = findMoveByTag(set, 'heavy') || findMoveByTag(set, 'launcher');
      // 1.02, not 1.0, and the difference is whether this function does what it
      // says. At 1.0 the heavy whiffs -- measured: the defender's health sat at
      // 6 and no round ever ended -- so `10-ko` photographed two upright
      // fighters under a round-start banner for several rounds and the
      // interface axis was scored on the absence of a beat that had never
      // happened. This is the same distance `forceHit` uses, which lands every
      // time. Overridable so a caller can probe the edge deliberately.
      stage(a, d, o.dist ?? 1.02);
      d.health = 6;
      d.recoverable = 0;
      a.health = MAX_HEALTH * 0.42;
      armAtImpact(a, move);
      game.fightCamera?.cinematic?.('ko', { target: d, other: a });
      return move.id;
    },

    /**
     * Every roster character standing side by side for a silhouette read.
     * Builds throwaway preview robots; call `clearLineup()` to remove them.
     */
    async rosterLineup(opts = {}) {
      const [{ ROSTER }, { buildRobot }, { Animator }, { CLIPS }, { createSkeleton }] = await Promise.all([
        import('../characters/roster.js'),
        import('../characters/RobotBuilder.js'),
        import('../characters/Animator.js'),
        import('../characters/animations/index.js'),
        import('../characters/Skeleton.js'),
      ]);
      hideLineup();
      for (const f of fighters()) f.group.visible = false;

      // TWO RANKS, and the reason is arithmetic rather than taste.
      //
      // The cast used to stand in one row of ten at 1.65 m spacing — 14.9 m of
      // fighters, 16.2 m including bodies. At 16:9 a frame that holds 16.2 m of
      // WIDTH is 9.1 m tall, so a 1.85 m machine can only ever be a fifth of it:
      // measured on the shipped shot, every fighter came out 200-210 px of 1080,
      // 18.5 to 19.5 percent of frame height. A critic said you cannot assess
      // character rendering from it and was right — but no camera move fixes it,
      // because the number is set by the row, not the lens.
      //
      // The stage puts a second, harder cap on top of that. `arena.structure.
      // foreground` — the near gantry and its guard rails — spans z 6.0 to 10.5
      // across the whole pit, measured from its world bounds. Every camera
      // standing further back than z = 6 photographs the cast through it, which
      // is the rail that crossed the old frame and the reason one fighter was
      // reported as occluded outright. So the camera has under 6 m to work in,
      // and a 16 m row cannot be shot from 6 m at any sane lens.
      //
      // Splitting the cast into a front and a back rank halves the width, which
      // buys back both: the row fits inside the foreground clearance, and the
      // fighters roughly double in the frame. Odd/even assignment puts
      // neighbouring roster entries in different ranks, so the back rank sits in
      // the front rank's gaps and nobody is hidden.
      // 1.35 m within a rank. The cast's bounding-box widths run 0.67 to 1.29 m,
      // and the two widest (Anvil and Bastion) are odd/even neighbours so they
      // land in different ranks; the widest pair that ends up side by side is
      // Anvil and Ronin at 1.29 and 1.20, which need 1.25 m of pitch. 1.35 is
      // that plus a hand's clearance.
      const spacing = opts.spacing ?? 1.35;
      /** Where the lens will end up (see the `cinematic` call below). Known
       *  here because the fan angle is measured against it. */
      const camZ = opts.maxDist ?? 5.85;
      /** Front rank forward of the mark, back rank behind it. Both are pushed
       *  back far enough that the camera solve below still clears the gantry. */
      const rankZ = [opts.frontZ ?? 0.35, opts.backZ ?? -2.05];
      const poses = ['i.stanceSet', 'idle.fight', 'v.pose', 'i.pointTaunt', 'idle.taunt', 'v.saluteCharge'];
      lineup = [];
      const n = ROSTER.length;

      // Lay the ranks out in PROJECTED space, then convert to world.
      //
      // Spacing the two ranks in world metres and staggering the back one by
      // half a pitch is the obvious construction and it does not work: the back
      // rank is 2.4 m further away, so perspective drags it toward the vanishing
      // point and it lands almost exactly behind its front-rank neighbour rather
      // than in the gap. Measured on the world-space version at 1920 px, the
      // outer pairs projected to screen x 535/580 and 1503/1552 — 45 px apart on
      // a 1920 px frame, on machines 330 px wide. The flanking machines were
      // hidden by the very neighbours the stagger existed to avoid.
      //
      // So the positions below are where each machine should appear ACROSS THE
      // FRAME, measured at the front rank's depth, and the back rank's world x
      // is that multiplied by its own depth ratio. Every machine then lands on
      // its intended screen position regardless of which rank it is in, and the
      // stagger does what it says.
      const perRank = [Math.ceil(n / 2), Math.floor(n / 2)];
      const stagger = perRank[0] === perRank[1] ? spacing * 0.5 : 0;
      /** How much wider the back rank has to be laid out to project as though
       *  it stood at the front rank's depth. */
      const depthRatio = (camZ - rankZ[1]) / Math.max(camZ - rankZ[0], 0.5);
      /** Screen-equivalent x, i.e. the position at the front rank's depth. */
      const xs = [];
      for (let i = 0; i < n; i++) {
        const r = i % 2;
        const k = (i - r) / 2;
        xs.push((k - (perRank[r] - 1) / 2) * spacing + (r === 1 ? stagger : 0));
      }
      const midX = (Math.min(...xs) + Math.max(...xs)) * 0.5;

      for (let i = 0; i < n; i++) {
        const def = ROSTER[i];
        const bundle = createSkeleton(def.proportions);
        const robot = buildRobot(def, bundle, game.environment);
        const group = new THREE.Group();
        group.name = `lineup_${def.id}`;
        if (robot?.group) group.add(robot.group);
        if (!bundle.byName.root.parent) group.add(bundle.byName.root);
        const rank = i % 2;
        // `x` is the screen-equivalent position; `wx` is where the machine
        // actually stands to project there.
        const x = xs[i] - midX;
        const wx = rank === 1 ? x * depthRatio : x;
        group.position.set(wx, GROUND_Y, rankZ[rank]);
        // FACING THE LENS. This was `Math.PI + ...` and the half-turn is wrong:
        // a built robot's front is +Z (`FRONT = 1` in RobotBuilder, and the
        // roster portraits confirm it empirically — a camera on +Z is what
        // photographs visors and faces). The lineup camera also stands on +Z, so
        // adding pi turned the entire cast to face away from it. Measured on the
        // shipped staging as the dot of each chest bone's own forward axis with
        // the direction to the camera: vulkan -0.73, kestrel -0.85, anvil -0.73,
        // seraph -0.94, ronin -0.90, mantis -0.89, nyx -0.99, bastion -0.99,
        // axiom -0.55, volta -0.95. Ten out of ten negative — every character
        // shot from behind, in the frame the character axis is scored on. At
        // 200 px a figure that is nobody could tell; it is obvious at 400.
        //
        // Fanned by a fraction of the machine's OWN off-axis angle to the lens,
        // so an outer machine turns slightly in and shows its front rather than
        // its flank. A flat `x * k` was tried and is wrong twice over: it has no
        // idea how far away the camera is, and its sign only looked right while
        // the half-turn above was inverting it.
        const fanTo = (px, pz) => Math.atan2(-px, camZ - pz) * 0.42;
        group.rotation.y = fanTo(wx, rankZ[rank]);
        game.scene.add(group);

        const animator = new Animator(bundle, CLIPS);
        const poseId = poses[i % poses.length];
        animator.play(poseId, { blend: 0, loop: true });
        // Clamp the warm-up to the clip's own length, or a fighter runs off the
        // end of a non-looping pose and falls back to the rig's REST POSE --
        // which is a T-pose, in a shot whose entire job is to show the cast
        // looking like a shipped roster screen. Only two of the six poses loop,
        // the stagger is 40 + i*7 ticks, and i.stanceSet is 64 ticks long: at
        // i = 6 the warm-up asks for 82. A critic spotted two fighters standing
        // with their arms perfectly horizontal and correctly called it a rig
        // rest pose leaking into a shipped-looking frame.
        const dur = CLIPS[poseId]?.duration ?? 60;
        const warm = CLIPS[poseId]?.loop ? 40 + i * 7 : Math.min(40 + i * 7, Math.max(1, dur - 6));
        for (let t = 0; t < warm; t++) animator.simulate(t);
        animator.applyTo(bundle.bones, 1);
        group.updateMatrixWorld(true);

        // Correct the residual yaw the POSE itself introduces.
        //
        // Turning the group is not enough on its own, because several of these
        // clips rotate the torso as part of the pose — a taunt turns a shoulder
        // toward the opponent. Measured against the camera after the half-turn
        // above was fixed, the chest-forward dot still ran from 0.99 down to
        // 0.68, which is 47 degrees off axis on Vulkan and 39 on Kestrel: two
        // machines quietly presented three-quarters-away in a cast shot.
        // So the group is counter-rotated by whatever the posed CHEST actually
        // came out at, which lands every machine on its intended fan angle no
        // matter what its clip did. Yaw only — a pose is allowed to lean and
        // twist, it is just not allowed to choose which way the character
        // faces the camera.
        const chestBone = bundle.byName.chest ?? bundle.byName.spine02;
        if (chestBone) {
          chestBone.getWorldQuaternion(_lq);
          _lv.set(0, 0, 1).applyQuaternion(_lq);
          group.rotation.y += fanTo(wx, rankZ[rank]) - Math.atan2(_lv.x, _lv.z);
          group.updateMatrixWorld(true);
        }
        lineup.push({ group, robot, animator, bundle, offset: i * 7 });
      }

      // Hand the camera what was actually staged and let it solve, rather than
      // passing a distance guessed from the roster count.
      //
      // `halfWidth` is measured in the same screen-equivalent space the ranks
      // were laid out in, so it already covers both, plus a body half-width so
      // the outer machines are not clipped by the frame edge — both edge
      // fighters were cropped in the shot this replaces. `maxDist` is the clearance in front
      // of `arena.structure.foreground`, so the solve can never put the lens
      // behind the gantry. `focusDepth` is the rank separation plus a margin,
      // which is what stops the back rank falling out of the depth of field on
      // a shot taken from six metres.
      // 0.9 m of body pad, checked rather than guessed: with 0.75 the widest
      // machine's outermost BONE projected to x = 50 of 1920, and armour plates
      // hang past a bone. 0.9 opens the frame ~4% and puts that edge at 85 px.
      const halfWidth = (Math.max(...xs) - Math.min(...xs)) * 0.5 + 0.9;
      const focusDepth = (rankZ[0] - rankZ[1]) + 1.4;
      // The camera looks slightly DOWN on the group. At eye level the back rank
      // hides behind the front one; lifting the lens above the heads and tilting
      // in is the same thing a photographer does with a two-row group, and it is
      // what makes the second rank read.
      game.fightCamera?.cinematic?.('lineup', {
        halfWidth,
        maxDist: (opts.maxDist ?? 5.85) - rankZ[0],
        focusDepth,
        fov: opts.fov ?? 40,
        height: opts.height ?? 2.62,
        target: new THREE.Vector3(0, GROUND_Y + 1.3, rankZ[0]),
      });
      return n;
    },

    clearLineup() {
      hideLineup();
      for (const f of fighters()) f.group.visible = true;
    },

    /**
     * Face the pair off at `dist` metres, centred, both idle.
     *
     * Published so `makeGameTest` can stage a scenario through the SAME code
     * every probe in this file already uses. `tools/simgate.mjs` carries a
     * hand-copied version of this from before it was reachable, with a note
     * saying it had to; a third copy would be the point at which the three
     * quietly stop agreeing about what "staged" means.
     */
    stage(attacker, defender, dist = 1.05) {
      stage(attacker, defender, dist);
    },

    /** Put both fighters back in a clean neutral round-start state. */
    resetFight() {
      hideLineup();
      scheduled.length = 0;
      for (const f of fighters()) f.group.visible = true;
      game.fighters[0].reset(new THREE.Vector3(-1.9, GROUND_Y, 0), 1);
      game.fighters[1].reset(new THREE.Vector3(1.9, GROUND_Y, 0), -1);
      game.combat.reset();
      game.setPhase('fight');
    },

    /**
     * Drive every move in a set through the REAL simulation at several ranges
     * and report which ones connect.
     *
     * This is the instrument that found the kicks-never-connect defect, and it
     * is here rather than in a tool because the defect was invisible to every
     * offline reconstruction of the collision test. The capsules are built from
     * posed bone matrices, and the pose is the Animator's — layers, IK, springs,
     * pelvis lift and the extracted root yaw included. Rebuild any of that
     * outside the Fighter and the geometry comes out different: a hand-rolled
     * rig sample said `k.midKick` OVERLAPPED the defender by 14 cm at 0.9 m, and
     * the shipping game whiffed it at every range. The difference was the
     * authored body pivot, which only exists once `Fighter` applies it.
     *
     * So it steps the real tick order — `Fighter.simulate` on both, then
     * `CombatSystem.simulate` — with no renderer and no clock, which makes it
     * synchronous, deterministic, and runnable from a console or from Node.
     *
     * `aim: false` runs the same compiled program with the strike-aim bias
     * forced to zero, which is how the before/after for that fix is taken: one
     * build, one page, one uniform branch, so nothing but the correction differs
     * between the two numbers.
     *
     * @param {{moveSet?:string, dists?:number[], attacker?:number, aim?:boolean}} o
     * @returns {{total:number, connected:number, rate:number, dead:string[],
     *            rows:Array<{id:string, clip:string, hits:number, aim:number}>}}
     */
    probeMoves(o = {}) {
      const [a, d] = [fighters()[o.attacker ?? 0], fighters()[1 - (o.attacker ?? 0)]];
      const set = MOVES[o.moveSet || a.moveSetKey] || MOVES.standard;
      const dists = o.dists || [0.9, 1.02, 1.2, 1.5];
      const rows = [];
      const notStarted = new Set();
      const noAir = new Set();
      let landed = 0;
      let attempts = 0;

      // Listen on the bus rather than on the fighters: `hit` is the event the
      // player's report is about, and it is emitted from exactly one place.
      let struck = false;
      const off = [bus.on('hit', () => { struck = true; }), bus.on('block', () => { struck = true; })];

      // The A/B branch. `strikeAim` caches on the move, so overwriting the cache
      // switches the correction off for every fighter at once with no rebuild.
      const saved = [];
      if (o.aim === false) {
        for (const move of Object.values(set)) {
          saved.push([move, strikeAim(move)]);
          move.aimBias = 0;
        }
      }

      try {
        for (const [id, move] of Object.entries(set)) {
          if (!move.active?.length || move.props?.throw) continue;
          let hits = 0;
          let aim = 0;
          // Which distances connected, in the order given. A total is not enough
          // to separate a defect from correct short reach: a jab that misses at
          // 1.5 m is right, and a kick that misses at 0.9 m is the bug the
          // player reported. Only the leading distances are diagnostic.
          const at = [];
          for (const dist of dists) {
            stage(a, d, dist);
            d.health = MAX_HEALTH * 100;
            a.health = MAX_HEALTH * 100;
            // Meter, every attempt. `Fighter#startMove` RETURNS EARLY when the
            // move costs more meter than the fighter holds, so without this the
            // probe scores a move that never ran as a whiff — silently, because
            // a move that does not start emits no event at all. `overdrive`
            // costs METER_MAX, and this probe read it as 1/4 for exactly that
            // reason: meter accumulated from the moves probed before it, the
            // super fired once at the first distance, spent all of it, and
            // whiffed the other three by never existing.
            a.meter = METER_MAX;
            a.animYaw = 0;
            a.aimYaw = 0;
            // Settle both bodies on the idle clip first, so the probe measures
            // the move rather than whatever pose the match happened to be in.
            a.animator?.play('idle.fight', { blend: 0, loop: true });
            d.animator?.play('idle.fight', { blend: 0, loop: true });
            for (let i = 0; i < 8; i++) { a.simulate(null); d.simulate(null); }
            stage(a, d, dist);
            a.animYaw = 0;
            a.aimYaw = 0;
            // An air-only move is probed from the air, because that is the only
            // place a player can ever press it.
            if (move.props?.requireAir && !stageAir(a, d, dist)) noAir.add(id);

            struck = false;
            a.startMove(move);
            // A move that refused to start is not a whiff, and reporting it as
            // one is how `overdrive` hid for three rounds. Say so out loud.
            if (a.currentMove !== move) notStarted.add(id);
            a.animator?.play(move.clip, { blend: 0, loop: false, retime: retimeFor(move) });
            for (let t = 0; t < move.total + 4 && !struck; t++) {
              a.simulate(null);
              d.simulate(null);
              if (a.hitboxes.length && !aim) aim = strikeAim(move) * 180 / Math.PI;
              game.combat.simulate(game.tick + t);
            }
            attempts++;
            at.push(struck ? 1 : 0);
            if (struck) { hits++; landed++; }
          }
          rows.push({ id, clip: move.clip, hits, at, aim: Math.round(aim) });
        }
      } finally {
        for (const [move, bias] of saved) move.aimBias = bias;
        for (const fn of off) fn?.();
        this.resetFight();
      }

      const dead = rows.filter((r) => r.hits === 0).map((r) => `${r.id} (${r.clip})`);
      // A miss at the CLOSEST staged distance is the player-visible defect;
      // anything that only drops off at range is reach, which is a balance
      // question and not a bug. Reported separately so the two never get mixed.
      const nearMiss = rows.filter((r) => r.at[0] === 0).map((r) => `${r.id} (${r.clip}) ${r.at.join('')}`);
      return {
        total: attempts, connected: landed, rate: landed / Math.max(1, attempts),
        dead, nearMiss, notStarted: [...notStarted], noAir: [...noAir], dists, rows,
      };
    },

    /**
     * Per-tick trace of ONE move: the engine's own `segSegDistSq` for every
     * hitbox/hurtbox pair, sampled INSIDE the tick loop between
     * `Fighter.simulate` and `CombatSystem.simulate`.
     *
     * `probeMoves` answers "did it connect"; this answers "by how much, where,
     * and on which tick", which is the only way to tell a capsule that is short
     * from a capsule that is never tested. The earlier pass at this defect
     * measured centre-to-centre minus summed radii from a `setInterval` and got
     * a number that is wrong twice over — the engine tests SEGMENT to segment,
     * and a sample taken off the sim clock lands wherever wall-clock left it.
     *
     * `gap` is metres of clearance: `sqrt(segSegDistSq) - (rHit + rHurt)`, the
     * exact quantity `#findConnection` compares against zero. Negative is a
     * connection.
     *
     * @param {{move:string, moveSet?:string, dist?:number, attacker?:number}} o
     * @returns {{move:string, dist:number, aimDeg:number, ticks:Array<Object>}}
     */
    traceMove(o = {}) {
      const [a, d] = [fighters()[o.attacker ?? 0], fighters()[1 - (o.attacker ?? 0)]];
      const set = MOVES[o.moveSet || a.moveSetKey] || MOVES.standard;
      const move = getMove(set, o.move) || resolveMove(a, o.move);
      const dist = o.dist ?? 1.02;
      const ticks = [];
      const c1 = new THREE.Vector3();
      const c2 = new THREE.Vector3();

      // Optional in-page override of the clip-frame the retime pins onto the
      // first active frame, so a candidate contact tick can be swept on ONE
      // compiled program with nothing else differing between the runs. Both the
      // retime and the aim solve are cached on the move and both derive from it,
      // so both caches are dropped and restored with it.
      const hadContact = 'contact' in move ? move.contact : undefined;
      const hadRetime = move.retime;
      const hadAim = move.aimBias;
      if (o.contact !== undefined) {
        move.contact = o.contact;
        move.retime = undefined;
        move.aimBias = undefined;
      }

      stage(a, d, dist);
      d.health = MAX_HEALTH * 100;
      a.health = MAX_HEALTH * 100;
      // See `probeMoves`: without meter, a meter-gated move never starts and
      // the trace records a hundred ticks of a fighter standing still.
      a.meter = METER_MAX;
      a.animYaw = 0; a.aimYaw = 0;
      a.animator?.play('idle.fight', { blend: 0, loop: true });
      d.animator?.play('idle.fight', { blend: 0, loop: true });
      for (let i = 0; i < 8; i++) { a.simulate(null); d.simulate(null); }
      stage(a, d, dist);
      a.animYaw = 0; a.aimYaw = 0;
      const air = !!move.props?.requireAir && stageAir(a, d, dist);

      let struck = null;
      let started = false;
      // Where every bone this move strikes with actually IS, on every tick of
      // the move, whether or not a hitbox exists that tick. Without this a trace
      // can only say the active window missed; with it you can see whether the
      // limb ever passed the target at all, which is the difference between a
      // mistimed window and a strike aimed somewhere the defender is not.
      const swept = o.sweep === false ? null : [];
      const off = [
        bus.on('hit', (e) => { struck = struck || `hit@${e.move?.id}`; }),
        bus.on('block', () => { struck = struck || 'block'; }),
      ];
      try {
        a.startMove(move);
        started = a.currentMove === move;
        a.animator?.play(move.clip, { blend: 0, loop: false, retime: retimeFor(move) });
        const sweptBones = [...new Set(move.active.flatMap((w) => w.boxes.map((b) => b.bone)))];
        for (let t = 0; t < move.total + 4; t++) {
          a.simulate(null);
          d.simulate(null);
          if (swept) {
            const row = { t: a.moveTick, ay: +a.position.y.toFixed(3) };
            for (const bn of sweptBones) {
              const bone = a.boneByName[bn];
              if (!bone) continue;
              c1.setFromMatrixPosition(bone.matrixWorld);
              row[bn] = [+c1.x.toFixed(3), +c1.y.toFixed(3), +c1.z.toFixed(3)];
            }
            row.headY = +(d.hurtboxes.find((h) => h.bone === 'head')?.p0.y ?? 0).toFixed(3);
            // What the connection test WOULD return if the window were open on
            // this tick. This is the measurement that tells a mistimed window
            // from a strike that never comes near: it runs the move's own box
            // definitions through the same capsule construction `#buildHitboxes`
            // uses and the same `segSegDistSq` the engine compares, on every
            // tick of the move rather than only on the authored ones.
            let g = Infinity; let gb = null;
            for (const w of move.active) {
              for (const b of w.boxes) {
                const bone = a.boneByName[b.bone];
                if (!bone) continue;
                c1.set(b.offset[0], b.offset[1], b.offset[2]).applyMatrix4(bone.matrixWorld);
                if (b.length > 0) c2.set(b.offset[0], b.offset[1] - b.length, b.offset[2]).applyMatrix4(bone.matrixWorld);
                else c2.copy(c1);
                if (b.fwd) { c1.x += a.facing * b.fwd; c2.x += a.facing * b.fwd; }
                for (const hu of d.hurtboxes) {
                  const gg = Math.sqrt(segSegDistSq(c1, c2, hu.p0, hu.p1, _tc1, _tc2)) - b.radius - hu.radius;
                  if (gg < g) { g = gg; gb = `${b.bone}->${hu.bone}`; }
                }
              }
            }
            row.wouldGap = +g.toFixed(3);
            row.pair = gb;
            swept.push(row);
          }
          if (a.hitboxes.length) {
            let best = null;
            for (const hb of a.hitboxes) {
              for (const hu of d.hurtboxes) {
                const g = Math.sqrt(segSegDistSq(hb.p0, hb.p1, hu.p0, hu.p1, c1, c2)) - hb.radius - hu.radius;
                if (!best || g < best.gap) {
                  best = {
                    gap: +g.toFixed(4), bone: hb.bone, target: hu.bone || hu.region || '?',
                    hitP0: [+hb.p0.x.toFixed(3), +hb.p0.y.toFixed(3), +hb.p0.z.toFixed(3)],
                    hitP1: [+hb.p1.x.toFixed(3), +hb.p1.y.toFixed(3), +hb.p1.z.toFixed(3)],
                    hurtP0: [+hu.p0.x.toFixed(3), +hu.p0.y.toFixed(3), +hu.p0.z.toFixed(3)],
                  };
                }
              }
            }
            ticks.push({
              t: a.moveTick, boxes: a.hitboxes.length,
              ax: +a.position.x.toFixed(3), ay: +a.position.y.toFixed(3),
              dx: +d.position.x.toFixed(3),
              yaw: Math.round(a.animYaw * 180 / Math.PI),
              air: !!a.airborne, connected: a.connected.size,
              dstate: d.state, invuln: !!d.invulnerable,
              ...best,
            });
          }
          game.combat.simulate(game.tick + t);
        }
      } finally {
        for (const fn of off) fn?.();
        this.resetFight();
      }
      const result = {
        move: `${move.id} (${move.clip})`, dist, struck, started, air, contact: o.contact,
        startup: move.startup, active: move.active.map((w) => [w.from, w.to]),
        retime: retimeFor(move),
        aimDeg: Math.round(strikeAim(move) * 180 / Math.PI), ticks, swept,
      };
      if (o.contact !== undefined) {
        if (hadContact === undefined) delete move.contact; else move.contact = hadContact;
        move.retime = hadRetime;
        move.aimBias = hadAim;
      }
      return result;
    },

    /**
     * Drive synthetic `Command`s of the exact shape `Input#commandsFor` builds
     * through the real `Fighter.simulate`, and report what the fighter did.
     *
     * This is the input-side companion to `probeMoves`: that one asks whether a
     * move connects once it has started, this one asks whether a player can
     * start it at all. The two failures look identical from the outside — the
     * player who reported "I never hit the opponent" also could not walk
     * backwards, and the whole `b+` command column, roundhouse and spin kick
     * included, was unreachable while block lived on back.
     *
     * `walks` holds a held direction for 60 ticks and reports the displacement,
     * the clip and the guard state. `column` presses every root move's own
     * notation from neutral and records which move the matcher actually
     * produced, so a shadowed input shows up as the id that came out instead.
     *
     * @param {{moveSet?:string, ticks?:number, attacker?:number}} o
     */
    probeInputs(o = {}) {
      const a = fighters()[o.attacker ?? 0];
      const d = fighters()[1 - (o.attacker ?? 0)];
      const setKey = o.moveSet || a.moveSetKey;
      const set = MOVES[setKey] || MOVES.standard;
      const hold = o.ticks ?? 60;

      const neutral = () => {
        stage(a, d, 2.4);
        a.animator?.play('idle.fight', { blend: 0, loop: true });
        for (let i = 0; i < 6; i++) { a.simulate(null); d.simulate(null); }
      };

      // --- held directions ---------------------------------------------------
      const walks = [];
      for (const [label, cmd] of [
        ['neutral', () => mkCmd('')],
        ['fwd', () => mkCmd('f')],
        ['back', () => mkCmd('b')],
        ['guard', () => mkCmd('', [], true)],
        ['back+guard', () => mkCmd('b', [], true)],
        ['down+guard', () => mkCmd('d', [], true)],
      ]) {
        neutral();
        const x0 = a.position.x;
        for (let t = 0; t < hold; t++) { a.simulate(cmd()); d.simulate(null); }
        walks.push({
          input: label,
          dx: +(a.position.x - x0).toFixed(3),
          clip: a.animator?.current || null,
          blocking: !!a.isBlocking,
          state: a.state,
        });
      }

      // --- opposed spacing ---------------------------------------------------
      // The number that decides whether a neutral game exists: one fighter holds
      // forward, the other holds back, from the round-start gap. A displacement
      // per fighter says only that the clip is wired up; the CLOSING RATE says
      // whether retreating is a decision or a formality.
      const spacing = (() => {
        stage(a, d, 3.8);
        a.animator?.play('idle.fight', { blend: 0, loop: true });
        d.animator?.play('idle.fight', { blend: 0, loop: true });
        for (let i = 0; i < 6; i++) { a.simulate(null); d.simulate(null); }
        const gap0 = Math.abs(d.position.x - a.position.x);
        const touch = a.radius + d.radius;
        let ticks = -1;
        for (let t = 0; t < 240; t++) {
          a.simulate(mkCmd('f'));
          d.simulate(mkCmd('b'));
          game.combat.simulate(game.tick + t);
          if (ticks < 0 && Math.abs(d.position.x - a.position.x) <= touch + 0.01) ticks = t + 1;
        }
        const gap1 = Math.abs(d.position.x - a.position.x);
        return {
          gap0: +gap0.toFixed(2), gap1: +gap1.toFixed(2), touch: +touch.toFixed(2),
          ticksToContact: ticks, secondsToContact: ticks < 0 ? null : +(ticks / 60).toFixed(2),
          closeRate: +(((gap0 - gap1) / (240 / 60))).toFixed(2),
          defenderPinned: Math.abs(d.position.x) >= d.bounds.halfWidth - d.radius - 0.02,
        };
      })();

      // --- the command columns ----------------------------------------------
      // A press is one tick of the button with the direction already held, which
      // is how a human enters it: `#pushInput` only records a buffer entry on a
      // fresh press, and the entry carries the direction held on that tick.
      //
      // `moveSetKey` is overridden for the duration because `Fighter#tryMove`
      // matches against the fighter's OWN set, not against whatever table a
      // caller passed. Reading one set's inputs while the fighter answers from
      // another reports every input the two sets do not share as unreachable —
      // it produced five phantom failures per set on the first run of this, and
      // the only set that looked healthy was the one fighter 0 actually had.
      const wasSetKey = a.moveSetKey;
      const column = [];
      try {
        a.moveSetKey = setKey;
        for (const mv of set.__ordered) {
          if (mv.followUp) continue;
          const p = mv.parsed;
          if (!p.buttons.length) continue;
          neutral();
          a.meter = METER_MAX;
          // Airborne moves are entered from a jump, which is what they are for.
          const air = !!mv.props.requireAir;
          if (air) {
            for (let t = 0; t < 24 && !a.airborne; t++) { a.simulate(mkCmd('u')); d.simulate(null); }
            for (let t = 0; t < 6; t++) { a.simulate(mkCmd('')); d.simulate(null); }
          }
          // Hold the direction for a few ticks first so a held-direction move is
          // entered the way a player enters it rather than as a same-frame stab.
          for (let t = 0; t < 4; t++) { a.simulate(mkCmd(p.dir, [], false, p.motion)); d.simulate(null); }
          a.simulate(mkCmd(p.dir, p.buttons, false, p.motion));
          d.simulate(null);
          for (let t = 0; t < 3 && !a.currentMove; t++) {
            a.simulate(mkCmd(p.dir, [], false, p.motion));
            d.simulate(null);
          }
          column.push({ input: mv.input, want: mv.id, got: a.currentMove?.id ?? null, air, airborne: !!a.airborne });
        }
      } finally {
        a.moveSetKey = wasSetKey;
        this.resetFight();
      }

      const missed = column.filter((c) => c.got !== c.want);
      const backCol = column.filter((c) => c.input.startsWith('b+'));
      return {
        moveSet: setKey, walks, spacing,
        column: { total: column.length, matched: column.length - missed.length, missed },
        backColumn: backCol,
      };
    },

    /**
     * Press-to-hit, end to end: type a move's own notation on a Command and
     * report whether a `hit` came out the other side.
     *
     * `probeInputs` proves a keypress starts the right move. `probeMoves` proves
     * a move connects once `startMove` has been called on it. Neither proves the
     * thing the player actually reported — "n and m make him kick but I never
     * hit the opponent" — because the two halves are measured on different
     * fighters in different states, and `startMove` bypasses `canUse` entirely.
     * This runs the whole path once: neutral, hold the direction, press the
     * button, and let the move play out against a live defender.
     *
     * The distance is recorded AT THE PRESS, not as staged, because holding a
     * direction for the entry walks the fighter — a `b+` move is entered while
     * retreating and genuinely starts further out than it was staged. That is
     * real play, and a reach number taken from the staged value would be a lie.
     *
     * @param {{moveSet?:string, dists?:number[], attacker?:number}} o
     */
    probePlay(o = {}) {
      const a = fighters()[o.attacker ?? 0];
      const d = fighters()[1 - (o.attacker ?? 0)];
      const setKey = o.moveSet || a.moveSetKey;
      const set = MOVES[setKey] || MOVES.standard;
      const dists = o.dists || [0.9, 1.02, 1.2, 1.5];

      let struck = false;
      const off = [bus.on('hit', () => { struck = true; }), bus.on('block', () => { struck = true; })];
      const wasSetKey = a.moveSetKey;
      const rows = [];

      try {
        a.moveSetKey = setKey;
        for (const mv of set.__ordered) {
          if (mv.followUp || !mv.active?.length || mv.props?.throw) continue;
          const p = mv.parsed;
          if (!p.buttons.length) continue;
          const at = [];
          const gotIds = new Set();
          const pressDist = [];
          for (const dist of dists) {
            stage(a, d, dist);
            d.health = MAX_HEALTH * 100;
            a.health = MAX_HEALTH * 100;
            a.meter = METER_MAX;
            a.animator?.play('idle.fight', { blend: 0, loop: true });
            d.animator?.play('idle.fight', { blend: 0, loop: true });
            for (let i = 0; i < 8; i++) { a.simulate(null); d.simulate(null); }
            stage(a, d, dist);
            if (mv.props.requireAir) stageAir(a, d, dist);

            // Hold the direction the way a human does, then one tick of button.
            //
            // A MOTION IS NOT A HELD DIRECTION and must not be pre-held. `bb+1`
            // is a double tap with the button on the second one; presenting
            // `motion:'bb'` for four ticks before the press fires a full
            // backdash first and the move then starts from wherever that dash
            // ended. Measured: it put `phaseStep` at 1.53 m when it was staged
            // at 0.90, and the probe called a move dead that a player can land.
            // The direction is still held for a plain `b+`/`f+` move, which is
            // exactly how those are entered.
            if (!p.motion) {
              for (let t = 0; t < 4; t++) { a.simulate(mkCmd(p.dir, [], false, null)); d.simulate(null); }
            }
            pressDist.push(+Math.abs(d.position.x - a.position.x).toFixed(2));
            struck = false;
            a.simulate(mkCmd(p.dir, p.buttons, false, p.motion));
            d.simulate(null);
            game.combat.simulate(game.tick);
            // Let it play out. The move may not have started on the press tick,
            // so the budget is the move plus the buffer window that feeds it.
            for (let t = 1; t < mv.total + 12 && !struck; t++) {
              // Motion dropped after the press: a live `bb` through the whole
              // move would keep re-offering a dash to every cancel window.
              a.simulate(mkCmd(p.dir, [], false, null));
              d.simulate(null);
              if (a.currentMove) gotIds.add(a.currentMove.id);
              game.combat.simulate(game.tick + t);
            }
            at.push(struck ? 1 : 0);
          }
          rows.push({
            id: mv.id, input: mv.input, at, hits: at.reduce((n, v) => n + v, 0),
            got: [...gotIds], pressDist,
          });
        }
      } finally {
        a.moveSetKey = wasSetKey;
        for (const fn of off) fn?.();
        this.resetFight();
      }

      const total = rows.length * dists.length;
      const connected = rows.reduce((n, r) => n + r.hits, 0);
      return {
        moveSet: setKey, dists, total, connected,
        dead: rows.filter((r) => r.hits === 0).map((r) => `${r.id} [${r.input}] got=${r.got.join(',') || 'nothing'}`),
        nearMiss: rows.filter((r) => r.at[0] === 0 && r.hits > 0).map((r) => `${r.id} [${r.input}] ${r.at.join('')}`),
        rows,
      };
    },

    /**
     * Switch the strike-aim correction off or on for a whole move set, on the
     * running page. `strikeAim` caches its answer on the move, so this is the
     * uniform branch a still A/B needs: one compiled program, one frozen frame,
     * and the only thing that differs between the pair is the correction.
     * @param {boolean} on
     * @param {string} [moveSet]
     * @returns {number} moves switched
     */
    setAim(on, moveSet) {
      const set = MOVES[moveSet || fighters()[0].moveSetKey] || MOVES.standard;
      let n = 0;
      for (const move of Object.values(set)) {
        if (move.aimSaved === undefined) move.aimSaved = strikeAim(move);
        const next = on ? move.aimSaved : 0;
        if (move.aimBias !== next) n++;
        move.aimBias = next;
      }
      return n;
    },

    /**
     * Advance the fixed-step simulation by `n` ticks with no renderer and no
     * clock, so a caller can stop on an exact frame of an exact move. Only the
     * fight-phase tick order is run — the same one `Game` runs.
     * @param {number} n
     */
    stepTicks(n = 1) {
      for (let i = 0; i < n; i++) {
        for (const f of fighters()) f.simulate(null);
        game.combat.simulate(game.tick + i);
      }
      return n;
    },

    /** Raw frame data for the UI/debug overlays and for balance spot-checks. */
    frameData(moveSetKey = 'standard') {
      const set = MOVES[moveSetKey];
      if (!set) return [];
      return Object.values(set).map((m) => ({
        id: m.id, name: m.name, input: m.input, startup: m.startup,
        onBlock: m.onBlock, onHit: m.onHit, damage: m.damage, height: m.height,
      }));
    },
  };
}

// ===========================================================================
// __GAME_TEST__ — the deterministic simulation façade
// ===========================================================================

/**
 * Bus events worth putting in a timeline.
 *
 * A whitelist rather than `bus.onAny`, and the exclusions are the point:
 * `footstep` fires up to twice a frame on a walk and `shake` fires on every
 * blow, so an unfiltered log is 80% noise and `stepUntil('hit')` becomes
 * unreadable. What is left is the set of moments a test would ever want to jump
 * to. `hitstop` is in because a freeze is the reason a run's frame count and
 * its tick count are not the same number, and a reader who does not know that
 * will mis-read every timeline that contains a hit.
 */
const TIMELINE_EVENTS = [
  'hit', 'block', 'parry', 'whiff', 'launch', 'knockdown', 'wallSplat',
  'groundImpact', 'armorAbsorb', 'partBreak', 'superStart', 'superHit',
  'finisherStart', 'finisherHit', 'comboEnd', 'hitstop', 'timeScale',
  'jump', 'dash', 'meterFull', 'roundEnd', 'matchEnd',
];

/**
 * A keyboard that exists only in memory.
 *
 * `Input` binds three listeners to whatever target it is handed and reads only
 * `e.code` and `e.repeat`, so a bare `EventTarget` plus a two-field Event
 * subclass is a complete keyboard as far as the input stack is concerned. That
 * is the whole reason synthetic input goes through here rather than around:
 * every direction flip, every buffer entry and every motion recognition is
 * produced by the code a real player's keystroke runs through, not by a
 * re-implementation of it. `tools/simgate.mjs` exists because the last time
 * this project tested the matcher instead of the input stack, it reported 12/12
 * on a defect a player found in ten minutes.
 */
class SynthKeyEvent extends Event {
  constructor(type, code) { super(type); this.code = code; this.repeat = false; }
  preventDefault() {}
}

function makeSynthKeyboard() {
  const target = new EventTarget();
  const held = new Set();
  const set = (code, down) => {
    if (down) {
      if (!held.has(code)) { held.add(code); target.dispatchEvent(new SynthKeyEvent('keydown', code)); }
    } else if (held.delete(code)) {
      target.dispatchEvent(new SynthKeyEvent('keyup', code));
    }
  };
  return { target, held, set, release: () => { for (const c of [...held]) set(c, false); } };
}

/**
 * The deterministic simulation façade — `window.__GAME_TEST__`.
 *
 * WHAT THIS IS FOR. An agent cannot watch a fighting game. It can, however,
 * hold a simulation still, press a button on frame 10, ask what frame 23 looked
 * like, and require that the same seed and the same input log produce the same
 * answer every time. That is the whole design: nothing in here reads a clock,
 * nothing samples `Math.random`, and every input is filed under a FRAME rather
 * than a millisecond.
 *
 * WHAT IT IS BUILT ON. Everything above in this file, plus `Input`. It stages
 * through `stage()`, steps the same fight-phase tick order `Game#simulate`
 * runs, and drives commands out of a real `Input` fed by a synthetic keyboard.
 * It does not re-implement any of that, because a harness that re-implements
 * the thing it is testing tests the re-implementation.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never renders unless asked. The whole
 * suite runs in about two seconds in bare Node with no GL context; the same
 * scenarios take two minutes a piece under a software rasteriser. Rendering is
 * a separate, opt-in step (`captureFrame`) precisely so the numeric layer stays
 * cheap enough to run on every change.
 *
 * DUCK-TYPED `game`. The browser passes the real `Game`. `tools/simscene.mjs`
 * passes a stub with `fighters`, `combat`, `cpu`, `scene`, `phase` and a no-op
 * `setPhase`, which is everything `stage()` touches. One code path, two hosts —
 * so the frames the contact sheet is labelled with are the frames the
 * invariants were measured on.
 *
 * @param {Object} game the Game instance, or a stub with the fields above
 * @param {{harness?:Object, roster?:Array}} [opts]
 * @returns {Object} the `__GAME_TEST__` object
 */
export function makeGameTest(game, opts = {}) {
  const harness = opts.harness || game.testHarness || makeTestHarness(game);
  const roster = opts.roster || null;

  /*
   * A FRESH KEYBOARD AND A FRESH `Input` PER RESET, NOT ONE FOR THE LIFETIME
   * OF THE HARNESS.
   *
   * `Input` keeps `history[player]`, a rolling list of direction changes it
   * prunes with `this.tick - hist[0].tick > INPUT_BUFFER_TICKS`. Every reset
   * puts the frame counter back to zero, so that expression goes deeply
   * negative against the previous run's entries and NOTHING IS EVER PRUNED —
   * the tail of the last scenario sits inside the motion window of the next
   * one for good.
   *
   * Measured, running the same scenario four times in one process: runs 1 and
   * 2 were identical, and run 3 turned the held BACK of `roundhouse-loop` into
   * a `bb` and started a BACKDASH on frame 0 — velocity -6.88 against -1.6,
   * clip `loco.dashBack` against `loco.runBack`, 22 frames of dash stun the
   * scenario never asked for. `juggle` did the same thing with `ff` on frame
   * 63. Both scenarios then ran a completely different trajectory while every
   * invariant still passed, which is the worst possible failure mode for a
   * harness: wrong, and quiet about it.
   *
   * `tools/simgate.mjs` already carries this rule, in its own words: "A FRESH
   * ONE PER CASE ... reusing one instance would let the tail of the previous
   * notation sit inside the motion window of the next — which is precisely the
   * kind of cross-talk this gate exists to detect, and would be
   * indistinguishable from a real one."
   */
  let kb = makeSynthKeyboard();
  let input = new Input(kb.target);

  /** Inputs still to be applied, keyed by the frame they fire on. */
  let pending = [];
  /** Every key edge that was actually dispatched, in frame order. A repro log. */
  let inputLog = [];
  let timeline = [];
  let events = [];
  let frame = 0;
  let seed = 0;
  let scenario = null;
  let offBus = [];
  let wasPaused = null;

  /**
   * Per-fighter hitstop, mirroring `Game.freezeTicks`.
   *
   * A freeze is not "the sim runs slower", it is "the sim does not run", and
   * `Game#frame` gates the accumulator on it. If this harness ignored hitstop
   * its frame numbers would drift from the game's by the length of every freeze
   * in the run — a launcher alone is 11 — and every piece of frame data
   * measured through it would be wrong by that amount. So the same gate is
   * reproduced here: while both counters are live the tick does not run at all
   * and the frame is marked `frozen`; while one is live that fighter alone
   * holds and the world moves around it.
   */
  const freeze = [0, 0];

  const fighters = () => game.fighters;
  const A = () => game.fighters[0];
  const D = () => game.fighters[1];

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * The pose signature: a weighted sum over the rebuilt hurtbox capsules.
   *
   * `Fighter#reset`'s own notes name this as the column that made an
   * animator-only divergence visible when position, velocity, state and the
   * clocks all cancelled in the diff. Position tells you where the body is;
   * this tells you what shape it is in, which is what the hitbox builder
   * sweeps and what a screenshot photographs. A determinism check without it
   * is a determinism check that cannot see the pose.
   *
   * MEASURED RELATIVE TO THE ROOT, which the version in `simgate` is not. A
   * world-space signature is dominated by where the fighter is standing, so it
   * answers "did the body move" — a question `x`, `y` and `z` already answer
   * three columns to the left — instead of "is the body in the same shape".
   * Subtracting the root makes it a pose measure, which is what the loop-closure
   * invariant needs and what the determinism diff wanted all along.
   *
   * It is a SUM, so it is a change detector and not a pose comparison: two
   * different poses can land on the same number. That is fine for both uses —
   * determinism needs any change to show, and `loopCloses` compares means over
   * many frames — and it would not be fine for "are these two poses the same",
   * which nothing here asks.
   */
  function poseSig(f) {
    let s = 0;
    const p = f.position;
    for (const h of f.hurtboxes) {
      s += (h.p0.x - p.x) + (h.p0.y - p.y) * 3 + (h.p0.z - p.z) * 7
        + (h.p1.x - p.x) * 11 + (h.p1.y - p.y) * 13 + (h.p1.z - p.z) * 17 + h.radius * 19;
    }
    return s;
  }

  /**
   * How far the strike capsule reaches past the attacker's own root, in metres.
   *
   * This is what `deriveMarks` uses to find MAX EXTENSION without being told
   * where it is, and it is a real measurement rather than a frame number
   * copied out of a move table — a retime, an aim bias or a clip swap moves the
   * true extension frame and leaves the authored one pointing at nothing.
   */
  function reachOf(f) {
    let best = 0;
    for (const hb of f.hitboxes) {
      best = Math.max(best, Math.abs(hb.p0.x - f.position.x), Math.abs(hb.p1.x - f.position.x));
    }
    return best;
  }

  /** One fighter's serializable state. Numbers are rounded for diffability. */
  function snap(f) {
    const r = (v, n = 6) => +(+v).toFixed(n);
    return {
      id: f.def?.id || `p${f.index + 1}`,
      index: f.index,
      x: r(f.position.x, 9), y: r(f.position.y, 9), z: r(f.position.z, 9),
      vx: r(f.velocity.x, 9), vy: r(f.velocity.y, 9), vz: r(f.velocity.z, 9),
      facing: f.facing,
      state: f.state, stateTicks: f.stateTicks, stun: f.stunTicks,
      hp: r(f.health, 4), meter: r(f.meter, 4),
      move: f.currentMove?.id ?? null, moveTick: f.moveTick,
      boxes: f.hitboxes.length,
      air: !!f.airborne, ground: !!f.grounded, crouch: !!f.crouching,
      block: !!f.isBlocking, invuln: !!f.invulnerable,
      combo: f.comboCount, juggle: f.juggleCount,
      clip: f.currentClip,
      // `group.scale` is uniform in this engine and nothing in the sim is
      // supposed to touch it; recorded so `scaleStable` has something to be
      // right about rather than a claim that it is.
      scale: r(f.group?.scale?.x ?? 1, 9),
      // Sole heights above the deck, straight off the tracker the footstep
      // events are emitted from.
      footL: r(f.footState?.L?.y ?? 0, 6), footR: r(f.footState?.R?.y ?? 0, 6),
      pose: r(poseSig(f), 6),
      reach: r(reachOf(f), 6),
      rng: `${f.rng?.s0 ?? 0}:${f.rng?.s1 ?? 0}`,
    };
  }

  /**
   * One timeline row.
   *
   * Shaped so the flat reading in the brief is literally true — `frame`,
   * `state`, `x`, `hit` are top-level and are the ATTACKER's — while `a` and
   * `d` carry everything a diff needs. A timeline that is pleasant to read and
   * a timeline that is complete are not the same artefact and this is cheaper
   * than shipping two.
   */
  function record(frozen, evsThisFrame) {
    const a = snap(A());
    const d = snap(D());
    timeline.push({
      frame,
      state: a.state,
      x: a.x,
      move: a.move,
      moveTick: a.moveTick,
      boxes: a.boxes,
      reach: a.reach,
      btn: kb.held.size > 0,
      frozen: !!frozen,
      hit: evsThisFrame.includes('hit') || undefined,
      ev: evsThisFrame.length ? evsThisFrame : undefined,
      a,
      d,
    });
  }

  /** Attach the event log. Payloads are COPIED — `Bus` reuses them per emit. */
  function listen() {
    unlisten();
    for (const type of TIMELINE_EVENTS) {
      offBus.push(bus.on(type, (p) => {
        const row = { frame, type };
        if (p?.attacker) row.attacker = p.attacker.index;
        if (p?.defender) row.defender = p.defender.index;
        if (p?.fighter) row.fighter = p.fighter.index;
        if (p?.move?.id) row.move = p.move.id;
        if (typeof p?.damage === 'number') row.damage = +p.damage.toFixed(3);
        if (typeof p?.ticks === 'number') row.ticks = p.ticks;
        if (typeof p?.scale === 'number') row.scale = p.scale;
        if (typeof p?.hits === 'number') row.hits = p.hits;
        if (typeof p?.winner === 'number') row.winner = p.winner;
        if (p?.counter) row.counter = true;
        events.push(row);
      }));
    }
    // Hitstop has to be acted on as well as logged, or this harness's frames
    // and the game's diverge by the length of every freeze.
    offBus.push(bus.on('hitstop', (e) => {
      const t = e?.ticks || 0;
      const i = e?.attackerIndex;
      if (Number.isInteger(i) && i >= 0 && i < 2) {
        freeze[i] = Math.max(freeze[i], e.attackerTicks ?? t);
        freeze[1 - i] = Math.max(freeze[1 - i], e.defenderTicks ?? t);
      } else {
        freeze[0] = Math.max(freeze[0], t);
        freeze[1] = Math.max(freeze[1], t);
      }
    }));
  }

  function unlisten() { for (const off of offBus) off?.(); offBus = []; }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * Advance exactly one frame.
   *
   * This is `Game#simulate`'s FIGHT case plus `Game#frame`'s freeze drain, and
   * nothing else. It reads no clock: there is no `dt`, no accumulator and no
   * `requestAnimationFrame`, so a frame here is a frame anywhere and the
   * machine it runs on cannot change the answer.
   */
  function advance() {
    // Fire this frame's scheduled key edges BEFORE the tick, which is when a
    // real keyboard's events land relative to the sim: `Input#beginTick` reads
    // whatever is down at that instant.
    /*
     * IN INSERTION ORDER, WHICH A BACKWARD SPLICE IS NOT.
     *
     * The first version walked `pending` backwards and spliced, so several
     * edges on the same frame fired in REVERSE of the order they were
     * scheduled. That is invisible for two different keys — the held set is a
     * set — and decisive for a down and an up of the SAME key on one frame,
     * which `makeInputLog` produces whenever a press is clamped to the last
     * frame of a run.
     *
     * It cost a whole repro path: a fuzzer bundle recorded its edges in
     * dispatch order (already reversed), replaying re-reversed them, and seed
     * 11 came back with digest a596419f against the recorded 40c3c5f5. The
     * same seed run twice through the fuzzer matched perfectly, so the harness
     * looked deterministic while its own replay was not — the worst place for
     * an ordering bug to hide.
     */
    const fire = [];
    pending = pending.filter((e) => (e.frame === frame ? (fire.push(e), false) : true));
    for (const e of fire) {
      const facing = fighters()[e.player]?.facing ?? 1;
      const code = physicalFor(e.player, e.key, facing);
      if (!code) continue;
      kb.set(code, e.action !== 'up');
      /*
       * THE LOG IS RECORDED IN THE SHAPE `input()` ACCEPTS, and that is not a
       * cosmetic choice — it is the difference between a repro bundle that
       * replays and one that silently does nothing.
       *
       * The first version stored the resolved code under `code`. `input()`
       * reads `key`, so replaying a fuzzer bundle handed it `key: undefined`,
       * every edge was dropped, and the replay ran 300 frames of two fighters
       * standing still — which the harness then reported as "NO LONGER FAILS".
       * A repro path that reports a fix when it has replayed nothing is worse
       * than no repro path.
       *
       * `key` holds the PHYSICAL code rather than the facing-relative token
       * that produced it. Those two are the same thing only while a fighter
       * stays on the side it started on; a run that crossed over would replay
       * differently from the tokens and identically from the codes, and it is
       * the codes the sim actually saw.
       */
      inputLog.push({ frame, player: e.player, key: code, action: e.action });
    }

    const before = events.length;
    let frozen = false;

    if (freeze[0] > 0 && freeze[1] > 0) {
      // Both held: no simulation tick runs at all. This is the freeze.
      freeze[0]--; freeze[1]--;
      frozen = true;
    } else {
      input.beginTick(frame);
      const cmds = [
        game.cpu?.[0] ? game.cpu[0].think(frame) : input.commandsFor(0, A()),
        game.cpu?.[1] ? game.cpu[1].think(frame) : input.commandsFor(1, D()),
      ];
      for (let i = 0; i < 2; i++) {
        if (freeze[i] > 0) { freeze[i]--; continue; }
        fighters()[i].simulate(cmds[i]);
      }
      game.combat.simulate(frame);
      input.endTick();
    }

    // The camera is part of the sim tick in `Game`, and "inconsistent camera"
    // is one of the defects the contact sheet exists to catch — so it has to be
    // driven off the same frame clock, not off whatever the render loop
    // happened to do between two captures.
    game.fightCamera?.simulate?.(game.phase || 'fight', frame);

    record(frozen, events.slice(before).map((e) => e.type));
    frame++;
  }

  // -------------------------------------------------------------------------
  // The façade
  // -------------------------------------------------------------------------

  const api = {
    /**
     * Put the simulation in a known state and make the seed real.
     *
     * SEEDING IS NOT DECORATION HERE. `Fighter#reset` constructs a fresh `Rng`
     * from `0x51ed2701 + index * 0x9e37` — a constant — and `CombatSystem`'s is
     * another constant, so without this every "seeded" run would be the same
     * run and a fuzzer would explore one trajectory very thoroughly. The seed
     * is mixed into all three generators AFTER `reset()` has replaced them,
     * which is the only order that works: reset overwrites the object, so
     * reseeding before it is a no-op that looks like it worked.
     *
     * @param {{seed?:number, dist?:number, cpu?:?number, p1?:number, p2?:number,
     *          training?:boolean}} o
     */
    reset(o = {}) {
      seed = (o.seed ?? 0) >>> 0;
      pending = [];
      inputLog = [];
      timeline = [];
      events = [];
      frame = 0;
      freeze[0] = 0; freeze[1] = 0;
      scenario = null;

      // Take the game's own loop out of the way. It keeps RENDERING — that is
      // what makes `captureFrame` possible — but its accumulator stops being
      // fed, so the only thing advancing the simulation is `step()`.
      if (wasPaused === null && 'paused' in game) wasPaused = game.paused;
      if ('paused' in game) game.paused = true;

      // See the note on `kb`/`input`: the old pair is torn down rather than
      // cleared, because "cleared" would mean knowing every field `Input`
      // carries, and the list is not this file's to keep up to date.
      kb.release();
      input.dispose();
      kb = makeSynthKeyboard();
      input = new Input(kb.target);

      if (roster && (o.p1 != null || o.p2 != null)) {
        if (o.p1 != null && roster[o.p1]) A().setCharacter(roster[o.p1]);
        if (o.p2 != null && roster[o.p2]) D().setCharacter(roster[o.p2]);
      }

      A().reset(new THREE.Vector3(-1.9, GROUND_Y, 0), 1);
      D().reset(new THREE.Vector3(1.9, GROUND_Y, 0), -1);
      game.combat.reset();

      /*
       * THE TWO FIELDS `Fighter#reset` DOES NOT CLEAR, AND WHY THAT MATTERS
       * HERE MORE THAN IT DOES IN THE GAME.
       *
       * Found by running the same scenario four times in one process and
       * diffing the trajectories field by field. Runs 2, 3 and 4 were
       * bit-identical to each other and run 1 was not, on exactly these:
       *
       *     strike-connects  run1->2  a.meter 0 -> 7.128    a.footL 1 -> 0.0218
       *                      run2->3  a.meter 7.128 -> 14.256
       *                      run3->4  a.meter 14.256 -> 21.384
       *
       * METER. `reset()` does `meter = min(meter, METER_MAX * 0.25)` on
       * purpose: a fighter is meant to carry up to a quarter bar between the
       * rounds of a match. Correct for a match, wrong for a test — a scenario
       * that lands a blow banks meter, and the NEXT scenario starts with it,
       * climbing 7.128 a run until it saturates at 25 four runs later. Every
       * trajectory in between is a different trajectory, and a meter-gated move
       * would start in one and refuse in another. The harness therefore starts
       * from the CONSTRUCTED value, which is what "a clean run" has to mean.
       *
       * FOOT STATE. `footState[side].y` is the previous tick's sole height and
       * is initialised to 1 in the constructor, but `reset()` never touches it,
       * so it enters a new round holding the last frame of the old one.
       * `#trackFootfalls` computes `dv = h - s.y` and emits `footstep` on a
       * falling edge, so the very first tick after a reset compares against a
       * stale height and can fire or swallow a footfall that has nothing to do
       * with the round it is in. Restored to 1 for the same reason as the
       * meter: a scenario starts where a freshly built fighter starts.
       *
       * Both are reported as product findings in docs/SIMTEST.md rather than
       * fixed in `Fighter.js`, which this workstream does not own.
       */
      for (const f of [A(), D()]) {
        f.meter = 0;
        f.footState.L.y = 1; f.footState.L.down = false;
        f.footState.R.y = 1; f.footState.R.down = false;
      }

      // The mixing constants are arbitrary but must be DIFFERENT per stream, or
      // the two fighters and the combat system draw the same sequence and a
      // "random" wake-up on one side predicts the other.
      A().rng.reseed(seed ^ 0x1111_1111);
      D().rng.reseed(seed ^ 0x2222_2222);
      game.combat.rng?.reseed?.(seed ^ 0x3333_3333);

      // The CPU is OFF unless asked for. A scripted scenario with a live
      // opponent is not a scripted scenario: the bot's decisions depend on the
      // whole trajectory, so a one-frame change anywhere rewrites the rest of
      // the run and every invariant becomes a coin toss.
      if (game.cpu) {
        game.cpu[0] = null;
        if (o.cpu != null && game.cpu[1]) game.cpu[1].setLevel(o.cpu);
        else if (o.cpu == null) game.cpu[1] = null;
      }
      // The CPU reseeds itself off this event, which is how it gets folded into
      // the run's seed at all.
      bus.emit('roundStart', { round: 1 });

      harness.stage(A(), D(), o.dist ?? 2.4);
      if (o.training) { A().health = MAX_HEALTH * 100; D().health = MAX_HEALTH * 100; }
      listen();
      record(false, []);
      // `record` stamped frame 0 and then `advance` will stamp it again on the
      // first step, so the pre-input row is filed at -1: it is the staged pose
      // BEFORE any tick has run, which is exactly the "before input" reference
      // a contact sheet wants and is not a simulated frame.
      timeline[0].frame = -1;
      return api.getState();
    },

    /**
     * Load a named scenario: cast, spacing, seed and the whole input script.
     * Nothing is simulated — call `step()` or `run()` next.
     * @param {string} name a key of `SCENARIOS`
     * @param {{seed?:number}} [o]
     */
    loadScenario(name, o = {}) {
      const scn = SCENARIOS[name];
      if (!scn) throw new Error(`[__GAME_TEST__] unknown scenario "${name}" — have: ${Object.keys(SCENARIOS).join(', ')}`);
      api.reset({ seed: o.seed ?? 0, dist: scn.dist, p1: scn.p1, p2: scn.p2, cpu: scn.cpu ?? null });
      scenario = { name, ...scn };
      for (const e of scn.script) api.input(e);
      return { name, frames: scn.frames, dist: scn.dist, inputs: scn.script.length, what: scn.what };
    },

    /**
     * Schedule an input on a FRAME.
     *
     * The whole point of the unit. A test that says "press punch after 200 ms"
     * is a test whose result depends on how fast the machine is; a test that
     * says "press punch on frame 12" is a test that has a single answer.
     *
     * @param {{frame:number, key:string, action?:'down'|'up', player?:number}|Array} e
     */
    input(e) {
      if (Array.isArray(e)) { for (const x of e) api.input(x); return api; }
      pending.push({ frame: e.frame | 0, key: e.key, action: e.action || 'down', player: e.player ?? 0 });
      return api;
    },

    /** Advance `n` frames. @returns {number} frames advanced */
    step(n = 1) {
      for (let i = 0; i < n; i++) advance();
      return n;
    },

    /**
     * Advance until something named happens.
     *
     * `what` is either an event type ('hit', 'knockdown', ...) or a state
     * predicate written as `state:<0|1|a|d>:<stateName>`. Returns the frame it
     * stopped on, or null if it never happened inside `limit` — never a
     * silent success, because "the hit never came" and "the hit came on frame
     * 23" have to be distinguishable from the outside.
     *
     * @param {string} what
     * @param {{limit?:number}} [o]
     */
    stepUntil(what, o = {}) {
      const limit = o.limit ?? 600;
      const m = /^state:([01ad]):(.+)$/.exec(what);
      const idx = m ? (m[1] === 'a' ? 0 : m[1] === 'd' ? 1 : +m[1]) : -1;
      for (let i = 0; i < limit; i++) {
        const mark = events.length;
        advance();
        if (m) {
          if (fighters()[idx].state === m[2]) return { frame: frame - 1, what, state: m[2] };
        } else if (events.slice(mark).some((e) => e.type === what)) {
          return { frame: frame - 1, what, event: events[events.length - 1] };
        }
      }
      return null;
    },

    /** The current serializable state of the whole simulation. */
    getState() {
      return {
        frame,
        seed,
        scenario: scenario?.name ?? null,
        frozen: freeze[0] > 0 && freeze[1] > 0,
        freeze: [...freeze],
        held: [...kb.held].sort(),
        a: snap(A()),
        d: snap(D()),
      };
    },

    /**
     * Aggregates over the run so far.
     *
     * Everything here is derived from the timeline and the event log rather
     * than accumulated as the run goes, so a metric can never disagree with the
     * frames it is supposed to summarise.
     */
    getMetrics() {
      const hits = events.filter((e) => e.type === 'hit');
      const blocks = events.filter((e) => e.type === 'block');
      const sim = timeline.filter((r) => r.frame >= 0 && !r.frozen).length;
      const frozen = timeline.filter((r) => r.frozen).length;
      const first = timeline[0]; const last = timeline[timeline.length - 1];
      const travel = (side) => {
        let d = 0;
        for (let i = 1; i < timeline.length; i++) {
          if (timeline[i].frozen) continue;
          const p = timeline[i - 1][side]; const c = timeline[i][side];
          d += Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z);
        }
        return +d.toFixed(4);
      };
      return {
        frames: frame,
        simFrames: sim,
        frozenFrames: frozen,
        events: events.length,
        hits: hits.length,
        blocks: blocks.length,
        whiffs: events.filter((e) => e.type === 'whiff').length,
        damageToDefender: first && last ? +(first.d.hp - last.d.hp).toFixed(3) : 0,
        damageToAttacker: first && last ? +(first.a.hp - last.a.hp).toFixed(3) : 0,
        maxCombo: timeline.reduce((m, r) => Math.max(m, r.a.combo, r.d.combo), 0),
        defenderPeakY: timeline.reduce((m, r) => Math.max(m, r.d.y), 0),
        attackerTravel: travel('a'),
        defenderTravel: travel('d'),
        // The generator states at the end of the run. Two runs that agree on
        // everything else and disagree here have drawn a different NUMBER of
        // randoms, which is a divergence that has not surfaced yet rather than
        // one that is not there.
        rngEnd: last ? { a: last.a.rng, d: last.d.rng } : null,
      };
    },

    /**
     * A one-line fingerprint of the whole trajectory.
     *
     * The determinism test is a string comparison over this, per frame. It is a
     * plain FNV-1a over the serialised rows rather than anything cryptographic:
     * the job is to make two different trajectories produce two different
     * strings, and a 32-bit hash over a 90-row timeline does that while staying
     * readable in a terminal.
     */
    digest() {
      let h = 0x811c9dc5;
      for (const r of timeline) {
        const s = JSON.stringify(r);
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    },

    getTimeline() { return timeline; },
    getEvents() { return events; },
    getInputLog() { return inputLog; },
    getScenario() { return scenario; },

    /**
     * A save state.
     *
     * HONEST ABOUT ITS FIDELITY, because the alternative is a harness that
     * quietly lies about rewinding. What is captured is every sim-visible field
     * plus all three generator states — which is a complete description of the
     * SIMULATION but not of the POSE: the animator carries springs, inertia,
     * blend stacks, IK hold quaternions and a ripple queue, and none of that is
     * serialisable without reaching into `Animator`'s privates.
     *
     * So `loadState` rebuilds the pose from a clean `reset()` and replays the
     * clip, which is exact for a state taken at frame 0 and approximate for one
     * taken mid-move. Frame 0 is the case that matters: it is what a fuzzer
     * repro bundle stores, and combined with the input log it reproduces the
     * failure exactly. `tools/simscene.mjs --savestate` measures the mid-run
     * error rather than assuming it, and docs/SIMTEST.md quotes the number.
     */
    saveState() {
      const f = (x) => ({
        pos: [x.position.x, x.position.y, x.position.z],
        vel: [x.velocity.x, x.velocity.y, x.velocity.z],
        facing: x.facing, state: x.state, stateTicks: x.stateTicks, stun: x.stunTicks,
        health: x.health, recoverable: x.recoverable, meter: x.meter,
        combo: x.comboCount, juggle: x.juggleCount, comboDamage: x.comboDamage,
        move: x.currentMove?.id ?? null, moveTick: x.moveTick, moveInstance: x.moveInstance,
        air: x.airborne, ground: x.grounded, crouch: x.crouching, block: x.isBlocking,
        simTick: x.simTick, clip: x.currentClip,
        rng: [x.rng.s0, x.rng.s1],
      });
      return {
        version: 1, frame, seed, scenario: scenario?.name ?? null,
        clean: frame === 0,
        held: [...kb.held],
        pending: pending.map((p) => ({ ...p })),
        a: f(A()), d: f(D()),
        combatRng: game.combat.rng ? [game.combat.rng.s0, game.combat.rng.s1] : null,
      };
    },

    /** Restore a save state. See `saveState` for what "restore" means here. */
    loadState(s) {
      api.reset({ seed: s.seed, dist: 2.4 });
      const put = (x, v) => {
        x.position.set(v.pos[0], v.pos[1], v.pos[2]);
        x.prevPosition.copy(x.position);
        x.velocity.set(v.vel[0], v.vel[1], v.vel[2]);
        x.facing = v.facing;
        x.state = v.state; x.stateTicks = v.stateTicks; x.stunTicks = v.stun;
        x.health = v.health; x.recoverable = v.recoverable; x.meter = v.meter;
        x.comboCount = v.combo; x.juggleCount = v.juggle; x.comboDamage = v.comboDamage;
        x.moveTick = v.moveTick; x.moveInstance = v.moveInstance;
        x.airborne = v.air; x.grounded = v.ground; x.crouching = v.crouch; x.isBlocking = v.block;
        x.simTick = v.simTick;
        x.rng.s0 = v.rng[0]; x.rng.s1 = v.rng[1];
        /*
         * A CLEAN STATE IS ALREADY RESTORED BY THE `reset()` ABOVE, AND
         * TOUCHING THE ANIMATOR AGAIN IS WHAT BROKE IT.
         *
         * The first version replayed the saved clip unconditionally, with
         * `loop: false`. For a frame-0 state the saved clip is `idle.fight`,
         * which `reset()` had just played with `loop: true` — so the reload
         * left the fighter on a NON-looping idle, the entry retired part way
         * through the run, and every frame-0 reload diverged from the run it
         * was supposed to reproduce. All six scenarios, silently, in the one
         * case the whole feature exists for.
         *
         * So a clean state skips the pose restore entirely: `reset()` is
         * definitionally the frame-0 pose, and the least code that can be
         * wrong here is no code at all. Mid-run states still get the
         * approximation, and `--savestate` prints how far off it is.
         */
        if (!s.clean && v.clip) {
          x.currentClip = '';
          x.animator?.play(v.clip, { blend: 0, loop: false });
          x.currentClip = v.clip;
        }
      };
      put(A(), s.a); put(D(), s.d);
      if (s.combatRng && game.combat.rng) { game.combat.rng.s0 = s.combatRng[0]; game.combat.rng.s1 = s.combatRng[1]; }
      kb.release();
      for (const c of s.held || []) kb.set(c, true);
      pending = (s.pending || []).map((p) => ({ ...p }));
      frame = s.frame;
      timeline = []; events = [];
      record(false, []);
      timeline[0].frame = frame - 1;
      return api.getState();
    },

    /**
     * Render the CURRENT frame and hand back a PNG data URL.
     *
     * Presentation is separable from game logic in this engine and this is the
     * seam: nothing above this line has touched the renderer, and a run that
     * never calls this never allocates a GL context. `alpha` is pinned to 1, so
     * what comes back is the pose at the end of the frame just simulated rather
     * than an interpolation toward it — a contact sheet of interpolated frames
     * cannot be lined up against a timeline of simulated ones.
     */
    captureFrame() {
      if (!game.renderer?.screenshot) return null;
      for (const f of fighters()) f.render(1, TICK_DT);
      game.fightCamera?.render?.(1, TICK_DT);
      return game.renderer.screenshot();
    },

    /** Hand the game back its own loop. */
    release() {
      unlisten();
      kb.release();
      if (wasPaused !== null && 'paused' in game) { game.paused = wasPaused; wasPaused = null; }
    },

    /** Tear down the synthetic keyboard's listeners. */
    dispose() { api.release(); input.dispose(); },
  };

  return api;
}
