/**
 * Knockbots — telemetry.
 *
 * Answers the question page views cannot: did anyone actually *play*? A visit
 * that bounces on the loading screen and a visit that goes ten rounds are the
 * same pageview, so the interesting signal is entirely in the custom events
 * below — match started, character chosen, round decided, match finished, and
 * how long any of it lasted.
 *
 * Three rules this file holds to:
 *
 * 1. **It never breaks the game.** Every call is wrapped and every failure is
 *    swallowed. An ad blocker, a stripped `navigator`, an offline load or a
 *    plan that does not accept custom events must all degrade to silence, not
 *    to an exception in the middle of a fight.
 * 2. **It stays out of the instrument.** The capture harness drives thousands
 *    of scripted matches through `window.KB`; if those were reported, the
 *    numbers would be almost entirely this project measuring itself. Headless
 *    and localhost are excluded, and so is any session where the test harness
 *    has been touched.
 * 3. **It sends no personal data.** Character ids, round numbers, durations and
 *    outcomes. No inputs, no identifiers, and nothing free-text.
 *
 * Custom events (`track`) require a Vercel plan above Hobby. On Hobby they are
 * accepted and dropped, which is why page views are wired independently — the
 * "was it opened at all" signal keeps working either way.
 */

import { bus } from './Bus.js';

/** Coarse buckets, so a duration is never a fingerprint. */
const bucket = (s) => (s < 30 ? '0-30s' : s < 120 ? '30-120s' : s < 300 ? '2-5m' : s < 900 ? '5-15m' : '15m+');

export class Telemetry {
  constructor() {
    this.enabled = false;
    this.track = null;
    this.matchStartedAt = 0;
    this.rounds = 0;
    this.matches = 0;
    this.hits = 0;
    this._unsubs = [];
  }

  /**
   * Decide whether to report at all, then wire up.
   *
   * Deliberately synchronous in its decision and asynchronous in its loading:
   * the scripts are imported lazily so a blocked or missing bundle cannot delay
   * first paint on a page whose whole job is to start rendering quickly.
   */
  async init() {
    if (!this.#shouldReport()) return this;

    try {
      const [{ inject, track }, { injectSpeedInsights }] = await Promise.all([
        import('@vercel/analytics'),
        import('@vercel/speed-insights'),
      ]);
      inject();
      injectSpeedInsights();
      this.track = track;
      this.enabled = true;
    } catch {
      return this; // blocked, offline, or stripped — stay silent
    }

    this.#wire();
    return this;
  }

  /**
   * Report only from a real player's browser.
   *
   * The capture harness runs headless Chromium against localhost and plays
   * thousands of matches per round. Counting those would drown the handful of
   * real sessions this is meant to measure, and would make every number a
   * measurement of the measuring.
   */
  #shouldReport() {
    try {
      if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
      if (navigator.webdriver) return false;                       // automation
      if (/HeadlessChrome/i.test(navigator.userAgent || '')) return false;
      const h = location.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return false;
      if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return false;
      return true;
    } catch {
      return false;
    }
  }

  /** Fire-and-forget; a telemetry failure must never surface to the player. */
  #send(name, props) {
    if (!this.enabled || !this.track) return;
    try { this.track(name, props); } catch { /* silent by design */ }
  }

  #wire() {
    const on = (evt, fn) => this._unsubs.push(bus.on(evt, fn));

    on('phase', ({ phase }) => {
      if (phase === 'select') this.#send('select_opened');
      if (phase === 'fight' && !this.matchStartedAt) {
        this.matchStartedAt = Date.now();
        this.rounds = 0;
        this.hits = 0;
        this.#send('match_started', this.#roster());
      }
    });

    // Hit count is the cheapest proxy for "did they engage or just watch".
    on('hit', () => { this.hits++; });

    on('roundEnd', ({ winner }) => {
      this.rounds++;
      this.#send('round_end', { round: this.rounds, winner: winner === 0 ? 'p1' : 'p2' });
    });

    on('matchEnd', ({ winner }) => {
      const secs = Math.round((Date.now() - this.matchStartedAt) / 1000);
      this.matches++;
      this.#send('match_end', {
        winner: winner === 0 ? 'p1' : 'p2',
        rounds: this.rounds,
        hits: this.hits,
        duration: bucket(secs),
        ...this.#roster(),
      });
      this.matchStartedAt = 0;
    });

    // One summary per session, on the way out. `pagehide` rather than
    // `beforeunload`: it is the event that actually fires on mobile Safari,
    // where a backgrounded tab is frozen and never "unloads".
    const summary = () => {
      if (!this._summarised) {
        this._summarised = true;
        this.#send('session_end', { matches: this.matches, hits: this.hits });
      }
    };
    window.addEventListener('pagehide', summary, { once: true });
  }

  /** Which machines are in play, if the game has got that far. */
  #roster() {
    try {
      const f = window.KB?.fighters;
      if (!f || !f[0]?.def) return {};
      return { p1: f[0].def.id, p2: f[1]?.def?.id ?? 'none' };
    } catch {
      return {};
    }
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* already gone */ } }
    this._unsubs.length = 0;
  }
}
