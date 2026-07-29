/**
 * Knockbots — seeded RNG.
 *
 * The simulation must be deterministic so replays and rollback work, so any
 * randomness inside a `simulate()` path goes through one of these. Presentation
 * code may use Math.random() freely.
 *
 * xorshift128+ — fast, good distribution, tiny state.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.s0 = seed >>> 0 || 1;
    this.s1 = (Math.imul(seed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0 || 2;
    for (let i = 0; i < 12; i++) this.next();
  }

  /** @returns {number} float in [0,1) */
  next() {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.s1 = s1 >>> 0;
    return ((this.s0 + this.s1) >>> 0) / 4294967296;
  }

  range(a, b) { return a + this.next() * (b - a); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** Gaussian-ish via sum of uniforms; mean 0, ~unit variance. */
  gauss() { return (this.next() + this.next() + this.next() - 1.5) * 1.1547; }

  clone() { const r = new Rng(1); r.s0 = this.s0; r.s1 = this.s1; return r; }
  reseed(seed) { this.s0 = seed >>> 0 || 1; this.s1 = (Math.imul(seed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0 || 2; }
}

/** Shared instance for non-critical presentation randomness that still wants a seed. */
export const rng = new Rng(20260729);
