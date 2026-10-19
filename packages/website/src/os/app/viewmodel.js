//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): what the view needs that is
 * computed from the state but is not state — numbers formatted for
 * people, the rule table read out of the program document, the merit
 * ladder, the token streams of the code the Source and Exports apps
 * show. Pure, and memoized by the identity of what each part reads, so
 * a tick that only moved the tape re-derives only what reads the tape.
 */

import { fsmToRules, SYMBOLS, TURNS } from '../kernel/program.js';
import { MEMBERS, SYMBOL_NAMES, TURN_NAMES } from '../kernel/council.js';
import { tokenize, tokenStats, TOKEN_KINDS } from '../kernel/exports.js';
import { HUMAN_INK } from '../stage/scene.js';
import { sculpt, layoutSculpture } from '../stage/sculpture.js';
import { DOCUMENTS } from './documents.js';
import { PALETTE } from './state.js';

/** The most token runs a code panel renders; longer documents show their
 * first part, and say so. */
const MAX_RUNS = 2400;

/** The tastes, in the order the meters show them. */
export const TASTES = Object.freeze([
  { key: 'balance', label: 'Balance', who: 'painter' },
  { key: 'motion', label: 'Motion', who: 'dancer' },
  { key: 'structure', label: 'Structure', who: 'critic' },
  { key: 'symmetry', label: 'Symmetry', who: 'architect' },
  { key: 'harmony', label: 'Harmony', who: 'oracle' },
]);

/** An arrow per turn, for the rule table. */
const TURN_GLYPHS = Object.freeze({ L: '↰', R: '↱', U: '↶', N: '↑' });

/** What each phase means, in words. */
const PHASE_TEXT = Object.freeze({
  idle: 'The council is resting. The next session meets on the machine’s clock — or convene it now.',
  convening: 'The council is in session: every member proposes, then judges every proposal by simulating it.',
  veto: 'An amendment won the vote. It is yours to refuse.',
  enacting: 'The amendment is being written into the program.',
});

/** Memoize a one-argument derivation by the identity of its argument.
 * @template A, R @param {(a: A) => R} fn @returns {(a: A) => R} */
function memo1(fn) {
  /** @type {A | undefined} */ let last;
  /** @type {R | undefined} */ let value;
  let primed = false;
  return (a) => {
    if (!primed || a !== last) { last = a; value = fn(a); primed = true; }
    return /** @type {R} */ (value);
  };
}

/** The rule table of a program document, ready to render.
 * @type {(machine: any) => any[]} */
const rulesOf = memo1((machine) => {
  const table = fsmToRules(machine);
  const states = Object.keys(table);
  return states.map((state, q) => ({
    state,
    cells: table[state].map((rule, symbol) => ({
      key: `${state}-${symbol}`,
      index: q * SYMBOLS + symbol,
      symbol,
      reads: SYMBOL_NAMES[symbol],
      write: rule.write,
      writes: SYMBOL_NAMES[rule.write],
      writeColor: PALETTE[rule.write] ?? PALETTE[0],
      turn: rule.turn,
      turnGlyph: TURN_GLYPHS[rule.turn] ?? '?',
      turnName: TURN_NAMES[rule.turn] ?? rule.turn,
      next: rule.next,
      // the value one click on each part moves to, so the view's
      // binding is a plain payload
      cycleWrite: { kind: 'rule', state, symbol, member: 'write', value: (rule.write + 1) % SYMBOLS },
      cycleTurn: { kind: 'rule', state, symbol, member: 'turn', value: TURNS[(TURNS.indexOf(rule.turn) + 1) % TURNS.length] },
      cycleNext: { kind: 'rule', state, symbol, member: 'next', value: states[(states.indexOf(rule.next) + 1) % states.length] },
    })),
  }));
});

/** The token runs of a text, for highlighted display.
 * @type {(input: { text: string, lang: string }) => { runs: any[], stats: any[], tokens: number, truncated: boolean }} */
const tokensOf = memo1((input) => {
  const tokens = tokenize(input.text, input.lang);
  const counts = tokenStats(tokens);
  const total = Math.max(1, tokens.length);
  return {
    runs: tokens.slice(0, MAX_RUNS).map((t) => ({ kind: `tok-${t.kind}`, value: t.value })),
    stats: TOKEN_KINDS.filter((k) => counts[k] > 0).map((k) => ({ kind: `tok-${k}`, label: k, count: counts[k], pct: Math.round((counts[k] / total) * 1000) / 10 })),
    tokens: tokens.length,
    truncated: tokens.length > MAX_RUNS,
  };
});

/** The Source app's text block for one document value, memoized on it.
 * @type {(value: any) => { text: string, layout: ReturnType<typeof layoutSculpture> }} */
const shapeOf = memo1((value) => {
  const text = JSON.stringify(value, null, 2);
  return { text, layout: layoutSculpture(sculpt(value)) };
});

/** One stable block object per (document, value) so the view's memo holds.
 * @type {(input: { doc: any, value: any }) => any} */
const sourceBlock = (() => {
  /** @type {any} */ let lastDoc = null;
  /** @type {any} */ let lastValue = null;
  /** @type {any} */ let block = null;
  return (/** @type {{ doc: any, value: any }} */ input) => {
    if (block && input.doc === lastDoc && input.value === lastValue) return block;
    lastDoc = input.doc;
    lastValue = input.value;
    const shape = shapeOf(input.value);
    const tokens = tokensOf(textKey(shape.text, 'json'));
    block = {
      id: input.doc.id, label: input.doc.label, format: input.doc.format, about: input.doc.about,
      size: shape.text.length, tokens: tokens.tokens, truncated: tokens.truncated, runs: tokens.runs,
      layout: shape.layout,
    };
    return block;
  };
})();

/** Remember one token-stream input object per text so `tokensOf`'s
 * identity memo holds across renders. */
const textKey = (() => {
  /** @type {Map<string, { text: string, lang: string }>} */
  const cache = new Map();
  return (/** @type {string} */ text, /** @type {string} */ lang) => {
    const id = `${lang}\u0000${text}`;
    let entry = cache.get(id);
    if (!entry) {
      if (cache.size > 16) cache.clear();
      entry = { text, lang };
      cache.set(id, entry);
    }
    return entry;
  };
})();

/** No export rendered yet. */
const EMPTY_TOKENS = Object.freeze({ runs: [], stats: [], tokens: 0, truncated: false });

/** @param {number} v */
const fixed2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

/**
 * The view's input document.
 * @param {any} state
 */
export function viewModel(state) {
  const merits = state.council.merits ?? {};
  const top = Math.max(1, ...Object.values(/** @type {Record<string, number>} */ (merits)));
  const palette = state.program.palette;
  const members = MEMBERS
    .map((m) => ({
      id: m.id,
      name: m.name,
      taste: m.taste ?? 'veto',
      motto: m.motto,
      merit: fixed2(Number(merits[m.id]) || 1),
      pct: Math.round(((Number(merits[m.id]) || 1) / top) * 100),
      lead: m.id === state.council.leader,
      color: m.ink < 0 ? HUMAN_INK : palette[m.ink],
      focused: state.os.focus === m.id,
    }))
    .sort((a, b) => Number(b.merit) - Number(a.merit));
  const measureNow = state.machine.measure ?? {};
  const tastes = TASTES.map((t) => ({
    ...t,
    value: fixed2(measureNow[t.key] ?? 0),
    pct: Math.round((measureNow[t.key] ?? 0) * 100),
  }));
  const trail = state.machine.trail ?? [];
  const spark = trail.length < 2 ? '' : trail
    .map((/** @type {number} */ h, /** @type {number} */ i) => `${Math.round((i / (trail.length - 1)) * 1000) / 10},${Math.round((1 - h) * 300) / 10}`)
    .join(' ');
  const scores = Object.fromEntries((state.council.scores ?? []).map((/** @type {any} */ s) => [s.id, s.score]));
  const proposals = (state.council.proposals ?? []).map((/** @type {any} */ p) => ({
    ...p,
    score: scores[p.id] ?? null,
    winner: p.id === state.council.winner?.id,
    who: MEMBERS.find((m) => m.id === p.by)?.name ?? p.by,
  }));
  const left = state.council.deadline === null || state.os.now === undefined
    ? null
    : Math.max(0, Math.ceil((state.council.deadline - state.os.now) / 1000));
  const sourceDoc = DOCUMENTS.find((d) => d.id === state.source.doc) ?? DOCUMENTS[0];
  const source = state.os.app === 'source' ? sourceBlock({ doc: sourceDoc, value: sourceDoc.read(state) }) : null;
  const exportsLang = state.exports.format === 'css' ? 'css' : state.exports.format === 'js' ? 'js' : 'html';
  return {
    ...state,
    ui: {
      phaseText: PHASE_TEXT[/** @type {keyof typeof PHASE_TEXT} */ (state.council.phase)] ?? '',
      members,
      tastes,
      spark,
      harmony: fixed2(measureNow.harmony ?? 0),
      rules: rulesOf(state.program.machine),
      symbols: SYMBOL_NAMES.map((name, i) => ({ name, color: palette[i], index: i })),
      proposals,
      left,
      log: (state.council.log ?? []).map((/** @type {any} */ a) => ({
        ...a,
        who: MEMBERS.find((m) => m.id === a.by)?.name ?? a.by,
        repealable: a.status === 'enacted' && (a.change?.kind === 'rule' || a.change?.kind === 'tempo'),
        rewardText: a.reward === null || a.reward === undefined ? '' : `${a.reward >= 0 ? '+' : '−'}${Math.abs(a.reward).toFixed(3)} merit`,
      })),
      draftTitle: state.machine.forecast?.title ?? '',
      forecast: state.machine.forecast ? TASTES.map((t) => ({
        key: t.key,
        label: t.label,
        before: fixed2(state.machine.forecast.before[t.key]),
        after: fixed2(state.machine.forecast.after[t.key]),
        up: state.machine.forecast.after[t.key] >= state.machine.forecast.before[t.key],
      })) : [],
      documents: DOCUMENTS.map((d) => ({ id: d.id, label: d.label, active: d.id === sourceDoc.id })),
      source,
      sculpture: source && {
        layout: source.layout,
        active: sourceDoc.path ? sourceDoc.path(state) : [],
        theme: state.os.theme,
        reduce: state.os.reduce,
        label: `${source.label} as a sculpture: ${source.layout.nodes.length} figures${source.layout.hidden > 0 ? `, ${source.layout.hidden} more not shown` : ''}.`,
      },
      exports: state.exports.text ? tokensOf(textKey(state.exports.text, exportsLang)) : EMPTY_TOKENS,
      label: `Radiant stage: ${state.world.heads.length} dancers on a ${state.world.width} by ${state.world.height} floor, tick ${state.world.tick}, harmony ${fixed2(measureNow.harmony ?? 0)}.`,
    },
  };
}
