//@ts-check
/**
 * Tape Dancers for a language model: four tools over the very moves a
 * person makes (`state.js`), each `run` pure like the rest of the game,
 * each input described by the schema the arcade validates it against.
 *
 *   - `dancers_level` reads the level — its inks, every tape and what it
 *     must become, the par — and the program as it stands (naming a level
 *     opens it first);
 *   - `dancers_rule` sets ONE rule: the small chunk, a few dozen
 *     characters any model can emit, naming new states as it goes;
 *   - `dancers_program` sets the WHOLE table in one call: the big
 *     workload, `programChars(rules)` characters in a single breath — the
 *     size that tells the OS when a small model should go rule by rule;
 *   - `dancers_run` grades the program on every tape at once and reports
 *     tape by tape: passed or not, the steps, the final tape, and what
 *     went wrong in the words the dancer would say.
 *
 * A refused call changes nothing and answers `{ ok: false, error }`.
 */

import { INK_NAMES, MAX_STATES, MOVES, SYMBOLS_MAX, programChars } from './program.js';
import { LEVELS, missText, plural, tierOf } from './levels.js';
import { levelOf, openLevel, rulesOf, runAll, setProgram, setRule } from './state.js';

/**
 * @typedef {import('../game.js').GameTool} GameTool
 * @typedef {import('./state.js').DancersState} DancersState
 */

/** A control state's name, as a schema. */
const STATE = Object.freeze({
  type: 'string', pattern: '^[a-z][a-z0-9_]{0,11}$', not: { const: 'halt' },
  description: 'A control state, such as q0. The first state of the table is where every dance starts.',
});

/** The three members of a rule, as schema properties. */
const RULE_MEMBERS = Object.freeze({
  write: { type: 'integer', minimum: 0, maximum: SYMBOLS_MAX - 1, description: 'The ink to stamp: 0 paper, 1 blue, 2 yellow, 3 red (only inks the level uses).' },
  move: { enum: [...MOVES], description: 'The step: L left, R right, S stay.' },
  next: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,11}$', description: 'The next state, or halt to end the dance.' },
});

/** How the tape is counted, for every answer that shows one. */
const HOW = 'Cells count from 0 at the first cell of a tape\'s input; the tape is endless paper both ways. '
  + 'A rule answers (state, ink read) with an ink to write, a step and the next state; every step counts, the halting one too. '
  + 'Set one rule with dancers_rule or the whole table with dancers_program, then grade it with dancers_run.';

/**
 * The level, its tapes and the program, as `dancers_level` answers.
 * @param {DancersState} state
 */
function levelReport(state) {
  const level = levelOf(state);
  const rules = rulesOf(state);
  const { par } = level;
  return {
    ok: true,
    level: {
      id: level.id, name: level.name, tier: tierOf(level).name, skill: level.skill, goal: level.prompt,
      inks: INK_NAMES.slice(0, level.symbols).map((name, symbol) => ({ symbol, name })),
      tapes: level.tests.map((test, index) => ({ tape: index + 1, ...test, head: test.head ?? 0 })),
      par, maxSteps: level.maxSteps,
      stars: `★ every tape passes · ★★ also with at most ${plural(par.states, 'state')} · ★★★ also in at most ${plural(par.steps, 'step')} over all tapes`,
    },
    rules,
    states: Object.keys(rules),
    best: state.progress[level.id] ?? null,
    levels: LEVELS.map((l) => ({ id: l.id, name: l.name, tier: tierOf(l).name, stars: state.progress[l.id]?.stars ?? 0 })),
    programChars: programChars(rules),
    how: HOW,
  };
}

/** @param {DancersState} state @param {any} input */
function levelTool(state, input) {
  if (input?.id === undefined || input.id === state.level) return { state, result: levelReport(state) };
  const out = openLevel(state, input.id);
  if (out.error) return { state, result: { ok: false, error: out.error } };
  return { state: out.state, result: levelReport(out.state), events: out.events };
}

/** @param {DancersState} state @param {any} input */
function ruleTool(state, input) {
  const out = setRule(state, input);
  if (out.error) return { state, result: { ok: false, error: out.error } };
  const rules = rulesOf(out.state);
  return { state: out.state, result: { ok: true, states: Object.keys(rules), row: { state: input.state, rules: rules[input.state] } }, events: out.events };
}

/** @param {DancersState} state @param {any} input */
function programTool(state, input) {
  const out = setProgram(state, input?.rules);
  if (out.error) return { state, result: { ok: false, error: out.error } };
  const rules = rulesOf(out.state);
  return { state: out.state, result: { ok: true, states: Object.keys(rules), programChars: programChars(rules) }, events: out.events };
}

/** @param {DancersState} state */
function runTool(state) {
  const out = runAll(state);
  const level = levelOf(state);
  const { verdict } = out;
  return {
    state: out.state,
    result: {
      ok: true, solved: verdict.solved, stars: verdict.stars, steps: verdict.steps, states: verdict.states, par: level.par,
      summary: out.state.verdict?.text,
      tapes: verdict.tapes.map((t) => ({
        tape: t.test + 1, passed: t.passed, halted: t.halted, steps: t.steps,
        cells: t.tape, offset: t.origin, head: t.head - t.origin,
        problem: t.miss ? missText(level, t.test, t.miss) : null,
      })),
    },
    events: out.events,
  };
}

/** The tools, in the order a model would use them. */
export const TOOLS = /** @type {GameTool[]} */ (Object.freeze([
  {
    name: 'dancers_level',
    description: `Read the Tape Dancers level: its inks, every test tape and what it must become, the par, and the rule table as it stands. ${HOW}`,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { id: { enum: LEVELS.map((l) => l.id), description: 'Open this level first; leave it out to read the current one.' } },
    },
    run: levelTool,
  },
  {
    name: 'dancers_rule',
    description: 'Set ONE rule of the dancer\'s program: in `state`, reading ink `symbol`, write `write`, step `move` and go to `next` (or halt). '
      + 'A state named here that the table lacks yet is added. The small, safe move: a few dozen characters a call.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['state', 'symbol', 'write', 'move', 'next'],
      properties: { state: STATE, symbol: { type: 'integer', minimum: 0, maximum: SYMBOLS_MAX - 1, description: 'The ink read.' }, ...RULE_MEMBERS },
    },
    run: ruleTool,
  },
  {
    name: 'dancers_program',
    description: 'Set the WHOLE rule table in one call: `rules` maps each state, first state first, to one rule per ink the level uses. '
      + 'The big workload; set rules one at a time with dancers_rule when a whole table is too much to write at once.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['rules'],
      properties: {
        rules: {
          type: 'object', minProperties: 1, maxProperties: MAX_STATES, propertyNames: STATE,
          additionalProperties: {
            type: 'array', minItems: 2, maxItems: SYMBOLS_MAX,
            items: { type: 'object', additionalProperties: false, required: ['write', 'move', 'next'], properties: RULE_MEMBERS },
          },
          description: 'rules[state][ink] = { write, move, next }.',
        },
      },
    },
    run: programTool,
  },
  {
    name: 'dancers_run',
    description: 'Grade the program on every tape at once and report tape by tape: passed, halted, steps, the final cells '
      + '(cells[offset] is the input\'s first cell), where the dancer ended, and what went wrong. It counts as a graded run.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: runTool,
  },
]));
