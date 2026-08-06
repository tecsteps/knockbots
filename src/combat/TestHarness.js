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
import { METER_MAX, MAX_HEALTH, GROUND_Y } from '../core/Constants.js';
import { bus } from '../core/Bus.js';
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
