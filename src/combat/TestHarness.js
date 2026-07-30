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
import { STATE } from './Fighter.js';

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
    if (fighter.animator?.play) fighter.animator.play(move.clip, { blend: 0, loop: false });
    fighter.fastForward(Math.max(0, move.startup - lead));
  }

  function hideLineup() {
    if (!lineup) return;
    for (const e of lineup) {
      game.scene.remove(e.group);
      if (e.robot?.dispose) e.robot.dispose();
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

      const spacing = opts.spacing ?? 1.65;
      const poses = ['i.stanceSet', 'idle.fight', 'v.pose', 'i.pointTaunt', 'idle.taunt', 'v.saluteCharge'];
      lineup = [];
      const n = ROSTER.length;
      for (let i = 0; i < n; i++) {
        const def = ROSTER[i];
        const bundle = createSkeleton(def.proportions);
        const robot = buildRobot(def, bundle, game.environment);
        const group = new THREE.Group();
        group.name = `lineup_${def.id}`;
        if (robot?.group) group.add(robot.group);
        if (!bundle.byName.root.parent) group.add(bundle.byName.root);
        group.position.set((i - (n - 1) / 2) * spacing, GROUND_Y, 0);
        group.rotation.y = Math.PI + (i - (n - 1) / 2) * 0.06;
        game.scene.add(group);

        const animator = new Animator(bundle, CLIPS);
        animator.play(poses[i % poses.length], { blend: 0, loop: true });
        for (let t = 0; t < 40 + i * 7; t++) animator.simulate(t);
        animator.applyTo(bundle.bones, 1);
        group.updateMatrixWorld(true);
        lineup.push({ group, robot, animator, bundle, offset: i * 7 });
      }

      game.fightCamera?.cinematic?.('lineup', {
        dist: Math.max(9, n * spacing * 0.95),
        height: 1.9,
        target: new THREE.Vector3(0, 1.0, 0),
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
