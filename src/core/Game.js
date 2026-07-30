/**
 * Knockbots — the game shell.
 *
 * Owns the fixed-timestep loop, the scene graph, the match state machine, and
 * the wiring between simulation and presentation. Every subsystem is
 * constructed here and nowhere else.
 *
 * Loop shape:
 *   accumulate real dt -> run N fixed 60Hz sim ticks -> render once with an
 *   interpolation alpha. Hitstop and slow-motion are applied by scaling how
 *   much time enters the accumulator, so the sim itself always sees a clean
 *   16.667ms tick and stays deterministic.
 */

import * as THREE from 'three';
import { TICK_DT, MAX_TICKS_PER_FRAME, ROUNDS_TO_WIN, ROUND_TIME_SECONDS, TICK_HZ, MAX_HEALTH } from './Constants.js';

/** Health restored per tick in training, once a fighter is out of hitstun. */
const TRAINING_REFILL = 1.4;
import { bus } from './Bus.js';
import { Input } from './Input.js';
import { RenderPipeline } from '../engine/RenderPipeline.js';
import { Environment } from '../engine/Environment.js';
import { Stage } from '../arena/Stage.js';
import { Fighter } from '../combat/Fighter.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { FightCamera } from '../engine/FightCamera.js';
import { EffectsDirector } from '../fx/EffectsDirector.js';
import { HUD } from '../ui/HUD.js';
import { MenuSystem } from '../ui/MenuSystem.js';
import { AudioDirector } from '../audio/AudioDirector.js';
import { CPU } from '../ai/CPU.js';
import { ROSTER } from '../characters/roster.js';
import { makeTestHarness } from '../combat/TestHarness.js';
import { TouchControls } from './TouchControls.js';

export const PHASE = {
  BOOT: 'boot',
  MENU: 'menu',
  SELECT: 'select',
  INTRO: 'intro',
  READY: 'ready',
  FIGHT: 'fight',
  KO: 'ko',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
  REPLAY: 'replay',
};

export class Game {
  constructor(container, uiRoot, onProgress = () => {}) {
    this.container = container;
    this.uiRoot = uiRoot;
    this.onProgress = onProgress;

    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.tick = 0;
    this.phase = PHASE.BOOT;
    this.phaseTicks = 0;

    this.timeScale = 1;
    this.hitstopTicks = 0;
    /** Real time banked toward the next hitstop tick. See #frame. */
    this.hitstopAccum = 0;
    this.slowmo = { scale: 1, ticks: 0 };

    this.round = 1;
    this.wins = [0, 0];
    this.roundTimer = ROUND_TIME_SECONDS * TICK_HZ;

    this.paused = false;
    this.debug = { hitboxes: false, stats: false, freecam: false };

    /**
     * Difficulty, 1..10, applied to the CPU's reaction delay, block rate,
     * punish accuracy and combo length. 6 is the default arcade opponent.
     */
    this.difficulty = 6;

    /**
     * Training mode. The opponent stands still so movement and move properties
     * can be learned without being interrupted, the round never times out, and
     * both fighters are topped up rather than being allowed to die — a practice
     * session that ends in a KO is a practice session that keeps interrupting
     * itself.
     */
    this.training = false;
  }

  async init() {
    const step = async (label, pct, fn) => {
      this.onProgress(label, pct);
      await new Promise((r) => requestAnimationFrame(() => r()));
      return fn();
    };

    this.renderer = await step('Booting renderer', 0.05, () => new RenderPipeline(this.container, this.scene));
    this.camera = this.renderer.camera;

    this.environment = await step('Generating environment', 0.15, () => new Environment(this.renderer.renderer, this.scene));
    await this.environment.init();

    this.stage = await step('Building arena', 0.3, () => new Stage(this.scene, this.environment));
    await this.stage.init();

    this.input = new Input(window);
    // Touch mounts unconditionally but stays hidden until a finger lands, so a
    // laptop with a touchscreen never gets a pad it did not ask for.
    this.touch = new TouchControls(this.uiRoot);
    this.input.attachTouch(this.touch);
    this.audio = new AudioDirector();
    this.fx = await step('Compiling effects', 0.5, () => new EffectsDirector(this.scene, this.renderer));
    await this.fx.init();

    this.fighters = await step('Assembling fighters', 0.65, () => [
      new Fighter({ index: 0, def: ROSTER[0], scene: this.scene, environment: this.environment }),
      new Fighter({ index: 1, def: ROSTER[1], scene: this.scene, environment: this.environment }),
    ]);
    await Promise.all(this.fighters.map((f) => f.init()));
    this.fighters[0].setOpponent(this.fighters[1]);
    this.fighters[1].setOpponent(this.fighters[0]);

    this.combat = new CombatSystem(this.fighters, this.stage);
    this.fightCamera = new FightCamera(this.camera, this.fighters, this.stage);
    this.cpu = [null, new CPU(this.fighters[1], this.fighters[0], { level: this.difficulty })];

    this.hud = await step('Drawing interface', 0.85, () => new HUD(this.uiRoot, this.fighters));
    this.menus = new MenuSystem(this.uiRoot, this);

    // Scripted entry points used by tools/capture.mjs to drive the game into
    // specific visual states for the automated critic pass.
    this.testHarness = makeTestHarness(this);

    this.renderer.warmup(this.scene, this.camera);
    this.onProgress('Ready', 1);

    this.#wireEvents();
    this.setPhase(PHASE.MENU);
    return this;
  }

  #wireEvents() {
    bus.on('hitstop', ({ ticks }) => { this.hitstopTicks = Math.max(this.hitstopTicks, ticks); });
    bus.on('timeScale', ({ scale, ticks }) => { this.slowmo.scale = scale; this.slowmo.ticks = ticks; });
    bus.on('roundEnd', ({ winner }) => {
      if (winner >= 0) this.wins[winner]++;
      this.setPhase(PHASE.KO);
    });
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseTicks = 0;
    bus.emit('phase', { phase });
  }

  /**
   * Set the quality tier across every subsystem that has one.
   *
   * `RenderPipeline`, `Environment` and `Stage` each implement `setQuality`, but
   * only the renderer's was ever called — the menu reached straight past the
   * other two. So choosing Low still ran the ultra lighting rig, the ultra
   * environment cube and the planar reflection, and the tier was a lie on every
   * setting but ultra. That matters most on the machines the low tier exists
   * for: the frame is fill-bound and light-bound, and the lighting rig is
   * exactly what the low tier is supposed to shed.
   *
   * Each call is guarded independently — a subsystem that has not finished
   * initialising, or a future one that never implements tiers, must not stop the
   * others from being told.
   *
   * @param {'ultra'|'high'|'medium'|'low'} tier
   */
  setQuality(tier) {
    this.quality = tier;
    try { this.renderer?.setQuality?.(tier); } catch (e) { console.warn('[quality] renderer', e); }
    try { this.environment?.setQuality?.(tier); } catch (e) { console.warn('[quality] environment', e); }
    try { this.stage?.setQuality?.(tier); } catch (e) { console.warn('[quality] stage', e); }
    bus.emit('quality', { tier });
  }

  /**
   * Set CPU difficulty. Takes effect immediately, mid-round included, so a
   * player can dial it while fighting rather than restarting to find out.
   * @param {number} level 1..10
   */
  setDifficulty(level) {
    this.difficulty = Math.min(10, Math.max(1, Math.round(level)));
    this.cpu[1]?.setLevel(this.difficulty);
    bus.emit('difficulty', { level: this.difficulty });
  }

  /**
   * Enter or leave training mode. The opponent is left standing: its CPU is
   * detached rather than set to level 1, because even the easiest CPU still
   * blocks and retaliates, and the point of training is an unmoving target.
   * @param {boolean} on
   */
  setTraining(on) {
    this.training = !!on;
    if (this.training) {
      this._cpuBeforeTraining = this.cpu[1];
      this.cpu[1] = null;
    } else if (this._cpuBeforeTraining) {
      this.cpu[1] = this._cpuBeforeTraining;
      this._cpuBeforeTraining = null;
    }
    bus.emit('training', { on: this.training });
  }

  /** Start a practice session against a standing opponent. */
  startTraining(p1Index = 0, p2Index = 1) {
    this.setTraining(true);
    this.startMatch(p1Index, p2Index);
  }

  startMatch(p1Index = 0, p2Index = 1) {
    this.fighters[0].setCharacter(ROSTER[p1Index]);
    this.fighters[1].setCharacter(ROSTER[p2Index]);
    this.round = 1;
    this.wins = [0, 0];
    this.#resetRound();
    this.setPhase(PHASE.INTRO);
  }

  #resetRound() {
    this.roundTimer = ROUND_TIME_SECONDS * TICK_HZ;
    this.fighters[0].reset(new THREE.Vector3(-1.9, 0, 0), 1);
    this.fighters[1].reset(new THREE.Vector3(1.9, 0, 0), -1);
    this.combat.reset();
    this.fx.reset();
    bus.emit('roundStart', { round: this.round });
  }

  start() {
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      this.#frame();
    };
    this.clock.start();
    frame();
  }

  stop() { cancelAnimationFrame(this.raf); }

  #frame() {
    const raw = Math.min(this.clock.getDelta(), 0.25);

    // Hitstop freezes the sim but keeps FX and camera alive at reduced rate.
    let scale = this.timeScale;
    if (this.slowmo.ticks > 0) { scale *= this.slowmo.scale; this.slowmo.ticks--; }
    const frozen = this.hitstopTicks > 0;
    if (frozen) {
      // Hitstop used to lose one tick per *rendered frame*, which made the most
      // game-feel-critical constant in the project a function of the player's
      // hardware. Two ways that went wrong, both measured: the contact burst
      // makes the frozen frames the slowest in the game — 43.3 ms during the
      // freeze against 11.1 ms after — so a launcher's nominal 11 ticks
      // (183 ms) actually ran 327 ms, and the freeze lengthened itself in
      // proportion to how heavy the hit was. In the other direction, a 144 Hz
      // display would have run it at 2.4x speed. Frame data is the game, and a
      // freeze inside the sim's own timeline has to be drained on the sim's own
      // clock — the same fixed TICK_DT the accumulator uses.
      this.hitstopAccum += raw * scale;
      while (this.hitstopAccum >= TICK_DT && this.hitstopTicks > 0) {
        this.hitstopAccum -= TICK_DT;
        this.hitstopTicks--;
      }
    } else if (this.hitstopAccum) this.hitstopAccum = 0;

    if (!this.paused && !frozen) this.accumulator += raw * scale;

    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < MAX_TICKS_PER_FRAME) {
      this.#simulate();
      this.accumulator -= TICK_DT;
      steps++;
      this.tick++;
      this.phaseTicks++;
    }
    if (steps === MAX_TICKS_PER_FRAME) this.accumulator = 0;

    const alpha = this.accumulator / TICK_DT;
    this.#render(raw, alpha, frozen);
  }

  #simulate() {
    this.input.beginTick(this.tick);

    switch (this.phase) {
      case PHASE.INTRO:
        for (const f of this.fighters) f.simulateIntro(this.phaseTicks);
        if (this.phaseTicks > 150) this.setPhase(PHASE.READY);
        break;

      case PHASE.READY:
        for (const f of this.fighters) f.simulate(null);
        if (this.phaseTicks > 70) this.setPhase(PHASE.FIGHT);
        break;

      case PHASE.FIGHT: {
        const cmds = [
          this.input.commandsFor(0, this.fighters[0]),
          this.cpu[1] ? this.cpu[1].think(this.tick) : this.input.commandsFor(1, this.fighters[1]),
        ];
        for (let i = 0; i < 2; i++) this.fighters[i].simulate(cmds[i]);
        this.combat.simulate(this.tick);
        if (this.training) this.#sustainTraining();
        else if (--this.roundTimer <= 0) this.combat.timeOut();
        break;
      }

      case PHASE.KO:
        for (const f of this.fighters) f.simulate(null);
        this.combat.simulate(this.tick);
        if (this.phaseTicks > 190) this.#afterRound();
        break;

      case PHASE.ROUND_END:
        if (this.phaseTicks > 90) { this.round++; this.#resetRound(); this.setPhase(PHASE.READY); }
        break;

      default:
        for (const f of this.fighters) f.simulate(null);
    }

    this.fightCamera.simulate(this.phase, this.phaseTicks);
    this.input.endTick();
  }

  /**
   * Keep a practice session running: hold the clock, and refill both fighters
   * before either can be knocked out. Health is restored only once a fighter is
   * out of hitstun so the damage numbers and the bar drain still read normally
   * on each hit — the feedback is the point of training, the attrition is not.
   */
  #sustainTraining() {
    this.roundTimer = ROUND_TIME_SECONDS * TICK_HZ;
    for (const f of this.fighters) {
      if (f.health < MAX_HEALTH && f.state !== 'hitstun' && f.state !== 'launched' && f.state !== 'juggled') {
        f.health = Math.min(MAX_HEALTH, f.health + TRAINING_REFILL);
      }
    }
  }

  #afterRound() {
    const done = this.wins[0] >= ROUNDS_TO_WIN || this.wins[1] >= ROUNDS_TO_WIN;
    if (done) {
      bus.emit('matchEnd', { winner: this.wins[0] > this.wins[1] ? 0 : 1 });
      this.setPhase(PHASE.MATCH_END);
    } else {
      this.setPhase(PHASE.ROUND_END);
    }
  }

  #render(dt, alpha, frozen) {
    const visualDt = frozen ? dt * 0.08 : dt;
    for (const f of this.fighters) f.render(alpha, visualDt);
    this.stage.update(visualDt, this.tick);
    this.fx.update(visualDt, alpha);
    this.fightCamera.render(alpha, visualDt);
    this.hud.update(this, visualDt);
    this.renderer.render(this.scene, this.camera, visualDt);
  }
}
