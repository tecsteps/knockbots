/**
 * Knockbots — the audio director.
 *
 * Everything here is synthesised at runtime through the Web Audio API. There
 * are no sample files: impacts are noise excited through a bank of tuned
 * resonant bandpasses (modal synthesis of a struck metal plate), the
 * announcer is a tiny formant synthesiser reading a handful of stock phrases
 * phoneme-by-phoneme (not `speechSynthesis`), and the arena reverb is a
 * convolver whose impulse response is generated once at startup — decayed
 * noise, exactly like clapping in an empty room and recording it, except the
 * "clap" and the "room" are both math.
 *
 * Signal flow
 * -----------
 *   sfxBus ────────────────────────┐
 *   musicBus → duck → filter ──────┼─→ compressor → limiter → master → dest
 *   announcerBus ───────────────── ┘        ▲
 *        └──────→ send → convolver ─────────┘
 *
 * `duck` is a dedicated gain stage so a hit can pull the music bed down and
 * let it spring back without disturbing the music system's own layer-gain
 * automation underneath it. `filter` is a single lowpass whose cutoff opens
 * as the fight gets more dangerous, read from fighter references handed to
 * us by bus event payloads (see `#trackHealth`) — this class holds no
 * reference to a Fighter or the match; everything it knows, it learned from
 * the bus, which is what keeps it decoupled from the sim.
 *
 * Node lifetime: oscillators and buffer sources are one-shot by the Web
 * Audio spec (`start()` may only be called once), so a transient sound
 * necessarily gets fresh nodes — what "pool and reuse" means here is that
 * the *expensive, reusable* assets (the noise buffer, the impulse response,
 * distortion curves) are built once and shared, the *sustained* voices (the
 * music bed's sub and arp) are persistent oscillators whose parameters are
 * automated rather than ever being recreated, and every transient voice is
 * registered with a small reaper (`#addVoice`/`#reapVoices`) that
 * disconnects it the instant its envelope has finished, with a hard cap on
 * concurrent voices as a backstop against a hit-flurry ever accumulating
 * unbounded nodes.
 *
 * Character identity: `roster.js` authors a `voice` block per character
 * specifically for this file (pitch, timbre, resonance, grit, servo and
 * impact frequencies). Every handler that receives a fighter reads it via
 * `#voiceOf()`, so Vulkan's furnace clang and Kestrel's coolant chime are
 * the same code path producing genuinely different sounds.
 */

import { WEIGHT, MAX_HEALTH } from '../core/Constants.js';
import { bus } from '../core/Bus.js';

// ---------------------------------------------------------------------------
// Static sound data
// ---------------------------------------------------------------------------

/** Fallback for a fighter with no `def.voice` (or no fighter at all). */
const DEFAULT_VOICE = { pitch: 1, timbre: 0.5, resonance: 0.5, grit: 0.2, servo: 220, impact: 300, tone: 'clean' };

/**
 * Modal partial sets, one per attack weight: [frequencyHz, Q, gain, decaySeconds].
 * These are what a noise impulse rings into once it's filtered — a rough
 * struck-metal-plate spectrum, brighter/shorter for light hits, lower/longer
 * for heavy ones.
 */
const MODAL_SETS = {
  [WEIGHT.LIGHT]: [[1900, 10, 0.50, 0.045], [2600, 13, 0.36, 0.035], [3500, 15, 0.24, 0.028]],
  [WEIGHT.MEDIUM]: [[950, 7, 0.55, 0.085], [1550, 9, 0.42, 0.065], [2450, 11, 0.30, 0.048], [3300, 13, 0.18, 0.036]],
  [WEIGHT.HEAVY]: [[430, 5, 0.70, 0.150], [760, 6.5, 0.56, 0.120], [1220, 8, 0.40, 0.095], [2050, 10, 0.26, 0.070]],
  [WEIGHT.LAUNCHER]: [[500, 6, 0.62, 0.130], [940, 8, 0.48, 0.100], [1650, 10, 0.34, 0.075], [2500, 12, 0.20, 0.055]],
  [WEIGHT.ULTRA]: [[300, 4, 0.85, 0.260], [560, 5, 0.70, 0.200], [940, 6.5, 0.52, 0.150], [1550, 8.5, 0.36, 0.110], [2700, 10.5, 0.22, 0.075]],
};

/** Low-end body thump per weight: start freq, end freq, duration, gain. */
const THUMP_PARAMS = {
  [WEIGHT.LIGHT]: { f0: 180, f1: 70, dur: 0.05, gain: 0.40 },
  [WEIGHT.MEDIUM]: { f0: 150, f1: 55, dur: 0.08, gain: 0.60 },
  [WEIGHT.HEAVY]: { f0: 120, f1: 42, dur: 0.12, gain: 0.85 },
  [WEIGHT.LAUNCHER]: { f0: 130, f1: 45, dur: 0.11, gain: 0.80 },
  [WEIGHT.ULTRA]: { f0: 100, f1: 35, dur: 0.18, gain: 1.00 },
};

const WEIGHT_GAIN = {
  [WEIGHT.LIGHT]: 0.55, [WEIGHT.MEDIUM]: 0.75, [WEIGHT.HEAVY]: 1.0, [WEIGHT.LAUNCHER]: 1.0, [WEIGHT.ULTRA]: 1.25,
};

/**
 * Formant table for the announcer. `f`/`q` are the three parallel bandpass
 * formants a voiced phoneme is built from; `band` is the noise passband for
 * an unvoiced one. `glideTo` animates the formants across the phoneme for a
 * cheap diphthong. This is deliberately a rough, stylised approximation —
 * the goal is a recognisably robotic *announcer*, not intelligible speech.
 */
const PHONEMES = {
  R: { type: 'voiced', f: [310, 1060, 1380], q: [8, 7, 6], dur: 0.07, amp: 0.5 },
  W: { type: 'voiced', f: [290, 610, 2150], q: [8, 7, 6], dur: 0.07, amp: 0.5 },
  N: { type: 'voiced', f: [280, 2300, 2700], q: [10, 8, 8], dur: 0.08, amp: 0.4 },
  AH: { type: 'voiced', f: [640, 1190, 2390], q: [7, 6, 5], dur: 0.15, amp: 0.85 },
  OW: { type: 'voiced', f: [490, 910, 2350], q: [7, 6, 5], dur: 0.16, amp: 0.8, glideTo: [400, 800, 2300] },
  IY: { type: 'voiced', f: [270, 2290, 3010], q: [9, 7, 6], dur: 0.13, amp: 0.7 },
  UW: { type: 'voiced', f: [300, 870, 2240], q: [8, 6, 5], dur: 0.14, amp: 0.7 },
  EY: { type: 'voiced', f: [520, 1900, 2650], q: [7, 6, 5], dur: 0.15, amp: 0.8, glideTo: [380, 2300, 2900] },
  AY: { type: 'voiced', f: [660, 1200, 2550], q: [6, 6, 5], dur: 0.16, amp: 0.85, glideTo: [400, 2200, 2900] },
  T: { type: 'plosive', band: [2500, 6500], dur: 0.045, amp: 0.6 },
  D: { type: 'plosive', band: [1500, 4500], dur: 0.05, amp: 0.5, voicedTail: { f: [280, 1600, 2400], dur: 0.05 } },
  K: { type: 'plosive', band: [1400, 4000], dur: 0.05, amp: 0.55 },
  F: { type: 'fricative', band: [3000, 7500], dur: 0.09, amp: 0.4 },
  TH: { type: 'fricative', band: [3200, 6500], dur: 0.08, amp: 0.35 },
};

/** Stock phrases as phoneme sequences. Stylised, not phonetically exact. */
const WORDS = {
  ROUND: ['R', 'AH', 'N', 'D'],
  ONE: ['W', 'AH', 'N'],
  TWO: ['T', 'UW'],
  THREE: ['TH', 'R', 'IY'],
  FIGHT: ['F', 'AY', 'T'],
  KAY: ['K', 'EY'],
  OH: ['OW'],
};

/** A minor. `chords` are semitone offsets from `arpRoot`, one array per bar in the loop. */
const MUSIC = {
  bpm: 128,
  sec16th: 60 / 128 / 4,
  arpRoot: 220,   // A3
  subRoot: 55,    // A1
  chords: [[0, 3, 7], [0, 3, 7], [8, 12, 15], [10, 14, 17]], // i, i, VI, VII
};
const KICK_STEPS = new Set([0, 6, 8, 14]);
const SNARE_STEPS = new Set([4, 12]);

const MAX_VOICES = 40;
const PRE_ROLL = 0.02; // schedule new one-shots a hair into the future so their setValueAtTime(0) always lands

// ---------------------------------------------------------------------------

export class AudioDirector {
  constructor() {
    const Ctx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
      (typeof AudioContext !== 'undefined' ? AudioContext : null);
    this.ctx = Ctx ? new Ctx() : null;

    this._volume = 0.85;
    this._muted = false;
    this._unlocked = false;
    this._voices = [];
    this._distCurves = new Map();
    this._health = [MAX_HEALTH, MAX_HEALTH];
    this._intensity = 0;
    this._roundNumber = 1;
    this._musicStarted = false;
    this._stepIndex = 0;
    this._barIndex = 0;
    this._nextStepTime = 0;
    this._lastUpdateAt = 0;
    this._raf = 0;
    this._unsubs = [];

    if (!this.ctx) return; // no Web Audio available — every public method below becomes a no-op

    this.#buildGraph();
    this.#applyMasterGain();
    this.#wireEvents();
  }

  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  #buildGraph() {
    const ctx = this.ctx;

    this.noiseBuffer = this.#makeNoiseBuffer(3.0);
    this.irBuffer = this.#makeImpulseResponse(2.4, 5.5);

    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6; this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    this.limiter.connect(this.masterGain);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18; this.compressor.knee.value = 8;
    this.compressor.ratio.value = 3; this.compressor.attack.value = 0.006; this.compressor.release.value = 0.22;
    this.compressor.connect(this.limiter);

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = this.irBuffer;
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.compressor);

    // --- SFX bus ---
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.compressor);
    this.sfxSend = ctx.createGain(); this.sfxSend.gain.value = 0.22;
    this.sfxBus.connect(this.sfxSend); this.sfxSend.connect(this.convolver);

    // --- Announcer bus ---
    this.announcerBus = ctx.createGain(); this.announcerBus.gain.value = 1;
    this.announcerBus.connect(this.compressor);
    this.announceSend = ctx.createGain(); this.announceSend.gain.value = 0.35;
    this.announcerBus.connect(this.announceSend); this.announceSend.connect(this.convolver);

    // --- Music bus: layers -> sum -> duck -> health-driven filter -> out ---
    this.subLevelGain = ctx.createGain(); this.subLevelGain.gain.value = 0.35;
    this.subPulseGain = ctx.createGain(); this.subPulseGain.gain.value = 0.2;
    this.subOsc = ctx.createOscillator(); this.subOsc.type = 'triangle'; this.subOsc.frequency.value = MUSIC.subRoot;
    this.subOsc.connect(this.subPulseGain); this.subPulseGain.connect(this.subLevelGain);

    this.arpLevelGain = ctx.createGain(); this.arpLevelGain.gain.value = 0.02;
    this.arpGain = ctx.createGain(); this.arpGain.gain.value = 0.0001;
    this.arpFilter = ctx.createBiquadFilter(); this.arpFilter.type = 'lowpass';
    this.arpFilter.frequency.value = 2200; this.arpFilter.Q.value = 2.2;
    this.arpOsc = ctx.createOscillator(); this.arpOsc.type = 'sawtooth'; this.arpOsc.frequency.value = MUSIC.arpRoot;
    this.arpOsc.connect(this.arpFilter); this.arpFilter.connect(this.arpGain); this.arpGain.connect(this.arpLevelGain);

    this.percLevelGain = ctx.createGain(); this.percLevelGain.gain.value = 0.03;

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 1;
    this.subLevelGain.connect(this.musicBus);
    this.arpLevelGain.connect(this.musicBus);
    this.percLevelGain.connect(this.musicBus);

    this.duckGain = ctx.createGain(); this.duckGain.gain.value = 1;
    this.musicBus.connect(this.duckGain);

    this.musicFilter = ctx.createBiquadFilter(); this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 900; this.musicFilter.Q.value = 0.7;
    this.duckGain.connect(this.musicFilter);
    this.musicFilter.connect(this.compressor);
    this.musicSend = ctx.createGain(); this.musicSend.gain.value = 0.3;
    this.musicFilter.connect(this.musicSend); this.musicSend.connect(this.convolver);
  }

  #makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  /** Decayed noise, generated once — the arena's "room". */
  #makeImpulseResponse(seconds, decayRate) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        let v = (Math.random() * 2 - 1) * Math.exp(-t * decayRate);
        // A couple of early reflections give the tail a room-like slap
        // instead of a smooth synthetic fade.
        if (i > 0 && (i % Math.floor(ctx.sampleRate * (0.017 + ch * 0.003)) === 0) && t < 0.09) {
          v += (Math.random() * 2 - 1) * 0.5;
        }
        data[i] = v;
      }
    }
    return buf;
  }

  #distCurve(amount) {
    const key = Math.round(amount * 20);
    let c = this._distCurves.get(key);
    if (c) return c;
    const k = key * 2.5 + 1;
    const n = 256;
    c = new Float32Array(n);
    const norm = Math.tanh(k) || 1;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    this._distCurves.set(key, c);
    return c;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Resume the (autoplay-suspended) context on a user gesture. Safe to call repeatedly. */
  async unlock() {
    if (!this.ctx) return;
    try { await this.ctx.resume(); } catch { /* still blocked; the next gesture will retry */ }
    if (this.ctx.state !== 'running') return;
    this._unlocked = true;
    if (!this._musicStarted) {
      this._musicStarted = true;
      this._nextStepTime = this.ctx.currentTime + 0.05;
      this._stepIndex = 0;
      this._barIndex = 0;
      this.subOsc.start();
      this.arpOsc.start();
    }
    this.#startFallbackLoop();
  }

  /** Master volume, 0..1. */
  setVolume(v) { this._volume = Math.min(1, Math.max(0, v)); this.#applyMasterGain(); }

  /** Mute without losing the volume setting. */
  setMuted(m) { this._muted = !!m; this.#applyMasterGain(); }

  #applyMasterGain() {
    if (!this.ctx) return;
    const target = this._muted ? 0 : this._volume;
    this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
  }

  /**
   * Advance the music scheduler and every time-based modulation. Cheap and
   * idempotent — safe to call once a frame, and safe to not call at all
   * (the fallback loop started in `unlock()` will drive things regardless).
   * @param {number} dt seconds since the last call
   */
  update(dt) {
    if (!this.ctx) return;
    this._lastUpdateAt = AudioDirector.#now();
    this.#advance(Math.min(0.25, Math.max(0, dt)));
  }

  dispose() {
    for (const off of this._unsubs) off();
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  static #now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  // -------------------------------------------------------------------------
  // Fallback scheduler
  // -------------------------------------------------------------------------

  /**
   * `Game.js` may or may not be wired to call `update()` every frame. Either
   * way the music must keep playing once unlocked, so a light rAF loop keeps
   * things moving on its own — but only steps in when nobody else has driven
   * us recently, so the two never fight over who owns the clock.
   */
  #startFallbackLoop() {
    if (this._raf) return;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (AudioDirector.#now() - this._lastUpdateAt > 50) this.update(1 / 60);
    };
    this._raf = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Per-frame advance: voice reaping, modulation, music scheduling
  // -------------------------------------------------------------------------

  #advance(dt) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.#reapVoices(now);
    this._intensity = Math.max(0, this._intensity - dt * 0.12);
    this.#updateMusicLevels(now);

    if (!this._musicStarted) return;
    const LOOKAHEAD = 0.15;
    let guard = 0;
    while (this._nextStepTime < now + LOOKAHEAD && guard++ < 8) {
      this.#triggerStep(this._stepIndex, this._nextStepTime);
      this._stepIndex = (this._stepIndex + 1) % 16;
      if (this._stepIndex === 0) this._barIndex++;
      this._nextStepTime += MUSIC.sec16th;
    }
    // A backgrounded tab can starve us for seconds; resync instead of firing
    // a stampede of overdue notes the instant it's visible again.
    if (this._nextStepTime < now) this._nextStepTime = now + MUSIC.sec16th;
  }

  #updateMusicLevels(now) {
    const danger = 1 - Math.min(this._health[0], this._health[1]) / MAX_HEALTH;
    const subTarget = 0.32 + danger * 0.28;
    const arpTarget = this._intensity > 0.12 ? Math.min(0.42, 0.08 + this._intensity * 0.5 + danger * 0.15) : 0.015;
    const percTarget = this._intensity > 0.28 ? Math.min(0.5, this._intensity * 0.55 + danger * 0.25) : 0.02;
    const cutoff = Math.min(9000, 700 + danger * 6500 + this._intensity * 1200);
    this.subLevelGain.gain.setTargetAtTime(subTarget, now, 0.4);
    this.arpLevelGain.gain.setTargetAtTime(arpTarget, now, 0.5);
    this.percLevelGain.gain.setTargetAtTime(percTarget, now, 0.5);
    this.musicFilter.frequency.setTargetAtTime(cutoff, now, 0.3);
    this.musicFilter.Q.setTargetAtTime(0.6 + danger * 1.4, now, 0.4);
  }

  #triggerStep(step, t) {
    if (step % 4 === 0) this.#subPulse(t);
    const chord = MUSIC.chords[this._barIndex % MUSIC.chords.length];
    const pattern = [chord[0], chord[1], chord[2], chord[1], chord[0] + 12, chord[2], chord[1], chord[0]];
    const note = pattern[step % pattern.length];
    const freq = MUSIC.arpRoot * Math.pow(2, note / 12);
    this.arpOsc.frequency.setValueAtTime(freq, t);
    this.#arpPluck(t);
    if (KICK_STEPS.has(step)) this.#kick(t);
    if (SNARE_STEPS.has(step)) this.#snare(t);
    if (step % 2 === 1) this.#hat(t, 0.6);
  }

  #subPulse(t) {
    const g = this.subPulseGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.15, t);
    g.linearRampToValueAtTime(1, t + 0.015);
    g.exponentialRampToValueAtTime(0.22, t + 0.28);
  }

  #arpPluck(t) {
    const g = this.arpGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(0.9, t + 0.008);
    g.exponentialRampToValueAtTime(0.0008, t + 0.1);
  }

  #kick(t) { this.#thump(this.percLevelGain, t, { f0: 150, f1: 48, dur: 0.09, amp: 0.9 }); }
  #snare(t) {
    this.#noise(this.percLevelGain, t, 0.09, { filterType: 'bandpass', freq: 1800, q: 0.9, amp: 0.5, attack: 0.002, release: 0.06 });
    this.#noise(this.percLevelGain, t, 0.02, { filterType: 'highpass', freq: 5000, q: 0.7, amp: 0.3, attack: 0.001, release: 0.02 });
  }
  #hat(t, vel) {
    this.#noise(this.percLevelGain, t, 0.03 * vel, { filterType: 'highpass', freq: 7500, q: 0.8, amp: 0.22 * vel, attack: 0.001, release: 0.02 });
  }

  // -------------------------------------------------------------------------
  // Voice pool
  // -------------------------------------------------------------------------

  #addVoice(nodes, until) {
    this._voices.push({ nodes, until });
    if (this._voices.length > MAX_VOICES) {
      const old = this._voices.shift();
      for (const n of old.nodes) { try { n.disconnect(); } catch { /* already disconnected */ } }
    }
  }

  #reapVoices(now) {
    if (!this._voices.length) return;
    this._voices = this._voices.filter((v) => {
      if (v.until > now) return true;
      for (const n of v.nodes) { try { n.disconnect(); } catch { /* already disconnected */ } }
      return false;
    });
  }

  // -------------------------------------------------------------------------
  // Shared synthesis primitives
  // -------------------------------------------------------------------------

  #noiseVoice() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const maxStart = Math.max(0, this.noiseBuffer.duration - 1.4);
    return { src, offset: Math.random() * maxStart };
  }

  /** Filtered noise burst — the workhorse behind hiss, scrapes, clicks and percussion. */
  #noise(dest, t0, dur, { filterType = 'bandpass', freq = 2000, freqEnd = null, q = 1, amp = 0.4, attack = 0.005, release = null }) {
    const ctx = this.ctx;
    const t = t0 + PRE_ROLL;
    const rel = release ?? dur * 0.4;
    const { src, offset } = this.#noiseVoice();
    const filt = ctx.createBiquadFilter(); filt.type = filterType; filt.Q.value = q;
    filt.frequency.setValueAtTime(freq, t);
    if (freqEnd != null) filt.frequency.linearRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur + rel);
    src.connect(filt); filt.connect(g); g.connect(dest);
    src.start(t, offset); src.stop(t + dur + rel + 0.02);
    this.#addVoice([src, filt, g], t + dur + rel + 0.05);
    return dur;
  }

  /** Pitch-dropping sine — the low-end "body" under every impact and every footfall/kick. */
  #thump(dest, t0, { f0, f1, dur, amp }) {
    const ctx = this.ctx;
    const t = t0 + PRE_ROLL;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, amp), t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur * 1.3);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + dur * 1.3 + 0.02);
    this.#addVoice([osc, g], t + dur * 1.3 + 0.05);
  }

  #duck(amountDrop, attack, release) {
    if (!this.ctx) return;
    const g = this.duckGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.min(1, g.value), now);
    g.linearRampToValueAtTime(Math.max(0.04, 1 - amountDrop), now + attack);
    g.setTargetAtTime(1, now + attack, release);
  }

  #voiceOf(fighter) { return (fighter && fighter.def && fighter.def.voice) || DEFAULT_VOICE; }

  #trackHealth(fighter) {
    if (fighter && typeof fighter.index === 'number' && typeof fighter.health === 'number') {
      this._health[fighter.index] = fighter.health;
    }
  }

  #bumpIntensity(n) { this._intensity = Math.min(1, this._intensity + n); }

  // -------------------------------------------------------------------------
  // Impact family: hits, blocks, part breaks, wall/body slams
  // -------------------------------------------------------------------------

  /**
   * Modal-synthesis impact: a short noise exciter through the weight class's
   * bandpass bank, plus a body thump and (unless damped) a transient click.
   */
  #impact({ weight = WEIGHT.MEDIUM, attacker = null, defender = null, counter = false, damped = false }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + PRE_ROLL;
    const set = MODAL_SETS[weight] || MODAL_SETS[WEIGHT.MEDIUM];
    const thumpP = THUMP_PARAMS[weight] || THUMP_PARAMS[WEIGHT.MEDIUM];
    const voice = this.#voiceOf(defender || attacker);
    const impactScale = (voice.impact || 300) / 300;
    const bright = damped ? voice.timbre * 0.4 : voice.timbre;
    const qScale = 1 + voice.resonance * 0.8;
    const decayScale = (damped ? 0.45 : 1) * (1 + voice.resonance * 0.5) * (counter ? 1.15 : 1);
    const gainScale = (WEIGHT_GAIN[weight] || 0.8) * (counter ? 1.2 : 1) * (damped ? 0.55 : 1);
    const dest = this.sfxBus;

    const { src, offset } = this.#noiseVoice();
    const excite = ctx.createGain();
    excite.gain.setValueAtTime(1, t);
    excite.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    src.connect(excite);
    src.start(t, offset); src.stop(t + 0.05);

    let exciteOut = excite;
    const nodes = [src, excite];
    if (voice.grit > 0.2) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.#distCurve(voice.grit * 0.6);
      excite.connect(shaper);
      exciteOut = shaper;
      nodes.push(shaper);
    }

    let longest = 0.05;
    for (const [f, q, g, d] of set) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = f * impactScale;
      bp.Q.value = (damped ? q * 0.55 : q) * qScale;
      const gg = ctx.createGain();
      const amp = g * gainScale * (0.55 + bright * 0.6);
      gg.gain.setValueAtTime(amp, t);
      const dcy = d * decayScale;
      gg.gain.exponentialRampToValueAtTime(0.0006, t + dcy);
      exciteOut.connect(bp); bp.connect(gg); gg.connect(dest);
      nodes.push(bp, gg);
      longest = Math.max(longest, dcy);
    }
    this.#addVoice(nodes, t + longest + 0.08);

    this.#thump(dest, t, { f0: thumpP.f0, f1: thumpP.f1, dur: thumpP.dur * (damped ? 0.7 : 1), amp: thumpP.gain * gainScale * (1 - bright * 0.3) });
    if (!damped) this.#noise(dest, t, 0.01, { filterType: 'highpass', freq: 4200, q: 0.7, amp: 0.35 * gainScale, attack: 0.001, release: 0.01 });

    this.#duck(damped ? 0.15 : Math.min(0.6, 0.25 + gainScale * 0.25), 0.01, damped ? 0.15 : 0.32);
  }

  #hiss(dest, t0, voice, durMul = 1) {
    const dur = (0.35 + (voice.grit || 0.3) * 0.3) * durMul;
    this.#noise(dest, t0, dur, { filterType: 'bandpass', freq: 3200, freqEnd: 1400, q: 0.8, amp: 0.22, attack: 0.05, release: dur * 0.5 });
  }

  #scrape(fighter) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const voice = this.#voiceOf(fighter);
    const dur = 0.5;
    const base = 900 * ((voice.impact || 300) / 300);
    const { src, offset } = this.#noiseVoice();
    const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 6;
    filt.frequency.setValueAtTime(base, t);
    filt.frequency.linearRampToValueAtTime(base * 1.6, t + dur * 0.35);
    filt.frequency.linearRampToValueAtTime(base * 0.7, t + dur * 0.75);
    filt.frequency.linearRampToValueAtTime(base * 1.1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.04);
    g.gain.setValueAtTime(0.28, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur + 0.1);
    src.connect(filt); filt.connect(g); g.connect(this.sfxBus);
    src.start(t, offset); src.stop(t + dur + 0.15);
    this.#addVoice([src, filt, g], t + dur + 0.2);
  }

  #bodySlam(fighter, speed) {
    const weight = speed > 9 ? WEIGHT.ULTRA : speed > 6 ? WEIGHT.HEAVY : WEIGHT.MEDIUM;
    this.#impact({ weight, defender: fighter });
  }

  #footstep(fighter, force = 0.5) {
    const voice = this.#voiceOf(fighter);
    const clamped = Math.min(1.6, Math.max(0.15, force));
    const t = this.ctx.currentTime;
    this.#thump(this.sfxBus, t, { f0: 130 * Math.pow((voice.impact || 300) / 300, 0.3), f1: 45, dur: 0.045 + clamped * 0.02, amp: 0.18 * clamped });
    this.#noise(this.sfxBus, t, 0.012, { filterType: 'bandpass', freq: 1400, q: 2, amp: 0.08 * clamped, attack: 0.001, release: 0.015 });
  }

  #partBreakSfx(fighter) {
    this.#impact({ weight: WEIGHT.HEAVY, defender: fighter });
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const t = now + 0.02 + i * 0.028 + Math.random() * 0.015;
      this.#noise(this.sfxBus, t, 0.02, { filterType: 'highpass', freq: 3000 + Math.random() * 3000, q: 1.5, amp: 0.12, attack: 0.001, release: 0.02 });
    }
  }

  // -------------------------------------------------------------------------
  // Tonal one-shots: parry bell, meter chime, servo whine, stinger
  // -------------------------------------------------------------------------

  #parryBell(fighter) {
    const ctx = this.ctx;
    const t = ctx.currentTime + PRE_ROLL;
    const voice = this.#voiceOf(fighter);
    const base = 780 * (voice.pitch || 1);
    const ratios = [1, 2.41, 3.8, 5.4, 6.9];
    const gains = [0.5, 0.34, 0.22, 0.14, 0.09];
    const nodes = [];
    let longest = 0.2;
    for (let i = 0; i < ratios.length; i++) {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = base * ratios[i];
      const g = ctx.createGain();
      const dur = 0.9 - i * 0.1;
      g.gain.setValueAtTime(gains[i], t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      osc.connect(g); g.connect(this.sfxBus);
      osc.start(t); osc.stop(t + dur + 0.05);
      nodes.push(osc, g);
      longest = Math.max(longest, dur);
    }
    this.#addVoice(nodes, t + longest + 0.1);
    this.#noise(this.sfxBus, t, 0.01, { filterType: 'highpass', freq: 5000, q: 0.7, amp: 0.2, attack: 0.001, release: 0.01 });
    this.#duck(0.25, 0.01, 0.4);
  }

  #meterChime(fighter) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const voice = this.#voiceOf(fighter);
    const notes = [880 * (voice.pitch || 1), 1320 * (voice.pitch || 1)];
    notes.forEach((f, i) => {
      const t = now + PRE_ROLL + i * 0.07;
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.18);
      osc.connect(g); g.connect(this.sfxBus);
      osc.start(t); osc.stop(t + 0.22);
      this.#addVoice([osc, g], t + 0.25);
    });
  }

  /** FM sweep: a modulator driving the carrier's frequency AudioParam directly. */
  #servoWhine(fighter, { rise = true, dur = 0.18, big = false, quick = false } = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime + PRE_ROLL;
    const voice = this.#voiceOf(fighter);
    const base = voice.servo || 220;
    const carrier = ctx.createOscillator(); carrier.type = 'square';
    const modOsc = ctx.createOscillator(); modOsc.type = 'sine'; modOsc.frequency.value = base * 0.5;
    const modGain = ctx.createGain(); modGain.gain.value = base * (big ? 1.4 : 0.6);
    modOsc.connect(modGain); modGain.connect(carrier.frequency);
    const startF = rise ? base * 0.6 : base * 1.4;
    const endF = rise ? base * (big ? 2.2 : 1.6) : base * 0.55;
    carrier.frequency.setValueAtTime(startF, t);
    carrier.frequency.exponentialRampToValueAtTime(Math.max(40, endF), t + dur);
    const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.frequency.value = base * 1.2; filt.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(big ? 0.35 : quick ? 0.12 : 0.18, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur + 0.05);
    carrier.connect(filt); filt.connect(g); g.connect(this.sfxBus);
    carrier.start(t); modOsc.start(t);
    carrier.stop(t + dur + 0.08); modOsc.stop(t + dur + 0.08);
    this.#addVoice([carrier, modOsc, modGain, filt, g], t + dur + 0.12);
  }

  #whoosh() {
    this.#noise(this.sfxBus, this.ctx.currentTime, 0.14, { filterType: 'bandpass', freq: 2600, freqEnd: 900, q: 1.1, amp: 0.09, attack: 0.01, release: 0.08 });
  }

  #stinger() {
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.02;
    const root = MUSIC.arpRoot * Math.pow(2, MUSIC.chords[0][0] / 12);
    [0, 3, 7, 12].forEach((n, i) => {
      const t = now + i * 0.09;
      const f = root * Math.pow(2, n / 12);
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = f;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 2200; filt.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.7);
      osc.connect(filt); filt.connect(g); g.connect(this.sfxBus);
      osc.start(t); osc.stop(t + 0.75);
      this.#addVoice([osc, filt, g], t + 0.8);
    });
  }

  /** A big hit briefly detunes the music bed — an "impact bloom" tied to hitstop. */
  #hitstopFlourish(ticks) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const amount = Math.min(1, ticks / 20) * 60;
    for (const osc of [this.subOsc, this.arpOsc]) {
      osc.detune.cancelScheduledValues(now);
      osc.detune.setValueAtTime(0, now);
      osc.detune.linearRampToValueAtTime(-amount, now + 0.03);
      osc.detune.setTargetAtTime(0, now + 0.03, 0.18);
    }
  }

  // -------------------------------------------------------------------------
  // Announcer
  // -------------------------------------------------------------------------

  #renderPhoneme(dest, ph, t0, pitch) {
    const ctx = this.ctx;
    if (ph.type === 'voiced') {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(Math.max(40, pitch), t0);
      osc.frequency.linearRampToValueAtTime(Math.max(38, pitch * 0.94), t0 + ph.dur);
      const sum = ctx.createGain();
      sum.gain.setValueAtTime(0, t0);
      sum.gain.linearRampToValueAtTime(ph.amp, t0 + 0.008);
      sum.gain.setValueAtTime(ph.amp, Math.max(t0 + 0.008, t0 + ph.dur - 0.012));
      sum.gain.linearRampToValueAtTime(0.0005, t0 + ph.dur);
      const formantAmps = [0.9, 0.5, 0.28];
      const nodes = [osc, sum];
      for (let i = 0; i < 3; i++) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = ph.q[i];
        bp.frequency.setValueAtTime(ph.f[i], t0);
        if (ph.glideTo) bp.frequency.linearRampToValueAtTime(ph.glideTo[i], t0 + ph.dur);
        const bg = ctx.createGain(); bg.gain.value = formantAmps[i];
        osc.connect(bp); bp.connect(bg); bg.connect(sum);
        nodes.push(bp, bg);
      }
      // A light robotic AM shimmer on the envelope — sells "vocoded", not human.
      const am = ctx.createOscillator(); am.type = 'sine'; am.frequency.value = 38;
      const amGain = ctx.createGain(); amGain.gain.value = 0.3;
      am.connect(amGain); amGain.connect(sum.gain);
      sum.connect(dest);
      osc.start(t0); osc.stop(t0 + ph.dur + 0.02);
      am.start(t0); am.stop(t0 + ph.dur + 0.02);
      nodes.push(am, amGain);
      this.#addVoice(nodes, t0 + ph.dur + 0.05);
      return ph.dur;
    }

    const plosive = ph.type === 'plosive';
    this.#noise(dest, t0 - PRE_ROLL, ph.dur, {
      filterType: 'bandpass', freq: (ph.band[0] + ph.band[1]) / 2, q: 1.1, amp: ph.amp,
      attack: plosive ? 0.002 : 0.015, release: plosive ? 0.01 : ph.dur * 0.4,
    });
    if (ph.voicedTail) {
      this.#renderPhoneme(dest, { type: 'voiced', f: ph.voicedTail.f, q: [7, 6, 5], dur: ph.voicedTail.dur, amp: 0.35 }, t0 + ph.dur * 0.6, pitch);
    }
    return ph.dur + (plosive ? 0.015 : 0);
  }

  #speak(words) {
    if (!this.ctx) return;
    this.#duck(0.5, 0.02, 0.6);
    let t = this.ctx.currentTime + 0.03;
    let pitch = 92;
    for (const w of words) {
      const seq = WORDS[w];
      if (!seq) continue;
      for (const id of seq) {
        const ph = PHONEMES[id];
        const dur = this.#renderPhoneme(this.announcerBus, ph, t, pitch);
        t += dur * 1.05;
        pitch -= 1.2;
      }
      t += 0.09;
    }
  }

  #announceRound() {
    const label = this._roundNumber >= 3 ? 'THREE' : this._roundNumber === 2 ? 'TWO' : 'ONE';
    this.#speak(['ROUND', label]);
  }
  #announceFight() { this.#speak(['FIGHT']); }
  #announceKO() { this.#speak(['KAY', 'OH']); }

  // -------------------------------------------------------------------------
  // Bus wiring
  // -------------------------------------------------------------------------

  #wireEvents() {
    this._unsubs = [
      bus.on('hit', (p) => {
        this.#trackHealth(p.attacker); this.#trackHealth(p.defender);
        this.#bumpIntensity(0.18 + Math.min(0.4, p.damage / 40) + (p.counter ? 0.15 : 0) + Math.min(0.3, (p.comboCount - 1) * 0.05));
        this.#impact({ weight: p.move.weight, attacker: p.attacker, defender: p.defender, counter: p.counter });
        if (p.move.weight === WEIGHT.HEAVY || p.move.weight === WEIGHT.ULTRA) this.#hiss(this.sfxBus, this.ctx.currentTime, this.#voiceOf(p.attacker));
      }),
      bus.on('block', (p) => {
        this.#trackHealth(p.attacker); this.#trackHealth(p.defender);
        this.#bumpIntensity(0.08);
        this.#impact({ weight: p.move.weight, attacker: p.attacker, defender: p.defender, damped: true });
      }),
      bus.on('parry', (p) => { this.#bumpIntensity(0.3); this.#parryBell(p.defender || p.attacker); }),
      bus.on('whiff', () => this.#whoosh()),
      bus.on('launch', (p) => { this.#bumpIntensity(0.25); this.#servoWhine(p.fighter, { rise: true, dur: 0.22, big: true }); }),
      bus.on('knockdown', (p) => this.#scrape(p.fighter)),
      bus.on('wallSplat', (p) => {
        this.#bumpIntensity(0.3);
        this.#impact({ weight: WEIGHT.HEAVY, defender: p.fighter });
        this.#hiss(this.sfxBus, this.ctx.currentTime, this.#voiceOf(p.fighter));
      }),
      bus.on('groundImpact', (p) => { this.#trackHealth(p.fighter); if (p.speed > 2.5) this.#bodySlam(p.fighter, p.speed); }),
      bus.on('footstep', (p) => { this.#trackHealth(p.fighter); this.#footstep(p.fighter, p.force); }),
      bus.on('dash', (p) => this.#servoWhine(p.fighter, { rise: p.dir >= 0, dur: 0.12, quick: true })),
      bus.on('jump', (p) => this.#servoWhine(p.fighter, { rise: true, dur: 0.16 })),
      bus.on('meterFull', (p) => this.#meterChime(p.fighter)),
      bus.on('superStart', (p) => { this.#bumpIntensity(0.5); this.#servoWhine(p.fighter, { rise: true, dur: 0.6, big: true }); }),
      bus.on('armorAbsorb', (p) => { this.#trackHealth(p.fighter); this.#hiss(this.sfxBus, this.ctx.currentTime, this.#voiceOf(p.fighter), 0.6); }),
      bus.on('partBreak', (p) => this.#partBreakSfx(p.fighter)),
      bus.on('comboEnd', (p) => { if (p.hits >= 3) this.#bumpIntensity(0.1); }),
      bus.on('hitstop', (p) => { if (p.ticks >= 10) this.#hitstopFlourish(p.ticks); }),
      bus.on('roundStart', (p) => { this._roundNumber = p.round; this._intensity = 0; }),
      // `phase` isn't in Bus.js's own documented event list, but Game.js's
      // `setPhase()` emits it on every transition — it's the only signal that
      // tells us when to announce ROUND/FIGHT/K.O.
      bus.on('phase', (p) => {
        if (p.phase === 'ready') this.#announceRound();
        else if (p.phase === 'fight') this.#announceFight();
        else if (p.phase === 'ko') this.#announceKO();
      }),
      bus.on('matchEnd', () => this.#stinger()),
    ];
  }
}
