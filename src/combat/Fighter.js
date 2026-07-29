/**
 * Knockbots — the fighter: state machine, physics, and the bridge between the
 * simulation and the visible robot.
 *
 * Authority split
 * ---------------
 * `simulate()` is the only thing that may change game state, and it runs at a
 * fixed 60Hz. It advances the animator by exactly one tick, writes the *final*
 * pose onto the bones, and reads hurtboxes and hitboxes straight off the posed
 * bone world matrices — never off the rest pose — so a hitbox is where the fist
 * actually is on that frame. `render()` re-applies the same pose interpolated by
 * `alpha` and drives purely cosmetic systems (emissive pulse, actuator
 * extension, damage smoke). Nothing in `render()` is allowed to feed back into
 * the sim.
 *
 * Facing convention
 * -----------------
 * `facing` is +1 when the opponent sits at a greater X.
 *
 * The rig's front is its local **+Z**. Skeleton.js's prose header says -Z, but
 * its geometry says otherwise and the geometry is what everything else is built
 * on: `toe_*` sits at +Z of the foot, `IK_CHAINS` aims the knee poles at +Z and
 * the elbow poles at -Z, and every animation clip was authored against that
 * frame (see `animations/punches.js`, which states it outright). Hitboxes come
 * off those posed bones, so combat has to agree with the animation or a jab
 * would travel backwards. `FORWARD_SIGN` is the single switch if the rig is
 * ever re-authored.
 *
 * A fighter auto-turns when crossed up, but never in the middle of an attack —
 * that is what makes crossovers and back throws readable.
 */

import * as THREE from 'three';
import {
  GRAVITY, GROUND_Y, TICK_DT, FIGHTER_RADIUS, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH,
  MAX_HEALTH, CHIP_DAMAGE_RATIO, RECOVERABLE_RATIO, RECOVERY_PER_TICK,
  METER_MAX, METER_ON_DEAL, METER_ON_TAKE, METER_ON_BLOCK,
  INPUT_BUFFER_TICKS, HEIGHT, REACTION,
} from '../core/Constants.js';
import { bus } from '../core/Bus.js';
import { Rng } from '../core/Rng.js';
import { BONES, HURTBOX_BONES, IK_CHAINS, createSkeleton } from '../characters/Skeleton.js';
import { activeBoxes, isActive, isInvulnerable } from './MoveSchema.js';
import { MOVES, findMove } from './Moves.js';
import { Animator } from '../characters/Animator.js';
import { CLIPS } from '../characters/animations/index.js';
import { buildRobot } from '../characters/RobotBuilder.js';

export const STATE = {
  IDLE: 'idle', WALK: 'walk', DASH: 'dash', BACKDASH: 'backdash', CROUCH: 'crouch',
  SIDESTEP: 'sidestep', JUMP_RISE: 'jumpRise', JUMP_APEX: 'jumpApex', JUMP_FALL: 'jumpFall',
  ATTACK: 'attack', BLOCK_HIGH: 'blockHigh', BLOCK_LOW: 'blockLow', BLOCKSTUN: 'blockstun',
  HITSTUN: 'hitstun', LAUNCHED: 'launched', JUGGLED: 'juggled', KNOCKDOWN: 'knockdown',
  WAKEUP: 'wakeup', THROW: 'throw', THROWN: 'thrown', KO: 'ko', INTRO: 'intro',
  VICTORY: 'victory',
};

// Movement tuning, metres/second and ticks.
const WALK_FWD = 2.75;
const WALK_BACK = 2.25;
const CROUCH_WALK = 1.25;
const DASH_SPEED = 7.4;
const DASH_TICKS = 14;
const BACKDASH_SPEED = 8.6;
const BACKDASH_TICKS = 22;
const SIDESTEP_SPEED = 3.8;
const SIDESTEP_TICKS = 20;
const JUMP_VY = 7.7;
const JUMP_HOLD_TICKS = 7;      // hold up this long and the sidestep becomes a jump
const GROUND_FRICTION = 0.80;
const SLIDE_FRICTION = 0.93;    // while stunned — knockback should actually carry
const AIR_DRAG = 0.996;
// Juggle gravity is deliberately weaker than jump gravity. A jump wants to feel
// snappy; a juggle needs a full second of hang time or there is no combo to
// perform. Every fighting game runs two gravities and so do we.
const JUGGLE_GRAVITY = 0.42;
// Authored launch heights are tuned against normal gravity; under juggle gravity
// they need trimming or the victim floats above the camera framing.
const LAUNCH_SCALE = 0.85;
const FOOT_CLEAR = 0.055;       // ankle height above the floor when planted
// How much of the animation's authored root translation the body actually takes.
const ROOT_MOTION_SCALE = 1.0;

/** +1 when the rig's local +Z is its front. See the file header. */
export const FORWARD_SIGN = 1;
/** Root yaw that points the rig's front along the fighter's facing. */
export const yawForFacing = (facing) => facing * FORWARD_SIGN * Math.PI / 2;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Mirror of Skeleton.scaleFor — hurtbox radii must scale with the proportions. */
function proportionScale(name, p) {
  if (!p) return 1;
  if (/^(hip_|knee_|ankle_|foot_|toe_)/.test(name)) return p.legs ?? 1;
  if (/^(shoulder_|elbow_|wrist_|hand_|fingers_|thumb_|clavicle_)/.test(name)) return p.arms ?? 1;
  if (/^(spine|chest|neck)/.test(name)) return p.torso ?? 1;
  if (name === 'head' || name === 'headTop') return p.head ?? 1;
  if (name === 'hips') return p.height ?? 1;
  return 1;
}

export class Fighter {
  /** Clip ids we have already warned about, so the console stays readable. */
  static missingClips = new Set();

  /**
   * @param {{index:number, def:Object, scene:THREE.Scene, environment:Object}} opts
   */
  constructor({ index, def, scene, environment }) {
    this.index = index;
    this.def = def;
    this.scene = scene;
    this.environment = environment;

    this.facing = index === 0 ? 1 : -1;
    this.visualYaw = yawForFacing(this.facing);
    this.position = new THREE.Vector3((index === 0 ? -1.9 : 1.9), 0, 0);
    this.prevPosition = this.position.clone();
    this.velocity = new THREE.Vector3();

    this.state = STATE.IDLE;
    this.stateTicks = 0;
    this.simTick = 0;

    this.health = MAX_HEALTH;
    this.recoverable = 0;
    this.meter = 0;
    this.comboCount = 0;
    this.comboDamage = 0;
    this.juggleCount = 0;

    this.airborne = false;
    this.grounded = true;
    this.crouching = false;
    this.isBlocking = false;
    this.guardHeight = HEIGHT.HIGH;
    this.isCounterHit = false;
    this.invulnerable = false;
    this.throwInvuln = 0;

    this.currentMove = null;
    this.moveTick = 0;
    this.moveInstance = 0;
    this.connected = new Set();     // "<instance>:<windowIndex>" already landed
    this.hitConnectedThisMove = false;

    this.hurtboxes = [];
    this.hitboxes = [];
    this.activeHitboxes = 0;

    this.inputBuffer = [];
    this.cmd = null;
    this.upHeldTicks = 0;
    this.pendingSidestep = 0;

    this.radius = FIGHTER_RADIUS;
    this.floorY = GROUND_Y;
    this.bounds = { halfWidth: ARENA_HALF_WIDTH, halfDepth: ARENA_HALF_DEPTH };
    this.gravityScale = 1;
    this.wallImpact = null;
    this.bounceRemaining = 0;
    this.bounceFactor = 0;

    this.stunTicks = 0;
    this.reaction = null;
    this.lastDamageTick = -999;
    this.damageLevel = 0;
    this.brokenParts = new Set();

    this.throwPartner = null;
    this.throwData = null;
    this.throwBroken = false;

    this.opponent = null;
    this.moveSetKey = def?.moveSet && MOVES[def.moveSet] ? def.moveSet : 'standard';
    this.stats = def?.stats || { power: 5, speed: 5, reach: 5, weight: 5, defense: 5 };

    this.rng = new Rng(0x51ed2701 + index * 0x9e37);
    this.group = new THREE.Group();
    this.group.name = `fighter${index}`;
    this.group.matrixAutoUpdate = true;

    this.robot = null;
    this.animator = null;
    this.bones = null;
    this.boneByName = null;
    this.emissiveMats = [];
    this.actuators = [];
    this.footState = { L: { y: 1, down: false }, R: { y: 1, down: false } };
    this.currentClip = '';
    this.ready = false;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Build the rig, the robot mesh and the animator. */
  async init() {
    this.scene.add(this.group);
    this.#buildRig();
    this.ready = true;
    return this;
  }

  #buildRig() {
    const prop = this.def?.proportions || null;
    const bundle = createSkeleton(prop);
    this.skeletonBundle = bundle;
    this.bones = bundle.bones;
    this.boneByName = bundle.byName;

    // Hurtbox capsule descriptors, resolved once against the scaled rig.
    this.hurtDefs = HURTBOX_BONES.map((name) => {
      const d = BONES.find((b) => b.name === name);
      const s = proportionScale(name, prop);
      return { name, radius: (d.radius || 0.12) * s, length: (d.length || 0) * s, region: d.region };
    });
    this.hurtboxes = this.hurtDefs.map((d) => ({
      bone: d.name, region: d.region, radius: d.radius,
      p0: new THREE.Vector3(), p1: new THREE.Vector3(),
    }));
    // Hitbox pool — generous, reused, never reallocated during a match.
    this.hitboxPool = [];
    for (let i = 0; i < 8; i++) {
      this.hitboxPool.push({
        bone: '', radius: 0, windowIndex: 0, move: null,
        p0: new THREE.Vector3(), p1: new THREE.Vector3(), tip: new THREE.Vector3(),
      });
    }
    this.hitboxes = [];
    /** Per-bone world position this tick and last, for swept hitboxes. */
    this.boneTrack = Object.create(null);
    this.moveBones = null;

    this.robot = buildRobot(this.def, bundle, this.environment);
    if (this.robot?.group) this.group.add(this.robot.group);
    // Some builders parent the rig themselves; if not, do it here.
    if (!bundle.byName.root.parent) this.group.add(bundle.byName.root);

    this.animator = new Animator(bundle, CLIPS);
    this.#collectVisualParts();
    this.#play('idle.fight', 0, true);
    this.#drivePose();
    this.#buildHurtboxes();
  }

  /**
   * Cache what the presentation layer drives every frame.
   *
   * A builder that exposes `robot.update(dt, state)` owns its own emissive
   * groups, so we hand it health/meter/pulse and stay out of its way. Otherwise
   * we drive the emissive materials directly. Actuators are the same deal: a
   * builder may hand back plain Object3Ds spanning two bones (we place them), or
   * an instanced rig that re-measures itself inside `updateMatrixWorld` (we only
   * have to keep the matrices fresh, which `#drivePose` and `render` both do).
   */
  #collectVisualParts() {
    this.robotUpdate = typeof this.robot?.update === 'function' ? this.robot.update : null;
    this.emissiveMats.length = 0;
    const seen = new Set();
    const glowy = [];
    const anyEmissive = [];
    if (this.robotUpdate) { this.#collectActuators(); return; }
    this.group.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      if (!mats) return;
      for (const m of mats) {
        if (!m || !m.emissive || seen.has(m)) continue;
        seen.add(m);
        const rec = { mat: m, base: m.emissiveIntensity ?? 1 };
        anyEmissive.push(rec);
        if (m.userData?.pulse === true || /emissive|glow|eye|vent|core|reactor/i.test(m.name || '')) glowy.push(rec);
      }
    });
    const chosen = glowy.length ? glowy : anyEmissive;
    for (const rec of chosen) this.emissiveMats.push(rec);
    this.#collectActuators();
  }

  #collectActuators() {
    this.actuators.length = 0;
    const list = this.robot?.parts?.actuators;
    const entries = Array.isArray(list) ? list : (list ? Object.values(list) : []);
    for (const e of entries) {
      const obj = e?.isObject3D ? e : (e?.object || e?.mesh);
      if (!obj) continue;
      const src = e.isObject3D ? (e.userData || {}) : e;
      const aName = src.from || src.boneA || obj.userData?.from;
      const bName = src.to || src.boneB || obj.userData?.to;
      const a = this.boneByName[aName];
      const b = this.boneByName[bName];
      if (!a || !b) continue;
      this.actuators.push({ obj, a, b, restLen: 0, baseScale: obj.scale.y || 1 });
    }
  }

  /** Swap character without rebuilding the scene graph wrapper. */
  setCharacter(def) {
    if (!def) return;
    this.def = def;
    this.stats = def.stats || this.stats;
    this.moveSetKey = def.moveSet && MOVES[def.moveSet] ? def.moveSet : 'standard';
    if (!this.ready) return;
    if (this.robot?.dispose) this.robot.dispose();
    if (this.robot?.group) this.group.remove(this.robot.group);
    const root = this.skeletonBundle?.byName?.root;
    if (root?.parent) root.parent.remove(root);
    this.#buildRig();
  }

  setOpponent(other) { this.opponent = other; }

  /** Stage geometry, handed over by CombatSystem once the arena exists. */
  setBounds(bounds, floorY = GROUND_Y) {
    if (bounds) {
      this.bounds.halfWidth = bounds.halfWidth ?? this.bounds.halfWidth;
      this.bounds.halfDepth = bounds.halfDepth ?? this.bounds.halfDepth;
    }
    this.floorY = floorY;
  }

  reset(pos, facing) {
    this.position.copy(pos);
    this.position.y = this.floorY;
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    this.visualYaw = yawForFacing(facing);
    this.health = MAX_HEALTH;
    this.recoverable = 0;
    this.meter = Math.min(this.meter, METER_MAX * 0.25);
    this.comboCount = 0;
    this.comboDamage = 0;
    this.juggleCount = 0;
    this.state = STATE.IDLE;
    this.stateTicks = 0;
    this.stunTicks = 0;
    this.reaction = null;
    this.currentMove = null;
    this.moveTick = 0;
    this.connected.clear();
    this.hitboxes.length = 0;
    this.inputBuffer.length = 0;
    this.airborne = false;
    this.grounded = true;
    this.crouching = false;
    this.isBlocking = false;
    this.isCounterHit = false;
    this.invulnerable = false;
    this.throwInvuln = 0;
    this.throwPartner = null;
    this.throwData = null;
    this.damageLevel = 0;
    this.brokenParts.clear();
    this.bounceRemaining = 0;
    this.wallImpact = null;
    this.upHeldTicks = 0;
    this.pendingSidestep = 0;
    this.lastDamageTick = -999;
    if (this.animator) this.#play('idle.fight', 0, true);
    this.#drivePose();
    this.#buildHurtboxes();
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Advance one 60Hz tick.
   * @param {?Object} cmd the Command for this fighter, or null (no input)
   */
  simulate(cmd) {
    this.simTick++;
    this.stateTicks++;
    this.prevPosition.copy(this.position);
    this.cmd = cmd;
    this.wallImpact = null;

    this.#pushInput(cmd);
    this.#updateFacing();
    this.#updateGuard(cmd);
    this.#updateState(cmd);
    this.#applyMoveMotion();
    this.#advanceAnimation();
    this.#integrate();
    this.#pushApart();
    this.#clampToArena();
    this.#regen();
    this.#updateFlags();
    this.#writePose();
    this.#buildHurtboxes();
    this.#buildHitboxes();
    this.#footIk();
    this.#trackFootfalls();
  }

  /** Cinematic entrance; `t` is the intro phase tick. */
  simulateIntro(t) {
    this.simTick++;
    this.state = STATE.INTRO;
    const home = this.index === 0 ? -1.9 : 1.9;
    if (t === 0) {
      this.position.set(home + -this.facing * 3.2, this.floorY, this.index === 0 ? 0.6 : -0.6);
      this.prevPosition.copy(this.position);
      this.#play('i.walkOn', 0, false);
    }
    this.prevPosition.copy(this.position);

    if (t < 84) {
      const u = t / 84;
      const e = u * u * (3 - 2 * u);
      this.position.x = THREE.MathUtils.lerp(home + -this.facing * 3.2, home, e);
      this.position.z = THREE.MathUtils.lerp(this.index === 0 ? 0.6 : -0.6, 0, e);
    } else if (t === 84) {
      this.#play(this.index === 0 ? 'i.powerUp' : 'i.pointTaunt', 6, false);
    } else if (t === 128) {
      this.#play('i.stanceSet', 6, false);
    }
    this.position.y = this.floorY;
    this.facing = this.opponent ? Math.sign(this.opponent.position.x - this.position.x) || this.facing : this.facing;
    this.#drivePose();
    this.#buildHurtboxes();
    this.hitboxes.length = 0;
  }

  // --- input ---------------------------------------------------------------

  #pushInput(cmd) {
    const buf = this.inputBuffer;
    while (buf.length && this.simTick - buf[0].tick > INPUT_BUFFER_TICKS) buf.shift();
    if (!cmd) return;
    if (cmd.pressed && cmd.pressed.size) {
      buf.push({
        tick: this.simTick,
        btns: new Set(cmd.pressed),
        fwd: !!cmd.fwd, back: !!cmd.back, up: !!cmd.up, down: !!cmd.down,
        motion: cmd.motion || null,
        used: false,
      });
      if (buf.length > 24) buf.shift();
    }
  }

  #updateFacing() {
    if (!this.opponent) return;
    if (this.state === STATE.ATTACK || this.state === STATE.THROW || this.state === STATE.THROWN) return;
    if (this.airborne || this.stunTicks > 0) return;
    const d = this.opponent.position.x - this.position.x;
    if (Math.abs(d) < 0.06) return;
    this.facing = d > 0 ? 1 : -1;
  }

  #updateGuard(cmd) {
    const guardHeld = !!(cmd && cmd.back);
    this.crouching = !!(cmd && cmd.down) && !this.airborne;
    const canGuard = this.#canGuard();
    this.isBlocking = guardHeld && canGuard;
    this.guardHeight = (this.isBlocking && this.crouching) ? HEIGHT.LOW : HEIGHT.HIGH;
  }

  #canGuard() {
    switch (this.state) {
      case STATE.IDLE: case STATE.WALK: case STATE.CROUCH:
      case STATE.BLOCK_HIGH: case STATE.BLOCK_LOW: case STATE.BLOCKSTUN:
        return true;
      case STATE.SIDESTEP:
        return this.stateTicks > 10;
      case STATE.BACKDASH:
        return this.stateTicks > 12;
      default:
        return false;
    }
  }

  // --- state machine -------------------------------------------------------

  #updateState(cmd) {
    switch (this.state) {
      case STATE.KO:
        return;

      case STATE.VICTORY:
        if (this.animator?.finished) this.#play('v.pose', 8, true);
        return;

      case STATE.ATTACK:
        this.#tickAttack(cmd);
        return;

      case STATE.THROW:
        this.#tickThrow();
        return;

      case STATE.THROWN:
        this.#tickThrown(cmd);
        return;

      case STATE.BLOCKSTUN:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      case STATE.HITSTUN:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      case STATE.LAUNCHED:
      case STATE.JUGGLED:
        if (this.velocity.y < 0 && this.state === STATE.LAUNCHED) this.#enter(STATE.JUGGLED);
        return;

      case STATE.KNOCKDOWN:
        if (--this.stunTicks <= 0) {
          this.#enter(STATE.WAKEUP);
          this.stunTicks = 22;
          this.#play(this.rng.next() < 0.35 ? 'r.getUpRoll' : 'r.getUp', 4, false);
        }
        return;

      case STATE.WAKEUP:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      default:
        this.#tickNeutral(cmd);
    }
  }

  #tickNeutral(cmd) {
    // A move always wins over movement.
    const mv = this.#tryMove(false);
    if (mv) { this.#startMove(mv); return; }

    const timed = this.state === STATE.DASH || this.state === STATE.BACKDASH || this.state === STATE.SIDESTEP;
    if (timed) {
      if (--this.stunTicks <= 0) this.#toNeutral();
      return;
    }
    if (this.airborne) { this.#tickAir(cmd); return; }
    if (!cmd) { this.upHeldTicks = 0; this.#idle(); return; }

    // Tap up = sidestep, hold up = jump. Straight out of Tekken. A held-through
    // jump parks the counter at -1 so landing does not immediately re-launch.
    if (cmd.up) {
      if (this.upHeldTicks >= 0) {
        this.upHeldTicks++;
        if (this.upHeldTicks >= JUMP_HOLD_TICKS) { this.#jump(cmd); return; }
      }
      this.#idle();
      return;
    }
    if (this.upHeldTicks !== 0) {
      const held = this.upHeldTicks;
      this.upHeldTicks = 0;
      // Step toward the middle of the arena so a sidestep never buries the
      // fighter in the back wall.
      if (held > 0) { this.#sidestep(this.position.z > 0 ? -1 : 1); return; }
    }

    if (cmd.motion === 'ff' && this.#consumeMotion('ff')) { this.#dash(1); return; }
    if (cmd.motion === 'bb' && this.#consumeMotion('bb')) { this.#dash(-1); return; }

    if (this.isBlocking) {
      this.#enter(this.crouching ? STATE.BLOCK_LOW : STATE.BLOCK_HIGH);
      this.#play(this.crouching ? 'r.blockLow' : 'r.blockHigh', 4, true);
      this.velocity.x *= 0.6;
      return;
    }
    if (this.crouching) {
      this.#enter(STATE.CROUCH);
      if (cmd.fwd || cmd.back) {
        this.velocity.x = this.facing * (cmd.fwd ? CROUCH_WALK : -CROUCH_WALK);
        this.#play('loco.crouchWalk', 5, true);
      } else {
        this.velocity.x *= 0.5;
        this.#play('idle.crouch', 5, true);
      }
      return;
    }
    if (cmd.fwd || cmd.back) {
      this.#enter(STATE.WALK);
      this.velocity.x = this.facing * (cmd.fwd ? WALK_FWD : -WALK_BACK);
      this.#play(cmd.fwd ? 'loco.walkFwd' : 'loco.walkBack', 6, true);
      return;
    }
    this.#idle();
  }

  #idle() {
    this.#enter(STATE.IDLE);
    this.#play(this.health < MAX_HEALTH * 0.28 ? 'idle.lowHealth' : 'idle.fight', 7, true);
  }

  #tickAir(cmd) {
    const mv = this.#tryMove(false);
    if (mv) { this.#startMove(mv); return; }
    if (this.velocity.y > 0.4) this.#enter(STATE.JUMP_RISE);
    else if (this.velocity.y < -0.4) this.#enter(STATE.JUMP_FALL);
    else this.#enter(STATE.JUMP_APEX);
    this.#play('loco.jumpAir', 5, true);
    if (cmd && (cmd.fwd || cmd.back)) this.velocity.x += this.facing * (cmd.fwd ? 0.09 : -0.09);
  }

  #jump(cmd) {
    this.#enter(STATE.JUMP_RISE);
    this.airborne = true;
    this.grounded = false;
    this.velocity.y = JUMP_VY;
    if (cmd?.fwd) this.velocity.x = this.facing * 3.4;
    else if (cmd?.back) this.velocity.x = -this.facing * 3.0;
    this.upHeldTicks = -1;
    this.#play('loco.jumpStart', 3, false);
    bus.emit('jump', { fighter: this });
  }

  #sidestep(sign) {
    this.#enter(STATE.SIDESTEP);
    this.stunTicks = SIDESTEP_TICKS;
    const dir = sign >= 0 ? 1 : -1;
    this.velocity.z = dir * SIDESTEP_SPEED * this.facing;
    this.#play(dir > 0 ? 'loco.sidestepLeft' : 'loco.sidestepRight', 3, false);
    bus.emit('dash', { fighter: this, dir: 0 });
  }

  #dash(dir) {
    if (dir > 0) {
      this.#enter(STATE.DASH);
      this.stunTicks = DASH_TICKS;
      this.velocity.x = this.facing * DASH_SPEED;
      this.#play('loco.dashFwd', 3, false);
    } else {
      this.#enter(STATE.BACKDASH);
      this.stunTicks = BACKDASH_TICKS;
      this.velocity.x = -this.facing * BACKDASH_SPEED;
      this.throwInvuln = 10;
      this.#play('loco.dashBack', 3, false);
    }
    bus.emit('dash', { fighter: this, dir });
  }

  /** A recognised motion should only fire once; blank the buffer that made it. */
  #consumeMotion(kind) {
    if (this.lastMotion === kind && this.simTick - this.lastMotionTick < 18) return false;
    this.lastMotion = kind;
    this.lastMotionTick = this.simTick;
    return true;
  }

  // --- attacks -------------------------------------------------------------

  /**
   * @param {boolean} allowCancel true while an attack is running — only string
   *   continuations inside the current move's cancel window may come out.
   */
  #tryMove(allowCancel) {
    if (!this.cmd) return null;
    const st = {
      buffer: this.inputBuffer,
      tick: this.simTick,
      meter: this.meter,
      airborne: this.airborne,
      crouching: this.crouching,
      stance: this.stance || null,
      currentMove: allowCancel ? this.currentMove : null,
      moveTick: this.moveTick,
      canCancel: allowCancel,
      allowRoot: !allowCancel,
    };
    return findMove(this.moveSetKey, this.cmd, st);
  }

  /** Begin a move. Public so the CPU and the QA harness can drive fighters. */
  startMove(move) { if (move) this.#startMove(move); }

  /**
   * Scrub the current move forward, keeping the animation in lockstep with the
   * frame counter. Jumping `moveTick` on its own would build hitboxes from a
   * wind-up pose, which is exactly the kind of desync that makes a capture look
   * wrong; this keeps the two clocks together.
   * @param {number} ticks
   */
  fastForward(ticks) {
    const mv = this.currentMove;
    if (!mv) return;
    const n = Math.max(0, Math.min(Math.round(ticks), mv.total - this.moveTick - 1));
    if (n === 0) return;
    this.moveTick += n;
    if (this.animator) {
      for (let i = 0; i < n; i++) {
        this.animator.simulate();
        // Take the root motion the skipped frames would have produced, so the
        // fighter ends up where the animation actually put it.
        if (this.animator.consumeRootMotion) {
          const rm = this.animator.consumeRootMotion();
          _v.set(rm.x * ROOT_MOTION_SCALE, 0, rm.z * ROOT_MOTION_SCALE).applyAxisAngle(UP, yawForFacing(this.facing));
          this.position.x += _v.x;
          this.position.z += _v.z;
        }
      }
      this.animator.applyTo(this.bones, 1);
    }
    this.prevPosition.copy(this.position);
    this.#writePose();
    this.#buildHurtboxes();
    this.#buildHitboxes();
  }

  #startMove(move) {
    if (move.meterCost > 0) {
      if (this.meter < move.meterCost) return;
      this.meter -= move.meterCost;
    }
    this.#enter(STATE.ATTACK);
    this.currentMove = move;
    this.moveTick = 0;
    this.moveInstance++;
    this.connected.clear();
    this.hitConnectedThisMove = false;
    this.isBlocking = false;
    // Fresh sweep history: the bones this move strikes with, tracked from tick 0.
    this.moveBones = [...new Set(move.active.flatMap((w) => w.boxes.map((b) => b.bone)))];
    for (const n of this.moveBones) if (this.boneTrack[n]) this.boneTrack[n].valid = false;
    this.velocity.x *= 0.4;
    this.velocity.z *= 0.3;
    this.#play(move.clip, move.startup > 16 ? 4 : 2, false);

    if (move.props.super) {
      bus.emit('superStart', { fighter: this, move });
      const cin = move.props.cinematic;
      if (cin) {
        bus.emit('timeScale', { scale: cin.slow ?? 0.4, ticks: cin.slowTicks ?? 24 });
        bus.emit('shake', { amount: 0.35, ticks: 18 });
      }
    }
  }

  #tickAttack(cmd) {
    const mv = this.currentMove;
    if (!mv) { this.#toNeutral(); return; }
    this.moveTick++;

    // Cancels and string continuations.
    const nxt = this.#tryMove(true);
    if (nxt && nxt !== mv) { this.#startMove(nxt); return; }

    // A move that leaves the ground.
    const air = mv.props.airborne;
    if (air && this.moveTick === air[0] && !this.airborne) {
      this.airborne = true;
      this.grounded = false;
      this.velocity.y = mv.props.hopVelocity ?? 4.6;
    }

    // The move whiffed: every active window has passed with nothing connected.
    const last = mv.active[mv.active.length - 1].to;
    if (this.moveTick === last + 1 && !this.hitConnectedThisMove) {
      if (mv.props.throw) this.#play('t.grabWhiff', 2, false);
      bus.emit('whiff', { fighter: this, move: mv });
    }

    if (this.moveTick >= mv.total) {
      this.currentMove = null;
      this.hitboxes.length = 0;
      this.#toNeutral();
    }
  }

  #applyMoveMotion() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return;
    const travel = mv.props.travel;
    if (!travel) return;
    for (const t of travel) {
      if (this.moveTick >= t.from && this.moveTick <= t.to) {
        this.velocity.x = this.facing * (t.x || 0);
        if (t.z) this.velocity.z = t.z * this.facing;
      }
    }
  }

  // --- throws --------------------------------------------------------------

  /**
   * Lock this fighter and `victim` into a throw animation.
   * @param {Object} move   the throw move
   * @param {Fighter} victim
   * @param {?{breakWindow:[number,number], damageScale:number}} override
   *        situational tuning — a throw landed from behind is harder to break
   */
  beginThrow(move, victim, override = null) {
    const t = move.props.throw;
    this.#enter(STATE.THROW);
    this.currentMove = move;
    this.moveTick = 0;
    this.throwPartner = victim;
    this.throwData = {
      move, t, ticks: 0, duration: t.duration, broken: false,
      breakWindow: override?.breakWindow || t.breakWindow,
      damageScale: override?.damageScale ?? 1,
    };
    this.velocity.set(0, 0, 0);
    this.#play(t.clip, 3, false);
    victim.beThrown(move, this, override);
  }

  /** Victim side of a throw. */
  beThrown(move, attacker, override = null) {
    const t = move.props.throw;
    this.#enter(STATE.THROWN);
    this.currentMove = null;
    this.throwPartner = attacker;
    this.throwData = {
      move, t, ticks: 0, duration: t.duration, broken: false,
      breakWindow: override?.breakWindow || t.breakWindow,
      damageScale: override?.damageScale ?? 1,
    };
    this.velocity.set(0, 0, 0);
    this.stunTicks = t.duration;
    this.#play(t.victimClip || 't.beingGrabbed', 3, false);
    // Face the thrower; a back throw deliberately leaves the victim turned away.
    if (t.type !== 'back') this.facing = -attacker.facing;
  }

  #tickThrow() {
    const d = this.throwData;
    if (!d) { this.#toNeutral(); return; }
    d.ticks++;
    const v = this.throwPartner;
    // Drag the victim along until the release frame.
    if (v && !d.broken && d.ticks < d.duration * 0.62) {
      v.position.x = this.position.x + this.facing * (this.radius + v.radius) * 0.86;
      v.position.z = this.position.z;
      v.prevPosition.copy(v.position);
      v.velocity.set(0, 0, 0);
    }
    if (v && !d.broken && d.ticks === Math.round(d.duration * 0.62)) {
      this.#releaseThrow(v, d);
    }
    if (d.ticks >= d.duration) {
      this.throwData = null;
      this.throwPartner = null;
      this.currentMove = null;
      this.#toNeutral();
    }
  }

  #releaseThrow(victim, d) {
    const mv = d.move;
    const kb = mv.knockback || [4, 2, 0];
    const dir = d.t.type === 'back' ? -this.facing : this.facing;
    const point = victim.position.clone().setY(victim.position.y + 0.95);
    const dmg = victim.applyHit(mv, this, point, {
      damage: mv.damage * (d.damageScale ?? 1), hitStun: 0, counter: false, reaction: REACTION.KNOCKDOWN,
      knockback: [Math.abs(kb[0]), kb[1], kb[2]], knockbackDir: dir,
      throwRelease: true,
    });
    this.addMeter(dmg * METER_ON_DEAL);
    bus.emit('hit', {
      attacker: this, defender: victim, move: mv, point, normal: _v2.set(dir, 0.3, 0).normalize().clone(),
      damage: dmg, counter: false, region: 'torso', comboCount: 1,
    });
    bus.emit('hitstop', { ticks: 12 });
    bus.emit('shake', { amount: 0.5, ticks: 14 });
  }

  #tickThrown(cmd) {
    const d = this.throwData;
    if (!d) { this.#toNeutral(); return; }
    d.ticks++;
    // Break window: the correct buttons within the first few frames escape.
    if (!d.broken && d.ticks >= d.breakWindow[0] && d.ticks <= d.breakWindow[1] && cmd?.pressed?.size) {
      for (const b of d.t.breakButtons) {
        if (cmd.pressed.has(b)) { this.#breakThrow(); return; }
      }
    }
    if (--this.stunTicks <= 0) {
      this.throwData = null;
      this.throwPartner = null;
      this.#toKnockdown(38, 'r.knockdownBack');
    }
  }

  #breakThrow() {
    const a = this.throwPartner;
    const d = this.throwData;
    if (d) d.broken = true;
    const point = _v.copy(this.position).setY(this.position.y + 1.1).clone();
    this.throwData = null;
    this.throwPartner = null;
    this.stunTicks = 0;
    this.#enter(STATE.BLOCKSTUN);
    this.stunTicks = 16;
    this.velocity.x = -this.facing * 3.0;
    this.#play('t.throwBreak', 3, false);
    if (a) {
      a.throwData = null;
      a.throwPartner = null;
      a.currentMove = null;
      a.state = STATE.BLOCKSTUN;
      a.stateTicks = 0;
      a.stunTicks = 16;
      a.velocity.x = -a.facing * 3.0;
      a.playClip('t.throwBreak', 3, false);
      // The pair were locked together for the grab; part them cleanly so the
      // push-out does not have to resolve a perfect overlap.
      const sep = this.radius + a.radius;
      const dir = Math.sign(this.position.x - a.position.x) ||
        -Math.sign(a.position.x) || -a.facing;
      this.position.x = a.position.x + dir * sep;
      this.position.z = a.position.z;
      this.prevPosition.copy(this.position);
    }
    // 'throwBreak' is the precise event; 'parry' fires too so the FX and audio
    // layers, which only know the canonical list, still get their flash.
    bus.emit('throwBreak', { attacker: a, defender: this, point });
    bus.emit('parry', { attacker: a, defender: this, point });
    bus.emit('hitstop', { ticks: 8 });
    bus.emit('shake', { amount: 0.22, ticks: 10 });
  }

  // --- damage --------------------------------------------------------------

  /**
   * Apply a landed hit. Called by CombatSystem, which owns scaling and events.
   * @param {Object} move
   * @param {Fighter} attacker
   * @param {THREE.Vector3} point
   * @param {Object} [info] { damage, hitStun, counter, reaction, knockback,
   *                          juggleHeight, launch, wallSplat, groundBounce }
   * @returns {number} damage actually applied
   */
  applyHit(move, attacker, point, info = {}) {
    const raw = info.damage ?? move.damage;
    const dmg = Math.max(1, raw * this.#defenseScale());
    this.health = Math.max(0, this.health - dmg);
    this.recoverable = Math.min(this.recoverable + dmg * RECOVERABLE_RATIO, MAX_HEALTH - this.health);
    this.lastDamageTick = this.simTick;
    this.addMeter(dmg * METER_ON_TAKE);
    this.#checkDamageThresholds(point);

    if (this.health <= 0) { this.#toKO(move, attacker); return dmg; }

    const reaction = info.reaction || move.reaction;
    const kb = info.knockback || move.knockback || [2, 0, 0];
    const dirX = info.knockbackDir ?? attacker.facing;
    const weightScale = 10 / (5 + (this.stats.weight ?? 5));

    this.currentMove = null;
    this.hitboxes.length = 0;
    this.isBlocking = false;
    this.throwData = null;
    this.throwPartner = null;

    const launching = info.launch || reaction === REACTION.LAUNCH;
    const wasAirborne = this.airborne;
    if (launching || wasAirborne) {
      const h = (info.juggleHeight ?? move.juggleHeight ?? 4.2) * (info.juggleScale ?? 1) * weightScale * LAUNCH_SCALE;
      // A fresh launch sets the arc; an airborne hit only tops it up, which is
      // what keeps juggles from floating forever.
      if (!wasAirborne) this.velocity.y = h;
      else this.velocity.y = Math.max(this.velocity.y, -1.5) + h * 0.5;
      this.airborne = true;
      this.grounded = false;
      this.velocity.x = dirX * kb[0] * 0.55 * weightScale;
      this.velocity.z *= 0.4;
      this.juggleCount++;
      this.bounceRemaining = info.groundBounce ? 1 : (move.props.groundBounce ? 1 : 0);
      this.bounceFactor = info.groundBounce || move.props.groundBounce || 0;
      this.#enter(launching && !wasAirborne ? STATE.LAUNCHED : STATE.JUGGLED);
      this.stunTicks = 0;
      this.#play(launching && !wasAirborne ? 'r.launch' : (reaction === REACTION.SPIN ? 'r.spinFall' : 'r.airFlail'), 3, false);
      if (launching && !wasAirborne) bus.emit('launch', { fighter: this, velocity: this.velocity.clone() });
      return dmg;
    }

    if (info.throwRelease) {
      this.airborne = true;
      this.grounded = false;
      this.velocity.set(dirX * Math.abs(kb[0]) * weightScale, Math.abs(kb[1]) * weightScale + 2.4, 0);
      this.bounceRemaining = 0;
      this.#enter(STATE.JUGGLED);
      this.#play('r.spinFall', 3, false);
      return dmg;
    }

    this.velocity.x = dirX * kb[0] * 0.5 * weightScale;
    if (kb[1] > 0.01) { this.velocity.y = kb[1] * weightScale; this.airborne = true; this.grounded = false; }

    switch (reaction) {
      case REACTION.KNOCKDOWN:
        this.#toKnockdown(40, 'r.knockdownBack');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.SWEEP:
        this.#toKnockdown(36, 'r.sweepFall');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.SPIN:
        this.#toKnockdown(44, 'r.spinFall');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.CRUMPLE:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.velocity.x *= 0.3;
        this.#play('r.crumple', 3, false);
        break;
      case REACTION.STAGGER:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.#play('r.stagger', 3, false);
        break;
      case REACTION.WALL_SPLAT:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.#play('r.wallSplat', 2, false);
        break;
      default: {
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        const clip = reaction === REACTION.FLINCH_LOW ? 'r.flinchLow'
          : reaction === REACTION.FLINCH_HIGH ? 'r.flinchHigh' : 'r.flinchMid';
        this.#play(clip, 3, false);
      }
    }
    return dmg;
  }

  /**
   * Apply a blocked hit: chip damage, blockstun, pushback.
   * @returns {number} chip damage applied
   */
  applyBlock(move, attacker, point, info = {}) {
    const chip = (info.damage ?? move.damage) * CHIP_DAMAGE_RATIO * this.#defenseScale();
    this.health = Math.max(1, this.health - chip);
    this.recoverable = Math.min(this.recoverable + chip, MAX_HEALTH - this.health);
    this.addMeter((info.damage ?? move.damage) * METER_ON_BLOCK);
    const push = move.blockPush || [2, 0, 0];
    this.velocity.x = attacker.facing * push[0] * 0.6;
    this.currentMove = null;
    this.hitboxes.length = 0;
    this.#enter(STATE.BLOCKSTUN);
    this.stunTicks = info.blockStun ?? move.blockStun;
    this.#play('r.blockImpact', 2, false);
    return chip;
  }

  /** Armour: eat the hit, keep going, pay reduced damage. */
  absorbArmor(move, attacker, point) {
    const scale = this.currentMove?.props?.armorScale ?? 0.5;
    const dmg = (move.damage * scale) * this.#defenseScale();
    this.health = Math.max(1, this.health - dmg);
    this.recoverable = Math.min(this.recoverable + dmg * RECOVERABLE_RATIO, MAX_HEALTH - this.health);
    this.addMeter(dmg * METER_ON_TAKE * 1.4);
    this.lastDamageTick = this.simTick;
    bus.emit('armorAbsorb', { fighter: this, move, point: point.clone() });
    return dmg;
  }

  /** Successful parry: skip straight to the riposte frames of the stance move. */
  parrySuccess(move, attacker, point) {
    const mv = this.currentMove;
    if (!mv) return;
    const riposte = mv.props.parryRiposte ?? mv.startup;
    this.moveTick = Math.max(0, riposte - 1);
    this.connected.clear();
    this.addMeter(14);
    this.#play(mv.props.parryClip || 'sp.parrySuccess', 2, false);
    bus.emit('parry', { attacker, defender: this, point: point.clone() });
  }

  /** Can this fighter parry an incoming attack of `move`'s height right now? */
  canParryMove(move) {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return false;
    const p = mv.props;
    if (p.parryFrom == null) return false;
    if (this.moveTick < p.parryFrom || this.moveTick > p.parryTo) return false;
    if (move.height === HEIGHT.UNBLOCKABLE) return false;
    const heights = p.parryHeights || ['high', 'mid'];
    return heights.includes(move.height);
  }

  /** Is armour live this tick? */
  armorActive() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return false;
    const p = mv.props;
    return p.armorFrom != null && this.moveTick >= p.armorFrom && this.moveTick <= p.armorTo;
  }

  #defenseScale() {
    const d = this.stats.defense ?? 5;
    return THREE.MathUtils.clamp(1 - (d - 5) * 0.028, 0.7, 1.35);
  }

  #toKnockdown(ticks, clip) {
    this.#enter(STATE.KNOCKDOWN);
    this.stunTicks = ticks;
    this.juggleCount = 0;
    this.#play(clip, 3, false);
  }

  #toKO(move, attacker) {
    this.#enter(STATE.KO);
    this.currentMove = null;
    this.hitboxes.length = 0;
    this.airborne = true;
    this.grounded = false;
    this.velocity.set(attacker.facing * 4.6, 5.2, 0);
    this.stunTicks = 0;
    this.#play('r.koFall', 2, false);
    this.koTick = this.simTick;
  }

  #toNeutral() {
    this.stunTicks = 0;
    this.reaction = null;
    this.juggleCount = 0;
    this.bounceRemaining = 0;
    if (this.airborne) { this.#enter(STATE.JUMP_FALL); return; }
    this.#enter(this.crouching ? STATE.CROUCH : STATE.IDLE);
  }

  #enter(s) {
    if (this.state !== s) { this.state = s; this.stateTicks = 0; }
  }

  // --- meter / regen -------------------------------------------------------

  addMeter(n) {
    const before = this.meter;
    this.meter = Math.min(METER_MAX, this.meter + n);
    if (before < METER_MAX && this.meter >= METER_MAX) bus.emit('meterFull', { fighter: this });
  }

  spendMeter(n) {
    if (this.meter < n) return false;
    this.meter -= n;
    return true;
  }

  #regen() {
    if (this.recoverable <= 0) return;
    if (this.simTick - this.lastDamageTick < 60) return;
    if (this.state === STATE.HITSTUN || this.state === STATE.LAUNCHED ||
        this.state === STATE.JUGGLED || this.state === STATE.KNOCKDOWN) return;
    const step = Math.min(RECOVERY_PER_TICK, this.recoverable);
    this.recoverable -= step;
    this.health = Math.min(MAX_HEALTH, this.health + step);
  }

  #checkDamageThresholds(point) {
    const r = this.health / MAX_HEALTH;
    const levels = [
      { at: 0.62, level: 1, part: 'shoulderPlate' },
      { at: 0.34, level: 2, part: 'chestVent' },
      { at: 0.14, level: 3, part: 'headCowl' },
    ];
    for (const l of levels) {
      if (r <= l.at && !this.brokenParts.has(l.part)) {
        this.brokenParts.add(l.part);
        this.damageLevel = l.level;
        bus.emit('partBreak', { fighter: this, part: l.part, point: point.clone() });
      }
    }
  }

  // --- physics -------------------------------------------------------------

  #integrate() {
    const dt = TICK_DT;
    const juggling = this.state === STATE.LAUNCHED || this.state === STATE.JUGGLED;
    this.gravityScale = juggling ? JUGGLE_GRAVITY : 1;
    if (this.airborne) {
      this.velocity.y += GRAVITY * dt * this.gravityScale;
      this.velocity.x *= AIR_DRAG;
      this.velocity.z *= AIR_DRAG;
    } else {
      const stunned = this.state === STATE.HITSTUN || this.state === STATE.BLOCKSTUN ||
        this.state === STATE.KNOCKDOWN || this.state === STATE.WAKEUP;
      const f = stunned ? SLIDE_FRICTION : GROUND_FRICTION;
      this.velocity.x *= f;
      this.velocity.z *= f;
      if (Math.abs(this.velocity.x) < 0.02) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.02) this.velocity.z = 0;
      this.velocity.y = 0;
    }

    this.position.addScaledVector(this.velocity, dt);

    if (this.position.y <= this.floorY) {
      const impactSpeed = -this.velocity.y;
      this.position.y = this.floorY;
      if (this.airborne) this.#land(impactSpeed);
      this.airborne = false;
      this.grounded = true;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.airborne = true;
      this.grounded = false;
    }
  }

  #land(speed) {
    const juggled = this.state === STATE.LAUNCHED || this.state === STATE.JUGGLED;
    bus.emit('groundImpact', { fighter: this, point: this.position.clone(), speed: Math.max(0, speed) });

    if (juggled && this.bounceRemaining > 0 && speed > 3.0) {
      this.bounceRemaining--;
      this.velocity.y = speed * THREE.MathUtils.clamp(this.bounceFactor, 0.25, 0.9);
      this.velocity.x *= 0.6;
      this.position.y = this.floorY + 0.01;
      this.airborne = true;
      this.grounded = false;
      this.#play('r.groundBounce', 2, false);
      return;
    }
    if (this.state === STATE.KO) {
      this.#play('r.koSlump', 4, false);
      this.velocity.x *= 0.3;
      return;
    }
    if (juggled) {
      this.#toKnockdown(44, speed > 7 ? 'r.knockdownFace' : 'r.knockdownBack');
      bus.emit('knockdown', { fighter: this, point: this.position.clone() });
      return;
    }
    if (this.state === STATE.JUMP_RISE || this.state === STATE.JUMP_APEX || this.state === STATE.JUMP_FALL) {
      this.#enter(STATE.IDLE);
      this.#play('loco.jumpLand', 2, false);
      this.velocity.x *= 0.35;
    }
  }

  /** Capsule push-out against the opponent; each side moves half the overlap. */
  #pushApart() {
    const o = this.opponent;
    if (!o || o.state === STATE.KO) return;
    if (this.state === STATE.THROW || this.state === STATE.THROWN) return;
    if (o.state === STATE.THROW || o.state === STATE.THROWN) return;
    let dx = this.position.x - o.position.x;
    let dz = this.position.z - o.position.z;
    const minD = this.radius + o.radius;
    let d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) return;
    if (d2 < 1e-6) { dx = -this.facing * 0.01; dz = 0; d2 = dx * dx; }
    const d = Math.sqrt(d2);
    const push = (minD - d) * 0.5;
    this.position.x += (dx / d) * push;
    this.position.z += (dz / d) * push;
  }

  /** Walls and floor. Records the wall impact so CombatSystem can splat. */
  #clampToArena() {
    const limX = this.bounds.halfWidth - this.radius;
    const limZ = this.bounds.halfDepth - this.radius;
    if (this.position.x > limX) {
      if (this.velocity.x > 0) this.wallImpact = { speed: this.velocity.x, normal: -1, axis: 'x' };
      this.position.x = limX;
      this.velocity.x = Math.min(this.velocity.x, 0);
    } else if (this.position.x < -limX) {
      if (this.velocity.x < 0) this.wallImpact = { speed: -this.velocity.x, normal: 1, axis: 'x' };
      this.position.x = -limX;
      this.velocity.x = Math.max(this.velocity.x, 0);
    }
    if (this.position.z > limZ) { this.position.z = limZ; this.velocity.z = Math.min(this.velocity.z, 0); }
    else if (this.position.z < -limZ) { this.position.z = -limZ; this.velocity.z = Math.max(this.velocity.z, 0); }
  }

  #updateFlags() {
    if (this.throwInvuln > 0) this.throwInvuln--;
    const mv = this.currentMove;
    this.invulnerable = !!(mv && this.state === STATE.ATTACK && isInvulnerable(mv, this.moveTick));
  }

  // -------------------------------------------------------------------------
  // Pose, hurtboxes, hitboxes
  // -------------------------------------------------------------------------

  /**
   * Advance the animation one tick and fold its root motion into the physical
   * position. The Animator extracts horizontal root translation rather than
   * baking it into the bones (see its header) precisely so the body follows the
   * animation instead of sliding under it — a lunging jab has to actually close
   * the distance it appears to close, or the hitbox arrives somewhere the
   * fighter is not.
   */
  #advanceAnimation() {
    if (!this.animator) return;
    this.animator.simulate(this.simTick);
    if (!this.animator.consumeRootMotion) return;
    const rm = this.animator.consumeRootMotion();
    if (this.state === STATE.THROW || this.state === STATE.THROWN || this.state === STATE.KO) return;
    if (!rm.x && !rm.z) return;
    _v.set(rm.x * ROOT_MOTION_SCALE, 0, rm.z * ROOT_MOTION_SCALE)
      .applyAxisAngle(UP, yawForFacing(this.facing));
    this.position.x += _v.x;
    this.position.z += _v.z;
  }

  /** Write the simulated transform and the canonical pose onto the scene graph. */
  #writePose() {
    this.group.position.copy(this.position);
    this.group.rotation.y = yawForFacing(this.facing);
    if (this.animator) this.animator.applyTo(this.bones, 1);
    this.group.updateMatrixWorld(true);
  }

  /** Pose without advancing time — used on reset and during the intro. */
  #drivePose() {
    if (this.animator) {
      this.animator.simulate(this.simTick);
      this.animator.clearRootMotion?.();
    }
    this.#writePose();
  }

  #buildHurtboxes() {
    for (let i = 0; i < this.hurtDefs.length; i++) {
      const d = this.hurtDefs[i];
      const bone = this.boneByName[d.name];
      const hb = this.hurtboxes[i];
      if (!bone) continue;
      hb.p0.setFromMatrixPosition(bone.matrixWorld);
      if (d.length > 0) hb.p1.set(0, -d.length, 0).applyMatrix4(bone.matrixWorld);
      else hb.p1.copy(hb.p0);
      hb.radius = d.radius;
    }
  }

  /**
   * Record where every bone this move strikes with was last tick. A fist can
   * travel 30cm in a single frame — more than its own radius — so without a
   * swept test it will tunnel clean through a defender and whiff a punch that
   * visibly connected. Tracking runs on every tick of the move, not just the
   * active ones, so the *first* active frame sweeps correctly too.
   */
  #trackMoveBones() {
    if (!this.moveBones) return;
    for (const name of this.moveBones) {
      const bone = this.boneByName[name];
      if (!bone) continue;
      let rec = this.boneTrack[name];
      if (!rec) rec = this.boneTrack[name] = { prev: new THREE.Vector3(), cur: new THREE.Vector3(), valid: false };
      rec.prev.copy(rec.cur);
      rec.cur.setFromMatrixPosition(bone.matrixWorld);
      if (!rec.valid) { rec.prev.copy(rec.cur); rec.valid = true; }
    }
  }

  #buildHitboxes() {
    this.hitboxes.length = 0;
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return;
    this.#trackMoveBones();
    if (!isActive(mv, this.moveTick)) return;
    const boxes = activeBoxes(mv, this.moveTick);
    if (!boxes) return;
    const windowIndex = mv.active.findIndex((w) => this.moveTick >= w.from && this.moveTick <= w.to);
    const bonus = mv.props.homing ? 0.09 : 0;
    const lead = this.facing;

    for (let i = 0; i < boxes.length && i < this.hitboxPool.length; i++) {
      const b = boxes[i];
      const bone = this.boneByName[b.bone];
      if (!bone) continue;
      const hb = this.hitboxPool[i];

      // Anchor and far tip in world space.
      _v.set(b.offset[0], b.offset[1], b.offset[2]).applyMatrix4(bone.matrixWorld);
      if (b.length > 0) _v2.set(b.offset[0], b.offset[1] - b.length, b.offset[2]).applyMatrix4(bone.matrixWorld);
      else _v2.copy(_v);
      // The authored forward lead is in fighter space, not bone space, so a
      // strike reaches where the player expects regardless of limb orientation.
      if (b.fwd) { _v.x += lead * b.fwd; _v2.x += lead * b.fwd; }
      hb.tip.copy(_v2);

      // Sweep the capsule back to where the anchor was last tick.
      const rec = this.boneTrack[b.bone];
      if (rec && rec.valid) _v3.copy(_v).sub(rec.cur).add(rec.prev);
      else _v3.copy(_v);
      hb.p0.copy(_v3);
      hb.p1.copy(_v2);

      hb.radius = b.radius + bonus;
      hb.bone = b.bone;
      hb.windowIndex = windowIndex;
      hb.move = mv;
      this.hitboxes.push(hb);
    }
  }

  /** True once per move-instance/window pair, so multi-hits count once each. */
  registerConnect(windowIndex) {
    const key = `${this.moveInstance}:${windowIndex}`;
    if (this.connected.has(key)) return false;
    this.connected.add(key);
    this.hitConnectedThisMove = true;
    return true;
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  #footIk() {
    if (!this.animator?.setIkTarget) return;
    const plant = !this.airborne && this.state !== STATE.KNOCKDOWN && this.state !== STATE.KO;
    for (const side of ['L', 'R']) {
      const chain = side === 'L' ? 'legL' : 'legR';
      if (!IK_CHAINS[chain]) continue;
      const bone = this.boneByName[`ankle_${side}`];
      if (!bone) continue;
      _v.setFromMatrixPosition(bone.matrixWorld);
      const minY = this.floorY + FOOT_CLEAR;
      if (plant && _v.y < minY) {
        _v.y = minY;
        this.animator.setIkTarget(chain, _v, 1);
      } else if (plant && _v.y < minY + 0.09) {
        const w = 1 - (_v.y - minY) / 0.09;
        _v.y = minY;
        this.animator.setIkTarget(chain, _v, w);
      } else {
        this.animator.setIkTarget(chain, null, 0);
      }
    }
  }

  #trackFootfalls() {
    if (this.airborne) return;
    for (const side of ['L', 'R']) {
      const bone = this.boneByName[`foot_${side}`];
      if (!bone) continue;
      _v.setFromMatrixPosition(bone.matrixWorld);
      const s = this.footState[side];
      const h = _v.y - this.floorY;
      const dv = h - s.y;
      if (!s.down && h < 0.11 && dv < -0.004) {
        s.down = true;
        bus.emit('footstep', {
          fighter: this, foot: side, point: _v.clone(),
          force: THREE.MathUtils.clamp(-dv * 55 + Math.abs(this.velocity.x) * 0.09, 0.2, 1.6),
        });
      } else if (s.down && h > 0.17) {
        s.down = false;
      }
      s.y = h;
    }
  }

  /**
   * Cosmetic-only frame update.
   * @param {number} alpha interpolation between the previous and current tick
   * @param {number} dt    real seconds since the last frame
   */
  render(alpha, dt) {
    if (!this.ready) return;
    _v.lerpVectors(this.prevPosition, this.position, alpha);
    this.group.position.copy(_v);

    const targetYaw = yawForFacing(this.facing);
    let delta = targetYaw - this.visualYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.visualYaw += delta * Math.min(1, dt * 14);
    this.group.rotation.y = this.visualYaw;

    if (this.animator) this.animator.applyTo(this.bones, alpha);
    this.group.updateMatrixWorld(true);

    this.#updateActuators();
    this.#updateEmissive(dt);
  }

  /**
   * Pistons: every actuator part spans two bones, so its length and orientation
   * fall straight out of the posed skeleton. Without this the joints read as
   * stiff plastic; with it the robot looks driven.
   */
  #updateActuators() {
    for (const act of this.actuators) {
      _v.setFromMatrixPosition(act.a.matrixWorld);
      _v2.setFromMatrixPosition(act.b.matrixWorld);
      const len = _v.distanceTo(_v2);
      if (act.restLen === 0) { act.restLen = Math.max(1e-3, len); continue; }
      const parent = act.obj.parent;
      if (!parent) continue;
      _m.copy(parent.matrixWorld).invert();
      _v3.copy(_v).add(_v2).multiplyScalar(0.5).applyMatrix4(_m);
      act.obj.position.copy(_v3);
      // Direction in the parent's space, then align the part's +Y to it.
      _v4.copy(_v2).sub(_v).normalize().transformDirection(_m);
      _q.setFromUnitVectors(UP, _v4);
      act.obj.quaternion.copy(_q);
      act.obj.scale.y = act.baseScale * THREE.MathUtils.clamp(len / act.restLen, 0.55, 1.9);
    }
  }

  /**
   * The robot has to read as *powered*: reactor glow tracks meter, the pulse
   * rate climbs as health falls, a full gauge strobes, and a fresh hit flashes
   * the vents. This is the cheapest thing in the renderer and one of the most
   * legible.
   */
  #updateEmissive(dt) {
    this.pulsePhase = (this.pulsePhase ?? 0) + dt * 3.2;
    const healthRatio = this.health / MAX_HEALTH;
    const meterRatio = this.meter / METER_MAX;
    const hurt = 1 - healthRatio;
    const beat = 0.5 + 0.5 * Math.sin(this.pulsePhase * (1 + hurt * 1.6));
    const full = this.meter >= METER_MAX ? 0.9 + 0.5 * Math.sin(this.pulsePhase * 4) : 0;
    const hitFlash = Math.max(0, 1 - (this.simTick - this.lastDamageTick) / 8);
    const pulse = beat * (0.12 + meterRatio * 0.5) + full + hitFlash * 2.2;

    if (this.robotUpdate) {
      this.robotUpdate(dt, {
        health: healthRatio, meter: meterRatio, pulse, flash: hitFlash,
        damageLevel: this.damageLevel, state: this.state,
      });
      return;
    }
    const gain = 1 + meterRatio * 1.1 + pulse;
    for (const rec of this.emissiveMats) rec.mat.emissiveIntensity = rec.base * gain;
  }

  /** Public clip driver, used by the harness, intros and paired animations. */
  playClip(id, blend = 4, loop = false) { this.#play(id, blend, loop); }

  /**
   * Play a clip, skipping the call when a looping clip is already running so a
   * held walk does not restart every tick. An unknown id falls back to the
   * fight stance rather than throwing — one missing animation must never be
   * able to take the whole match down.
   */
  #play(id, blend = 4, loop = false) {
    if (!this.animator || !id) return;
    let clipId = id;
    if (!CLIPS[clipId]) {
      if (!Fighter.missingClips.has(clipId)) {
        Fighter.missingClips.add(clipId);
        console.warn(`[Fighter] missing clip "${clipId}", falling back to idle.fight`);
      }
      clipId = 'idle.fight';
      if (!CLIPS[clipId]) return;
    }
    if (loop && this.currentClip === clipId) return;
    this.currentClip = clipId;
    this.animator.play(clipId, { blend, loop });
  }

  /** Round bookends. */
  celebrate() {
    this.#enter(STATE.VICTORY);
    this.velocity.set(0, 0, 0);
    this.#play(this.rng.next() < 0.5 ? 'v.pose' : 'v.saluteCharge', 8, false);
  }

  dispose() {
    if (this.robot?.dispose) this.robot.dispose();
    this.scene.remove(this.group);
  }
}
