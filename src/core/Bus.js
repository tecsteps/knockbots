/**
 * Knockbots — synchronous event bus.
 *
 * The simulation never talks to FX, audio, UI or the camera directly; it emits
 * events and those systems subscribe. That keeps the sim deterministic and
 * rewindable, and lets presentation systems be developed independently.
 *
 * Canonical events (payloads are plain objects, reused per emit — copy what you
 * need, do not retain the payload):
 *
 *   'hit'        { attacker, defender, move, point:Vector3, normal:Vector3,
 *                  damage, counter:boolean, region:string, comboCount:number }
 *   'block'      { attacker, defender, move, point:Vector3 }
 *   'parry'      { attacker, defender, point:Vector3 }
 *   'whiff'      { fighter, move }
 *   'launch'     { fighter, velocity:Vector3 }
 *   'knockdown'  { fighter, point:Vector3 }
 *   'wallSplat'  { fighter, point:Vector3, normal:Vector3 }
 *   'groundImpact' { fighter, point:Vector3, speed:number }
 *   'footstep'   { fighter, foot:'L'|'R', point:Vector3, force:number }
 *   'dash'       { fighter, dir:number }
 *   'jump'       { fighter }
 *   'meterFull'  { fighter }
 *   'superStart' { fighter, move }
 *   'superHit'   { attacker, defender, move }
 *   'armorAbsorb'{ fighter, move, point:Vector3 }
 *   'partBreak'  { fighter, part:string, point:Vector3 }
 *   'roundStart' { round:number }
 *   'roundEnd'   { round:number, winner:number, ko:boolean, perfect:boolean }
 *   'matchEnd'   { winner:number }
 *   'comboEnd'   { fighter, hits:number, damage:number }
 *   'hitstop'    { ticks:number }
 *   'shake'      { amount:number, ticks:number }
 *   'timeScale'  { scale:number, ticks:number }
 */

export class Bus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
    this.anyHandlers = new Set();
  }

  on(event, fn) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  onAny(fn) {
    this.anyHandlers.add(fn);
    return () => this.anyHandlers.delete(fn);
  }

  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this.handlers.get(event);
    if (set) for (const fn of set) fn(payload, event);
    if (this.anyHandlers.size) for (const fn of this.anyHandlers) fn(payload, event);
  }

  clear() {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}

/** The one bus the game uses. Systems import this directly. */
export const bus = new Bus();
