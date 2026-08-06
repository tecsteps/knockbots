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
 *                  velocity:Vector3, bone:string,
 *                  damage, counter:boolean, region:string, comboCount:number }
 *   'block'      { attacker, defender, move, point:Vector3,
 *                  velocity:Vector3, bone:string }
 *
 *   `normal` is the capsule-separation axis between the two bodies. It is NOT
 *   the direction the blow travelled — effects driven from it spray along an
 *   arbitrary axis. Use `velocity`, the striking bone's swept world velocity in
 *   m/s over the contact tick, to orient sparks, trails and shockwaves, and
 *   `bone` to anchor them.
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
 *
 *   'requestPause' {}
 *                The HUD's touch MENU button asking for the pause screen;
 *                MenuSystem routes it into the same handler as Escape.
 *
 *                It exists because the touch pad mounts a stick, four limbs,
 *                overdrive and block -- and nothing that opens a menu. So once
 *                a match started on a handset, the pause screen, the options,
 *                the move list and QUIT TO TITLE were all unreachable: a phone
 *                player could not leave a match. The button is gated on
 *                `@media (hover: none)`, so the desktop capture context is
 *                byte-identical and 08-hud is unaffected.
 *
 *                It is a REQUEST rather than a command deliberately. The pad
 *                cannot know whether pausing is legal in the current phase --
 *                it is not during the intro, the KO or the match-end screens --
 *                so the input asks and MenuSystem decides, which is the same
 *                split every other event here follows.
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
