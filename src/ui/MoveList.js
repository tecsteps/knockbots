/**
 * Knockbots — the in-game move list.
 *
 * The problem this exists to solve, stated plainly: **a move nobody can
 * discover does not exist.** Round 30 adds per-character specials and a
 * robot-specific finisher on top of ~195 archetype moves, and every one of them
 * is reachable only by an input sequence. If the player cannot find out what
 * those sequences are from inside the game, the work is invisible and the
 * character is, mechanically, whatever four buttons they happened to mash.
 *
 * So this screen is not documentation. It is the surface that makes the rest of
 * the round real.
 *
 * ---------------------------------------------------------------------------
 * Built against the data, never against a list
 *
 * Three agents landed this round in parallel and none of them knew the others'
 * move ids. Nothing here names a move, a character or a special. The panel asks
 * `movesFor(def.id)` for whatever that machine can actually do and renders what
 * comes back, so it is correct however the other two workstreams landed — and
 * stays correct when moves are added next round.
 *
 * `docs/CONTRACT-character-moves.md` pins the shape:
 *   - `movesFor(charId)` returns the archetype set with the character's overlay
 *     merged over it;
 *   - `move.owner === charId` marks a signature move;
 *   - `move.tag === 'finisher'` marks the finisher, and
 *     `move.props.finisher.condition` / `.sequenceText` are display-ready
 *     strings;
 *   - `move.desc` is one line of plain English, present on character moves and
 *     explicitly optional on the pre-existing archetype ones.
 *
 * Every one of those is read defensively anyway. `movesFor` may not exist yet in
 * the tree this file is running in; `owner` may be missing on a move that is
 * plainly not in the base archetype table. Where the contract is met the panel
 * uses it; where it is not, the fallbacks below derive the same answer from the
 * tables themselves, so the screen is never wrong and never empty.
 *
 * ---------------------------------------------------------------------------
 * Three editorial decisions worth defending
 *
 * **Signature moves are printed first, and labelled.** The player asked to be
 * able to learn what their robot does that no other robot does. A flat list
 * sorted by input — which is what a real command list is — buries exactly that.
 * So the tiering is explicit: SIGNATURE (this machine only), FRAME (its
 * archetype), and the shared core, in that order.
 *
 * **The finisher gets a card, not a row, and the card states its condition.**
 * A finisher is gated, and an input the player cannot currently trigger reads
 * as a broken move. `condition` is rendered verbatim from the move data —
 * the finisher system owns the wording of its own rule, and the UI paraphrasing
 * it is how the two drift apart.
 *
 * **Nothing prints raw notation.** See `Notation.js`. `qcf+2` never reaches the
 * screen; `↓ ↘ → + K` and "Roll down to forward, then Right punch" do.
 *
 * ---------------------------------------------------------------------------
 * Cost
 *
 * The panel is built when it opens and cached per (character, input scheme).
 * It subscribes to nothing, runs no timers, and touches no state during a
 * fight — the game holds 60.2fps with no headroom and a move list that costs
 * frame time is a move list that has to be deleted.
 *
 * On a 390px-tall phone in landscape it is a full-screen modal above
 * `TouchControls` (see the `kbs-layer` note in MenuSystem), with the legend
 * folded into the top of the scrolling body rather than a fixed header, because
 * a fixed header on that screen is a quarter of the list.
 */

import * as Moves from '../combat/Moves.js';
import { METER_MAX } from '../core/Constants.js';
import {
  detectScheme, keyLabels, primeKeyLabels, buttonDef, buttonLabel,
  FACING_NOTE, DIRECTION_SOURCE, guardHint, SWIPE_NOTE,
} from '../core/ControlLegend.js';
import {
  renderNotation, describeInput, needsCaption, parseInput, KBN_CSS,
} from './Notation.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** The four authored archetype tables. A move present in all four is core. */
const BASE_KEYS = ['standard', 'heavy', 'agile', 'technical'];

/**
 * The move module, read through a call rather than as `Moves.movesFor` directly.
 *
 * The contract pins `movesFor`, but this file has to build and run in a tree
 * where the agent that owns `Moves.js` has not landed it yet — that is the
 * whole point of the fallback chain in `tableFor`. A bundler that can see the
 * export is currently missing folds the reference to `undefined` and warns
 * IMPORT_IS_UNDEFINED on a branch that is deliberately optional, which turns an
 * intentional feature check into build noise somebody will eventually "fix" by
 * deleting it. Going through a call the bundler cannot fold keeps the check
 * honest at runtime and the build quiet, and costs one property load per open.
 */
const movesApi = () => Moves;

// ---------------------------------------------------------------------------
// Resolving a character's real move table
// ---------------------------------------------------------------------------

/**
 * The set of moves this machine actually fights with.
 *
 * `movesFor` is the contract's only supported accessor and is tried first. It
 * may legitimately not exist — this file has to run in a tree where the move
 * agent has not landed yet — so the fallback chain walks back through a
 * per-character table, then the archetype the roster points at, then the
 * default set. Every branch returns something renderable.
 *
 * @param {Object} def roster entry
 * @returns {{ table: Object, key: string }}
 */
export function tableFor(def) {
  const id = def?.id;
  const api = movesApi();
  if (typeof api.movesFor === 'function' && id) {
    try {
      const t = api.movesFor(id);
      if (t && Object.keys(t).length) return { table: t, key: id };
    } catch {
      // A throw here means the move agent's merge is mid-flight. The archetype
      // table below is always a truthful subset, never a wrong answer.
    }
  }
  const M = Moves.MOVES || {};
  if (id && M[id]) return { table: M[id], key: id };
  if (def?.moveSet && M[def.moveSet]) return { table: M[def.moveSet], key: def.moveSet };
  return { table: M.standard || {}, key: 'standard' };
}

/**
 * The archetype table a character's set is built on top of.
 *
 * Three answers in order of authority, and the first two are facts rather than
 * inferences: the move module names it (`baseMovesFor`), the roster entry names
 * it (`moveBase`), or — for a tree where neither has landed — it is recovered
 * by overlap, on the grounds that the archetype sharing the most move ids with
 * the character's table is the one it was built from. The overlap branch is
 * exact in practice (an overlay of 3 moves over 52 leaves all 52 shared against
 * ~37 for any other archetype) and needs no coordination with anybody.
 */
function baseTableFor(def, table) {
  const M = Moves.MOVES || {};
  const api = movesApi();
  if (typeof api.baseMovesFor === 'function' && def?.id) {
    try {
      const t = api.baseMovesFor(def.id);
      if (t && Object.keys(t).length) return t;
    } catch { /* fall through to the roster field */ }
  }
  if (def?.moveBase && M[def.moveBase]) return M[def.moveBase];
  if (def?.moveSet && BASE_KEYS.includes(def.moveSet)) return M[def.moveSet] || null;
  const ids = new Set(Object.keys(table));
  let best = null;
  let bestScore = -1;
  for (const k of BASE_KEYS) {
    const t = M[k];
    if (!t) continue;
    let score = 0;
    for (const id of Object.keys(t)) if (ids.has(id)) score++;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** Move ids present in every one of the four archetype tables: the shared core. */
let CORE_IDS = null;
function coreIds() {
  if (CORE_IDS) return CORE_IDS;
  const M = Moves.MOVES || {};
  const tables = BASE_KEYS.map((k) => M[k]).filter(Boolean);
  CORE_IDS = new Set();
  if (!tables.length) return CORE_IDS;
  for (const id of Object.keys(tables[0])) {
    if (tables.every((t) => t[id])) CORE_IDS.add(id);
  }
  return CORE_IDS;
}

/**
 * signature | frame | core.
 *
 * Three independent ways of answering the same question, because three agents
 * wrote the three halves of it: the move's own `owner` field (the pinned
 * contract), the roster entry's `signatureMoves` id list, and — for anything
 * that carries neither — the observation that a move absent from the base
 * archetype table can only have come from the character's own overlay.
 *
 * They agree today. They are all here because the one that is authoritative
 * changed twice during the round this was written, and a screen whose whole
 * purpose is "which of these belong to my robot" must not go blank because a
 * field was renamed.
 */
function tierOf(move, def, base, own) {
  if (move.owner) return move.owner === def?.id ? 'signature' : 'frame';
  if (own?.has(move.id)) return 'signature';
  if (base && !base[move.id]) return 'signature';
  return coreIds().has(move.id) ? 'core' : 'frame';
}

// ---------------------------------------------------------------------------
// Reading a move
// ---------------------------------------------------------------------------

/** Frame advantage, whichever field carries it. */
function advOf(m) {
  return {
    block: m.onBlock ?? m.adv?.block ?? null,
    hit: m.onHit ?? m.adv?.hit ?? null,
  };
}

/**
 * What blocking this costs, in words a beginner can act on.
 *
 * The thresholds are the ones the move tables were balanced against: the
 * fastest normal in the game is i9..i12, so anything -10 or worse can be
 * punished by a jab before you have moved, and anything non-negative leaves you
 * acting first.
 */
function blockVerdict(onBlock) {
  if (onBlock == null) return null;
  if (onBlock >= 0) return { key: 'plus', label: 'YOUR TURN', note: 'You act first even when it is blocked.' };
  if (onBlock <= -10) return { key: 'bad', label: 'PUNISHABLE', note: 'Blocked, they get a free hit. Only use it when it will land.' };
  return { key: 'ok', label: 'SAFE', note: 'Blocked, neither of you has a clear turn.' };
}

const HEIGHT_NOTE = {
  high: 'Blocked standing. Ducks under it if they crouch.',
  mid: 'Must be blocked standing. Beats crouching.',
  low: 'Must be blocked crouching.',
  unblockable: 'Cannot be blocked at all. Move, or interrupt it.',
};

/**
 * The gates on a move, derived from the fields the engine actually checks in
 * `canUse()`. Every entry here is a real requirement, not a description — which
 * is what makes it safe to print next to a finisher's authored condition.
 */
function gatesOf(m) {
  const out = [];
  const p = m.props || {};
  // `note` is authored and already says "100 meter" on the moves that cost it,
  // so the derived gate is suppressed rather than printed beside it — the same
  // requirement stated twice in two vocabularies reads as two requirements.
  const noteHasMeter = /meter|overdrive/i.test(m.note || '');
  if (m.meterCost > 0 && !noteHasMeter) {
    out.push(m.meterCost >= METER_MAX ? 'Overdrive gauge full' : `${m.meterCost} overdrive`);
  }
  if (p.requireCrouch) out.push('While crouching');
  if (p.requireAir) out.push('In the air');
  // A stance id starting with an underscore is an engine state the player is
  // put into, not one they can enter — the finisher's `__finisher` gate is the
  // live example. Printing it leaks an internal token into a sentence a
  // beginner is meant to act on, and the rule it stands for is already stated
  // in words by the finisher's own `condition`.
  if (p.requireStance && !p.requireStance.startsWith('_')) {
    out.push(`In ${prettyStance(p.requireStance)} stance`);
  }
  if (m.counterOnly) out.push('Counter hit only');
  return out;
}

/** `crouchDash` -> `crouch dash`. Stance ids are code names; this is a label. */
function prettyStance(id) {
  return String(id).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

/** The authored one-liner, if the move has one. Optional by contract. */
function descOf(m) {
  const d = m.desc || m.description || m.props?.finisher?.desc;
  return typeof d === 'string' && d.trim() ? d.trim() : '';
}

/** Everything the row template needs, flattened once. */
function rowModel(m, def, base, own) {
  const adv = advOf(m);
  return {
    id: m.id,
    name: m.name || m.id,
    input: m.input || '',
    tier: tierOf(m, def, base, own),
    height: m.height || 'mid',
    damage: m.damage ?? 0,
    startup: m.startup ?? null,
    onBlock: adv.block,
    onHit: adv.hit,
    verdict: blockVerdict(adv.block),
    note: m.note || '',
    desc: descOf(m),
    gates: gatesOf(m),
    tag: m.tag || '',
    followUp: !!m.followUp,
    meterCost: m.meterCost || 0,
    isThrow: m.tag === 'throw' || !!m.props?.throw,
    isSuper: m.tag === 'super' || !!m.props?.super,
    move: m,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Where a move goes. First match wins, and the order is the order a player
 * learns a character in: what makes this machine different, then how it opens
 * you up, then the shared vocabulary, split by the stance you are in when you
 * press the button.
 *
 * The standing/crouching/jumping split is not cosmetic. Round 30 made all four
 * buttons do something in all three stances — twelve moves per archetype that
 * previously did not exist — and three labelled sections is how a player finds
 * out that is true.
 */
const SECTIONS = [
  { id: 'signature', title: 'Signature', note: 'This machine and no other.' },
  { id: 'throws', title: 'Throws', note: 'Beat a block outright. Broken by pressing the matching limb.' },
  { id: 'overdrive', title: 'Overdrive', note: 'Costs gauge. The gauge fills as you deal and take damage.' },
  { id: 'frame', title: 'Frame', note: '' },
  { id: 'standing', title: 'Standing', note: '' },
  { id: 'crouching', title: 'Crouching', note: 'Hold ↓ first.' },
  { id: 'jumping', title: 'Jumping', note: 'Hold ↑ first.' },
  { id: 'strings', title: 'Strings', note: 'Continuations. Press the next input while the first is still swinging.' },
];

function sectionOf(row) {
  if (row.tier === 'signature') return 'signature';
  if (row.isThrow) return 'throws';
  if (row.meterCost > 0 || row.isSuper) return 'overdrive';
  if (row.followUp) return 'strings';
  if (row.tier === 'frame') return 'frame';
  const first = parseInput(row.input)[0];
  const dir = first?.dir || '';
  if (row.move.props?.requireAir || dir === 'u' || dir === 'uf' || dir === 'ub') return 'jumping';
  if (row.move.props?.requireCrouch || dir === 'd' || dir === 'df' || dir === 'db') return 'crouching';
  return 'standing';
}

/**
 * Build the whole renderable model for one roster character.
 *
 * Pure — no DOM, no globals — so it is testable from the harness and so the
 * panel can be rebuilt from it without re-deriving anything.
 *
 * @param {Object} def roster entry
 */
export function moveModelFor(def) {
  const { table, key } = tableFor(def);
  const base = baseTableFor(def, table);
  // The roster's own list of a machine's exclusive moves, as a set. One of the
  // three signals `tierOf` cross-checks; see the note there.
  const own = new Set(def?.signatureMoves || []);
  const label = table.__label || Moves.MOVE_SET_LABELS?.[key] || key;

  const all = Object.values(table).filter((m) => m && m.id && m.input);
  // A list rather than one, even though the contract says a machine has one
  // finisher. Taking only the first would silently demote a second one into an
  // ordinary row, where its trigger condition — the one thing a finisher cannot
  // be used without — would never be printed at all.
  const finishers = [];
  const rows = [];
  for (const m of all) {
    if (m.tag === 'finisher' || m.props?.finisher) { finishers.push(rowModel(m, def, base, own)); continue; }
    rows.push(rowModel(m, def, base, own));
  }

  // Inside a section: cheapest to throw first. Startup is the number that
  // decides whether a move is usable in a given situation, so it is the number
  // the list is ordered on — not the input string, which orders by an alphabet
  // the player cannot see.
  rows.sort((a, b) => (a.startup ?? 99) - (b.startup ?? 99) || a.name.localeCompare(b.name));

  const buckets = new Map(SECTIONS.map((s) => [s.id, []]));
  for (const r of rows) buckets.get(sectionOf(r)).push(r);

  const sections = SECTIONS
    .map((s) => ({
      ...s,
      title: s.id === 'frame' ? `${label} frame` : s.title,
      note: s.id === 'frame' ? `Shared by every ${label}-class machine.` : s.note,
      rows: buckets.get(s.id),
    }))
    .filter((s) => s.rows.length);

  return {
    def,
    setKey: key,
    label,
    finishers,
    sections,
    total: rows.length + finishers.length,
    signatureCount: rows.filter((r) => r.tier === 'signature').length + finishers.length,
  };
}

/**
 * The finisher's trigger rule, as lines to print.
 *
 * `condition` is rendered verbatim — the finisher system owns the wording of
 * its own rule and the UI restating it is how the two drift apart. The rest is
 * derived only where the authored field is absent, and `window` is converted
 * to seconds because ticks are an engine unit and nobody counts in sixtieths.
 */
export function finisherRule(row) {
  if (!row) return [];
  const f = row.move.props?.finisher || {};
  const lines = [];
  if (typeof f.condition === 'string' && f.condition.trim()) {
    lines.push(f.condition.trim());
  } else if (typeof f.healthPct === 'number') {
    lines.push(`Opponent below ${Math.round(f.healthPct * 100)}% health`);
    if (f.finalRoundOnly) lines.push('Final round only');
  }
  if (typeof f.window === 'number' && f.window > 0) {
    lines.push(`You have ${(f.window / 60).toFixed(1)}s to enter it once the window opens`);
  }
  // Meter is stated here even when `gatesOf` suppressed it as a duplicate of the
  // move's note: the card does not print the note, and a cost the player cannot
  // see is a cost that reads as the move being broken.
  if (row.meterCost > 0) {
    lines.push(row.meterCost >= METER_MAX ? 'Overdrive gauge full' : `${row.meterCost} overdrive gauge`);
  }
  for (const g of row.gates) if (!lines.includes(g)) lines.push(g);
  return lines;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * A self-contained modal move list.
 *
 * Owns its DOM, its stylesheet and its own key handling. The host (MenuSystem)
 * only has to construct it once, call `open(def)`, and ask `isOpen` before
 * acting on its own Escape.
 */
export class MoveListPanel {
  /** @param {HTMLElement} host element the modal mounts into */
  constructor(host) {
    this.host = host;
    this.root = null;
    this.isOpen = false;
    this._cacheKey = '';
    this._onClose = null;
    this._returnFocus = null;
    this._tab = 'all';
    this._onKey = (e) => this.#key(e);
    MoveListPanel.installStyles();
  }

  /**
   * Show the list for a character.
   * @param {Object} def roster entry
   * @param {{ onClose?: Function, returnFocus?: HTMLElement }} [opts]
   */
  open(def, opts = {}) {
    if (!def) return;
    this._onClose = opts.onClose || null;
    this._returnFocus = opts.returnFocus || null;
    // The layout query is async and the panel opens on a keypress. Priming here
    // costs nothing if it already resolved at boot, and means a player who
    // opens the list before the legend ever rendered still gets their own caps
    // the next time they open it.
    primeKeyLabels();

    const scheme = detectScheme();
    const key = `${def.id}|${scheme}|${keyLabels().size}`;
    if (!this.root) this.#build();
    if (key !== this._cacheKey) {
      this._cacheKey = key;
      this.#fill(def, scheme);
    }
    this.root.hidden = false;
    // Reflow between `hidden` and the class is what makes the entry animation
    // play on the second open as well as the first.
    void this.root.offsetWidth;
    this.root.classList.add('kbm--on');
    this.isOpen = true;
    // Removed before added so a second `open()` without an intervening `close()`
    // cannot register the handler twice — which would step the tab strip two
    // places on one arrow press. `removeEventListener` on an unregistered
    // listener is a no-op, so this is free on the normal path.
    window.removeEventListener('keydown', this._onKey, true);
    window.addEventListener('keydown', this._onKey, true);
    this.body.scrollTop = 0;
    this.closeBtn?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('kbm--on');
    this.root.hidden = true;
    window.removeEventListener('keydown', this._onKey, true);
    const back = this._returnFocus;
    this._onClose?.();
    this._onClose = null;
    this._returnFocus = null;
    back?.focus?.({ preventScroll: true });
  }

  toggle(def, opts) { this.isOpen ? this.close() : this.open(def, opts); }

  /**
   * The panel owns the keyboard while it is up.
   *
   * Captured, and stopped, because the host menu's own handler treats the arrow
   * keys as a focus walk over a screen the player can no longer see — a list
   * that scrolls the menu behind it instead of itself is worse than one that
   * does not scroll at all.
   */
  #key(e) {
    if (!this.isOpen) return;
    switch (e.code) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation(); this.close(); break;
      case 'ArrowLeft':
        e.preventDefault(); e.stopPropagation(); this.#stepTab(-1); break;
      case 'ArrowRight':
        e.preventDefault(); e.stopPropagation(); this.#stepTab(1); break;
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); this.body.scrollBy({ top: -120, behavior: 'smooth' }); break;
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); this.body.scrollBy({ top: 120, behavior: 'smooth' }); break;
      case 'PageUp':
        e.preventDefault(); this.body.scrollBy({ top: -this.body.clientHeight * 0.85, behavior: 'smooth' }); break;
      case 'PageDown':
        e.preventDefault(); this.body.scrollBy({ top: this.body.clientHeight * 0.85, behavior: 'smooth' }); break;
      default: break;
    }
  }

  #stepTab(dir) {
    const ids = this._tabIds || [];
    if (ids.length < 2) return;
    const i = Math.max(0, ids.indexOf(this._tab));
    this.#setTab(ids[(i + dir + ids.length) % ids.length]);
  }

  // -- construction -----------------------------------------------------------

  #build() {
    const root = el('div', 'kbm');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Move list');

    const scrim = el('div', 'kbm-scrim');
    scrim.addEventListener('click', () => this.close());

    const panel = el('div', 'kbm-panel');

    const head = el('div', 'kbm-head');
    const titles = el('div', 'kbm-titles');
    this.eyebrow = el('div', 'kbm-eyebrow', 'MOVE LIST');
    this.name = el('div', 'kbm-name', '—');
    this.sub = el('div', 'kbm-sub', '');
    titles.append(this.eyebrow, this.name, this.sub);

    this.closeBtn = el('button', 'kbm-close', 'CLOSE');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close move list');
    this.closeBtn.addEventListener('click', () => this.close());
    head.append(titles, this.closeBtn);

    this.tabs = el('div', 'kbm-tabs');
    this.tabs.setAttribute('role', 'tablist');

    this.body = el('div', 'kbm-body');
    this.body.tabIndex = 0;

    panel.append(head, this.tabs, this.body);
    root.append(scrim, panel);
    this.host.appendChild(root);
    this.root = root;
  }

  // -- content ----------------------------------------------------------------

  #fill(def, scheme) {
    const model = moveModelFor(def);
    const labels = keyLabels();
    const accent = def.palette?.accent || '#ff8a2a';
    this.root.style.setProperty('--kbm-c', accent);

    this.name.textContent = def.name || def.id;
    const bits = [`${model.label} class`, `${model.total} moves`];
    if (model.signatureCount) bits.push(`${model.signatureCount} signature`);
    this.sub.textContent = bits.join(' · ');

    // -- tabs ----------------------------------------------------------------
    const tabDefs = [{ id: 'all', label: 'ALL', count: model.total }];
    if (model.finishers.length) tabDefs.push({ id: 'finisher', label: 'FINISHER', count: model.finishers.length });
    for (const s of model.sections) tabDefs.push({ id: s.id, label: s.title.toUpperCase(), count: s.rows.length });
    this._tabIds = tabDefs.map((t) => t.id);
    this._tabEls = {};
    this.tabs.replaceChildren(...tabDefs.map((t) => {
      const b = el('button', 'kbm-tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.append(el('span', null, t.label), el('i', null, String(t.count)));
      b.addEventListener('click', () => this.#setTab(t.id));
      this._tabEls[t.id] = b;
      return b;
    }));

    // -- body ----------------------------------------------------------------
    const frag = document.createDocumentFragment();
    frag.append(this.#legend(scheme, labels));
    for (const f of model.finishers) frag.append(this.#finisherCard(f, scheme, labels));
    for (const s of model.sections) frag.append(this.#section(s, scheme, labels));
    this.body.replaceChildren(frag);

    this.#setTab('all');
  }

  /**
   * How to read the screen.
   *
   * Folded into the top of the scrolling body rather than pinned to the header:
   * on a 390px-tall handset in landscape the body is about 280px, and a legend
   * that permanently owned 60 of them would cost a fifth of the list to say
   * something the player needs once.
   *
   * Even that was too much. The four button chips stay open, because they are
   * the key to every glyph below and they cost one line — but the six sentences
   * of prose go in a `<details>`, shut on a short screen and open on a tall one.
   * Native rather than scripted so it is keyboard- and screen-reader-correct for
   * free, and so its state survives a rebuild without being tracked.
   */
  #legend(scheme, labels) {
    const box = el('section', 'kbm-sec kbm-sec--legend');
    box.dataset.sec = 'legend';
    box.append(this.#secHead('How to read this', ''));

    const btns = el('div', 'kbm-legend-btns');
    for (const b of [1, 2, 3, 4]) {
      const def = buttonDef(b);
      const item = el('div', 'kbm-legend-btn');
      const c = el('span', `kbn-btn kbn-btn--${def.kind}`);
      c.append(el('b', null, buttonLabel(b, scheme, labels)), el('i', null, def.limb));
      item.append(c, el('span', null, def.label));
      btns.append(item);
    }
    box.append(btns);

    const notes = el('ul', 'kbm-legend-notes');
    const line = (t) => { const li = el('li', null, t); notes.append(li); return li; };
    line(FACING_NOTE);
    line(`Directions come from the ${DIRECTION_SOURCE[scheme] || 'movement keys'}.`);
    // All four swipes, not just the forward one: a key that teaches one of the
    // four shortcuts leaves the player believing the other three do not exist.
    if (scheme === 'touch') line(SWIPE_NOTE);
    line(guardHint(scheme, labels));
    line('SPEED is how many frames before it hits — lower is faster. 60 frames is one second.');
    line('ON BLOCK is what happens if they guard it: a minus number means they move first.');

    const det = el('details', 'kbm-legend-more');
    // Open above the short-screen breakpoint, which is the same 560px line the
    // stylesheet below switches the whole panel on.
    det.open = !(typeof matchMedia === 'function' && matchMedia('(max-height: 560px)').matches);
    det.append(el('summary', null, 'Arrows, blocking and the numbers'), notes);
    box.append(det);
    return box;
  }

  #secHead(title, note) {
    const h = el('div', 'kbm-sec-head');
    h.append(el('h3', null, title));
    if (note) h.append(el('p', null, note));
    return h;
  }

  /**
   * The finisher card.
   *
   * Its own treatment because it is the only move in the game with a trigger
   * condition, and a gated input that the player cannot make happen reads as a
   * bug rather than as a lock. The condition is therefore the largest text in
   * the card after the name.
   */
  #finisherCard(row, scheme, labels) {
    const sec = el('section', 'kbm-sec kbm-sec--fin');
    sec.dataset.sec = 'finisher';
    const card = el('div', 'kbm-fin');

    const head = el('div', 'kbm-fin-head');
    head.append(el('span', 'kbm-fin-tag', 'FINISHER'), el('span', 'kbm-fin-name', row.name));
    card.append(head);

    if (row.desc) card.append(el('p', 'kbm-fin-desc', row.desc));

    const rule = finisherRule(row);
    const cond = el('div', 'kbm-fin-cond');
    cond.append(el('span', 'kbm-fin-cond-h', 'ONLY AVAILABLE WHEN'));
    if (rule.length) {
      const ul = el('ul');
      for (const r of rule) ul.append(el('li', null, r));
      cond.append(ul);
    } else {
      // Honest rather than invented: the panel will not make up a rule the
      // finisher system did not publish. If this line is ever on screen it is a
      // bug in the move data, and saying so is how it gets found.
      cond.append(el('p', 'kbm-fin-cond-missing',
        'This finisher publishes no trigger condition. Report it — it cannot be learned.'));
    }
    card.append(cond);

    const seq = el('div', 'kbm-fin-seq');
    seq.append(el('span', 'kbm-fin-cond-h', 'INPUT'));
    seq.append(renderNotation(row.input, { scheme, labels }));
    const text = row.move.props?.finisher?.sequenceText || describeInput(row.input, { scheme });
    seq.append(el('p', 'kbm-fin-seq-text', text));
    card.append(seq);

    card.append(this.#stats(row, true));
    sec.append(card);
    return sec;
  }

  #section(s, scheme, labels) {
    const sec = el('section', 'kbm-sec');
    sec.dataset.sec = s.id;
    sec.append(this.#secHead(s.title, s.note));
    const list = el('ul', 'kbm-rows');
    for (const r of s.rows) list.append(this.#row(r, scheme, labels));
    sec.append(list);
    return sec;
  }

  #row(r, scheme, labels) {
    const li = el('li', 'kbm-row');
    li.dataset.tier = r.tier;

    const name = el('div', 'kbm-row-name');
    name.append(el('b', null, r.name));
    if (r.tier === 'signature') name.append(el('span', 'kbm-tag kbm-tag--sig', 'SIGNATURE'));
    if (r.isThrow) name.append(el('span', 'kbm-tag kbm-tag--throw', 'THROW'));
    if (r.height === 'unblockable') name.append(el('span', 'kbm-tag kbm-tag--unb', 'UNBLOCKABLE'));
    li.append(name);

    const input = el('div', 'kbm-row-in');
    input.append(renderNotation(r.input, { scheme, labels }));
    li.append(input);

    // The caption is the whole reason a non-expert can use this screen, but it
    // is dead weight under a single button press — see `needsCaption`.
    const meta = el('div', 'kbm-row-meta');
    if (needsCaption(r.input)) meta.append(el('span', 'kbm-cap', describeInput(r.input, { scheme })));
    const extra = [r.desc, r.note, ...r.gates].filter(Boolean).join(' · ');
    if (extra) meta.append(el('span', 'kbm-note', extra));
    if (meta.childNodes.length) li.append(meta);

    li.append(this.#stats(r, false));
    return li;
  }

  /**
   * The three numbers that decide whether a move is worth pressing, plus the
   * guard height that decides whether it can be blocked at all.
   *
   * `SPEED` rather than `STARTUP` and `ON BLOCK` rather than `ADV`: the legend
   * at the top of the body explains both in a sentence, and a label a beginner
   * can guess at is worth more than the one a frame-data sheet would use.
   */
  #stats(r, big) {
    const box = el('div', `kbm-stats${big ? ' kbm-stats--big' : ''}`);
    const numCell = (label, value) => {
      const c = el('span', 'kbm-num');
      c.append(el('i', null, label), el('b', null, value));
      box.append(c);
      return c;
    };

    const h = el('span', `kbm-h kbm-h--${r.height}`, r.height.toUpperCase());
    h.title = HEIGHT_NOTE[r.height] || '';
    box.append(h);

    numCell('DMG', String(r.damage));
    if (r.startup != null) numCell('SPEED', `i${r.startup}`);
    if (r.onBlock != null && r.verdict) {
      const cell = numCell('ON BLOCK', signed(r.onBlock));
      cell.classList.add(`kbm-num--${r.verdict.key}`);
      cell.title = r.verdict.note;
      cell.append(el('u', null, r.verdict.label));
    }
    return box;
  }

  #setTab(id) {
    this._tab = id;
    for (const [k, b] of Object.entries(this._tabEls || {})) {
      const on = k === id;
      b.classList.toggle('kbm-tab--on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const sec of this.body.querySelectorAll('.kbm-sec')) {
      const s = sec.dataset.sec;
      sec.hidden = id !== 'all' && s !== id;
    }
    this.body.scrollTop = 0;
  }

  // -- styles -----------------------------------------------------------------

  static installStyles() {
    if (document.getElementById('kbm-style')) return;
    const style = document.createElement('style');
    style.id = 'kbm-style';
    style.textContent = KBN_CSS + KBM_CSS;
    document.head.appendChild(style);
  }
}

function signed(n) { return `${n > 0 ? '+' : ''}${n}`; }

/**
 * Move-list stylesheet, namespaced `kbm-`.
 *
 * Reads the shared `--kb-*` tokens and defines none of its own beyond
 * `--kbm-c`, the focused machine's accent. Same three rules as the select
 * screen: no full-screen animation, no `mix-blend-mode`, and every transition
 * on transform or opacity.
 */
const KBM_CSS = `
.kbm {
  position: absolute; inset: 0;
  z-index: 60;                     /* above .kbs-layer (41) and the touch pad (40) */
  font-size: clamp(13px, 1.05vw, 30px);
  --kbm-c: #ff8a2a;
  pointer-events: auto;
}
.kbm[hidden] { display: none; }
.kbm-scrim { position: absolute; inset: 0; background: rgba(3,5,9,0.86); }

.kbm-panel {
  position: absolute;
  inset: calc(2.5vh + var(--kb-sa-t, 0px)) calc(4vw + var(--kb-sa-r, 0px))
         calc(2.5vh + var(--kb-sa-b, 0px)) calc(4vw + var(--kb-sa-l, 0px));
  /* Over-constrained on purpose: with both insets set and a max-width, the auto
     margins centre it. A command list that runs the full width of a 4K panel
     puts thirty centimetres of empty table between a move's name and its frame
     data, which is exactly the distance at which a row stops being one row. */
  max-width: 96em; margin-inline: auto;
  display: flex; flex-direction: column;
  background: linear-gradient(160deg, rgba(18,23,32,0.985), rgba(8,11,17,0.985));
  box-shadow: var(--kb-shadow-panel);
  clip-path: polygon(0 0, calc(100% - 1.2em) 0, 100% 1.2em, 100% 100%, 1.2em 100%, 0 calc(100% - 1.2em));
  transform: translate3d(0, 0.8em, 0); opacity: 0;
  transition: transform 0.22s cubic-bezier(.16,1,.3,1), opacity 0.18s ease;
}
.kbm--on .kbm-panel { transform: none; opacity: 1; }

/* -- header ------------------------------------------------------------------ */
.kbm-head {
  display: flex; align-items: flex-start; gap: 1em;
  padding: 0.9em 1.1em 0.7em;
  border-bottom: 1px solid var(--kb-line);
}
.kbm-titles { min-width: 0; }
.kbm-eyebrow {
  font-size: 0.55em; font-weight: 800; letter-spacing: 0.3em;
  color: var(--kb-text-faint);
}
.kbm-name {
  font-family: var(--kb-font-display);
  font-size: 1.5em; font-weight: 900; letter-spacing: 0.06em; line-height: 1.05;
  color: var(--kb-text);
}
.kbm-sub {
  font-family: var(--kb-font-mono);
  font-size: 0.58em; letter-spacing: 0.14em; color: var(--kbm-c);
}
.kbm-close {
  margin-left: auto; flex: none;
  font-family: var(--kb-font-label);
  font-size: 0.6em; font-weight: 800; letter-spacing: 0.2em;
  color: var(--kb-text-dim); background: transparent;
  border: 0; cursor: pointer;
  min-height: 44px; padding: 0 1.2em;
  box-shadow: inset 0 0 0 1px var(--kb-line-strong);
  clip-path: polygon(0.5em 0, 100% 0, calc(100% - 0.5em) 100%, 0 100%);
}
.kbm-close:hover, .kbm-close:focus-visible { color: var(--kb-text); box-shadow: inset 0 0 0 1px var(--kbm-c); outline: none; }

/* -- tabs -------------------------------------------------------------------- */
.kbm-tabs {
  display: flex; gap: 0.3em; flex: none;
  padding: 0.5em 1.1em;
  overflow-x: auto; scrollbar-width: none;
  border-bottom: 1px solid var(--kb-line);
}
.kbm-tabs::-webkit-scrollbar { display: none; }
.kbm-tab {
  flex: none; display: inline-flex; align-items: center; gap: 0.45em;
  font-family: var(--kb-font-label);
  font-size: 0.56em; font-weight: 800; letter-spacing: 0.16em;
  color: var(--kb-text-faint); background: transparent; border: 0; cursor: pointer;
  min-height: 34px; padding: 0 0.9em;
  box-shadow: inset 0 0 0 1px transparent;
  transition: color 0.12s ease;
}
.kbm-tab i { font-style: normal; font-size: 0.85em; opacity: 0.6; }
.kbm-tab:hover { color: var(--kb-text-dim); }
.kbm-tab--on {
  color: var(--kb-void); background: var(--kbm-c);
  clip-path: polygon(0.5em 0, 100% 0, calc(100% - 0.5em) 100%, 0 100%);
}
.kbm-tab--on i { opacity: 0.75; }

/* -- body -------------------------------------------------------------------- */
.kbm-body {
  flex: 1; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 0.2em 1.1em 1.4em;
  scrollbar-width: thin;
}
.kbm-body:focus-visible { outline: none; }
.kbm-sec { padding-top: 1.1em; }
.kbm-sec[hidden] { display: none; }
.kbm-sec-head { display: flex; align-items: baseline; gap: 0.8em; flex-wrap: wrap; margin-bottom: 0.5em; }
.kbm-sec-head h3 {
  margin: 0;
  font-family: var(--kb-font-label);
  font-size: 0.62em; font-weight: 800; letter-spacing: 0.28em; text-transform: uppercase;
  color: var(--kbm-c);
}
.kbm-sec-head p { margin: 0; font-size: 0.56em; letter-spacing: 0.06em; color: var(--kb-text-faint); }

/* -- legend ------------------------------------------------------------------ */
.kbm-sec--legend { border-bottom: 1px solid var(--kb-line); padding-bottom: 0.9em; }
.kbm-legend-btns { display: flex; flex-wrap: wrap; gap: 0.5em 1.3em; margin-bottom: 0.6em; }
.kbm-legend-btn { display: inline-flex; align-items: center; gap: 0.45em; }
.kbm-legend-btn > span:last-child {
  font-size: 0.56em; letter-spacing: 0.1em; color: var(--kb-text-dim);
}
.kbm-legend-more > summary {
  cursor: pointer; list-style: none;
  display: inline-flex; align-items: center; gap: 0.4em;
  font-family: var(--kb-font-mono);
  font-size: 0.52em; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--kb-text-dim);
  min-height: 30px;
}
.kbm-legend-more > summary::-webkit-details-marker { display: none; }
.kbm-legend-more > summary::before { content: '+'; color: var(--kbm-c); font-size: 1.2em; line-height: 1; }
.kbm-legend-more[open] > summary::before { content: '−'; }
.kbm-legend-notes { margin: 0.2em 0 0; padding: 0; list-style: none; display: grid; gap: 0.22em; }
.kbm-legend-notes li {
  font-size: 0.56em; line-height: 1.45; letter-spacing: 0.03em; color: var(--kb-text-faint);
  padding-left: 0.9em; position: relative;
}
.kbm-legend-notes li::before {
  content: ''; position: absolute; left: 0; top: 0.55em;
  width: 0.35em; height: 1px; background: var(--kb-line-strong);
}

/* -- rows -------------------------------------------------------------------- */
.kbm-rows { margin: 0; padding: 0; list-style: none; display: grid; gap: 1px; }
/* Three columns, because this is a table and reads as one: what the move is
   called, what you press, what it is worth. The caption runs under the first
   two and the numbers span both rows, so a row is one visual block however
   many lines its caption needs. */
.kbm-row {
  display: grid;
  grid-template-columns: minmax(8em, 1fr) minmax(10em, 1.1fr) auto;
  grid-template-areas: "name in stats" "meta meta stats";
  align-items: center;
  gap: 0.15em 1em;
  padding: 0.5em 0.7em;
  background: rgba(255,255,255,0.018);
}
.kbm-row:nth-child(2n) { background: rgba(255,255,255,0.038); }
/* The one tier that gets a spine. Signature moves are the answer to the
   question this screen exists to answer, and they have to be findable while
   scrolling past at speed rather than only by reading the chip. */
.kbm-row[data-tier="signature"] { box-shadow: inset 0.2em 0 0 var(--kbm-c); }
.kbm-row-name { grid-area: name; display: flex; align-items: baseline; gap: 0.5em; flex-wrap: wrap; }
.kbm-row-name b {
  font-family: var(--kb-font-label);
  font-size: 0.72em; font-weight: 800; letter-spacing: 0.08em; color: var(--kb-text);
}
.kbm-row-in { grid-area: in; font-size: 0.86em; margin: 0.12em 0; }
.kbm-row-meta { grid-area: meta; display: flex; flex-wrap: wrap; gap: 0.2em 0.7em; }
.kbm-cap { font-size: 0.55em; letter-spacing: 0.03em; color: var(--kb-text-dim); }
.kbm-note { font-size: 0.53em; letter-spacing: 0.08em; color: var(--kb-text-faint); text-transform: uppercase; }

.kbm-tag {
  font-family: var(--kb-font-mono);
  font-size: 0.45em; font-weight: 700; letter-spacing: 0.16em;
  padding: 0.25em 0.5em 0.2em;
}
.kbm-tag--sig { color: var(--kbm-c); box-shadow: inset 0 0 0 1px currentColor; }
.kbm-tag--throw { color: var(--kb-cyan); box-shadow: inset 0 0 0 1px currentColor; }
.kbm-tag--unb { color: var(--kb-danger); box-shadow: inset 0 0 0 1px currentColor; }

/* -- stats ------------------------------------------------------------------- */
/* grid-area is set by the two parents that place it, never on the base class.
   An unscoped "grid-area: stats" inside a grid with no such named line does NOT
   fall back to auto placement — it creates an implicit "stats" column, which is
   how the finisher card silently grew a second column nobody had authored.
   (No backticks anywhere in this sheet: it is a template literal.) */
.kbm-stats { display: flex; align-items: center; gap: 0.55em; }
.kbm-row > .kbm-stats { grid-area: stats; }
.kbm-h {
  font-family: var(--kb-font-mono);
  font-size: 0.5em; font-weight: 700; letter-spacing: 0.14em;
  padding: 0.3em 0.5em 0.26em;
  min-width: 4.6em; text-align: center;
}
.kbm-h--high { color: var(--kb-gold); background: rgba(255,207,74,0.13); }
.kbm-h--mid { color: var(--kb-cyan); background: rgba(63,224,255,0.13); }
.kbm-h--low { color: var(--kb-good); background: rgba(51,255,180,0.12); }
.kbm-h--unblockable { color: var(--kb-danger); background: rgba(255,59,78,0.15); }
.kbm-num { display: flex; flex-direction: column; align-items: flex-end; min-width: 3.4em; }
.kbm-num i {
  font-style: normal; font-family: var(--kb-font-mono);
  font-size: 0.4em; letter-spacing: 0.14em; color: var(--kb-text-faint);
}
.kbm-num b {
  font-family: var(--kb-font-mono);
  font-size: 0.66em; font-weight: 700; letter-spacing: 0.02em; color: var(--kb-text-dim);
}
.kbm-num u {
  text-decoration: none; font-family: var(--kb-font-mono);
  font-size: 0.38em; letter-spacing: 0.1em;
}
.kbm-num--plus b, .kbm-num--plus u { color: var(--kb-good); }
.kbm-num--ok b, .kbm-num--ok u { color: var(--kb-text-dim); }
.kbm-num--bad b, .kbm-num--bad u { color: var(--kb-danger-soft); }

/* -- finisher ---------------------------------------------------------------- */
.kbm-fin {
  padding: 0.9em 1em 1em;
  background:
    linear-gradient(150deg, rgba(255,59,78,0.1), rgba(255,138,42,0.05) 45%, transparent 70%),
    rgba(255,255,255,0.03);
  box-shadow: inset 0 0 0 1px rgba(255,59,78,0.32);
  clip-path: polygon(0 0, calc(100% - 0.9em) 0, 100% 0.9em, 100% 100%, 0.9em 100%, 0 calc(100% - 0.9em));
  /* One column by default; two where there is room, with the rule and the input
     stacked on the left and the flavour and the numbers on the right. Areas are
     named explicitly because this card is the one place in the panel where the
     reading order and the source order differ. */
  display: grid; gap: 0.55em 1.6em; align-items: start;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "head" "desc" "cond" "seq" "stats";
}
.kbm-fin-head { grid-area: head; }
.kbm-fin-desc { grid-area: desc; }
.kbm-fin-cond { grid-area: cond; }
.kbm-fin-seq { grid-area: seq; }
.kbm-fin > .kbm-stats { grid-area: stats; }
@media (min-width: 761px) {
  .kbm-fin {
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    grid-template-areas: "head desc" "cond stats" "seq stats";
  }
}
.kbm-fin-head { display: flex; align-items: center; gap: 0.7em; flex-wrap: wrap; }
.kbm-fin-tag {
  font-family: var(--kb-font-mono);
  font-size: 0.5em; font-weight: 800; letter-spacing: 0.3em;
  color: var(--kb-danger); padding: 0.3em 0.6em 0.26em;
  box-shadow: inset 0 0 0 1px currentColor;
}
.kbm-fin-name {
  font-family: var(--kb-font-display);
  font-size: 1.1em; font-weight: 900; letter-spacing: 0.05em; color: var(--kb-text);
}
.kbm-fin-desc { margin: 0; font-size: 0.6em; line-height: 1.5; color: var(--kb-text-dim); }
.kbm-fin-cond-h {
  display: block;
  font-family: var(--kb-font-mono);
  font-size: 0.45em; letter-spacing: 0.26em; color: var(--kb-text-faint);
  margin-bottom: 0.3em;
}
.kbm-fin-cond ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.2em; }
.kbm-fin-cond li {
  font-size: 0.66em; font-weight: 700; line-height: 1.4; color: var(--kb-gold);
  padding-left: 1em; position: relative;
}
.kbm-fin-cond li::before { content: '▸'; position: absolute; left: 0; color: var(--kb-danger); }
.kbm-fin-cond-missing { margin: 0; font-size: 0.6em; color: var(--kb-danger-soft); }
.kbm-fin-seq-text { margin: 0.35em 0 0; font-size: 0.58em; color: var(--kb-text-dim); }
.kbm-stats--big { justify-content: flex-start; }

/* -- short: landscape phones -------------------------------------------------- */
/* The 844x390 case. Type off vh for the same reason the select screen does, and
   the panel goes edge to edge because 4vw of margin on a 390px-tall screen buys
   nothing and costs a row. */
@media (max-height: 560px) {
  .kbm { font-size: clamp(12px, 3.3vh, 15px); }
  .kbm-panel {
    inset: 0 var(--kb-sa-r, 0px) 0 var(--kb-sa-l, 0px);
    clip-path: none;
  }
  .kbm-head { padding: 0.5em 0.9em 0.45em; }
  .kbm-name { font-size: 1.15em; }
  .kbm-tabs { padding: 0.35em 0.9em; }
  .kbm-body { padding: 0 0.9em 1em; }
  .kbm-sec { padding-top: 0.8em; }
  .kbm-row { padding: 0.42em 0.5em; }
}

/* -- narrow: portrait phones --------------------------------------------------- */
/* The stats column cannot hold four cells beside the name at this width without
   the notation wrapping to three lines, so it drops under the row and becomes a
   fourth line of its own. Nothing is hidden — a move list that omits the frame
   data is a list of names. */
@media (max-width: 760px) {
  .kbm { font-size: clamp(14px, 3.9vw, 19px); }
  .kbm-panel { inset: var(--kb-sa-t, 0px) var(--kb-sa-r, 0px) var(--kb-sa-b, 0px) var(--kb-sa-l, 0px); clip-path: none; }
  .kbm-row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "name" "in" "meta" "stats";
    gap: 0.25em;
  }
  .kbm-stats { justify-content: flex-start; flex-wrap: wrap; gap: 0.4em; }
  .kbm-num { align-items: flex-start; min-width: 3em; }
}

@media (hover: none) {
  .kbm-tab { min-height: 44px; padding: 0 1em; }
}

@media (prefers-reduced-motion: reduce) {
  .kbm-panel { transition-duration: 0.01ms; }
}
`;
