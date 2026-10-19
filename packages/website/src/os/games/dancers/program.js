//@ts-check
/**
 * The dancer's program: the finite control of a one-dimensional Turing
 * machine, kept as a jaren-fsm document in the same house layout as the
 * OS's own turmite (`kernel/program.js`), and the tape unit that runs it.
 *
 * A rule answers (control state, ink under the dancer) with an ink to
 * write, a step to take — `L`, `R` or `S` to stay — and the next state,
 * or `halt`. The document holds exactly that and nothing else:
 *
 *   - one `read` transition per (state, symbol), in that order, guarded
 *     by `{ $eq: ['$.payload.symbol', s] }`, so transition
 *     `q * symbols + s` is always the rule for state `q` reading `s`;
 *   - the rule's output as two effect descriptors returned as data,
 *     `write` with the ink and `move` with the step, which this tape unit
 *     performs: the engine never touches the tape;
 *   - `halt` declared as a final state (`{ id: 'halt', final: true }`),
 *     the only way out of the dance.
 *
 * The rule table (`RuleTable`, `rules[state][symbol]`) is the view people
 * and language models edit; `rulesToProgram` and `programToRules` round
 * trip it, and one validator (`checkRules`) guards every table the game
 * accepts — from a save, a tool call or a level file.
 *
 * The tape is unbounded in both directions, as a Turing machine's is: it
 * grows a paper cell whenever the dancer steps past either end, and
 * `origin` says where the input's first cell sits in the grown tape, so
 * positions stay comparable however far the dance strays.
 */

import { compileFsm } from '@jarenjs/flow';

/** The blank paper every unwritten cell holds. */
export const BLANK = 0;

/** Symbols a level may use: paper plus three inks. */
export const SYMBOLS_MAX = 4;

/** The inks, symbol by symbol — the OS palette's paper, blue, yellow and red. */
export const INKS = Object.freeze(['#fffdf6', '#2563eb', '#fbbf24', '#ef4444']);

/** What a person calls each symbol. */
export const INK_NAMES = Object.freeze(['paper', 'blue', 'yellow', 'red']);

/** The three steps: left, right, stay. */
export const MOVES = /** @type {readonly ['L', 'R', 'S']} */ (Object.freeze(['L', 'R', 'S']));

/** The final state every program may go to. */
export const HALT = 'halt';

/** Control states a dancer can remember, at most (the grid's rows). */
export const MAX_STATES = 8;

/** The step limit `runProgram` applies when none is given. */
export const MAX_STEPS = 1000;

/** A state name: a letter, then up to eleven letters, digits or `_`. */
const STATE_NAME = /^[a-z][a-z0-9_]{0,11}$/;

/** How far each step carries the head. */
const DELTA = Object.freeze(/** @type {Record<string, number>} */ ({ L: -1, R: 1, S: 0 }));

/**
 * @typedef {'L' | 'R' | 'S'} Move
 * @typedef {{ write: number, move: Move, next: string }} Rule
 * @typedef {Record<string, Rule[]>} RuleTable - rules[state][symbol]; the first state is where a run starts
 * @typedef {{ state: string, at: number, read: number, write: number, move: Move, next: string }} TraceStep
 *   - one machine step; `at` is the cell read, counted from the input's first cell
 * @typedef {{ tape: number[], head: number, origin: number, state: string, steps: number,
 *   halted: boolean, stuck: boolean, trace: TraceStep[] }} RunResult
 *   - `head` indexes `tape`; `origin` is the index of the input's first cell in `tape`
 * @typedef {ReturnType<typeof compileFsm>} Machine
 */

/**
 * Whether a string can name a control state (`halt` is taken).
 * @param {unknown} name @returns {name is string}
 */
export function isStateName(name) {
  return typeof name === 'string' && name !== HALT && STATE_NAME.test(name);
}

/**
 * What is wrong with one rule over an alphabet of `symbols`, or null.
 * The next state only has to be a well-formed name here: whether it
 * exists is the table's question (an edit may create it).
 * @param {any} rule @param {number} symbols @returns {string | null}
 */
export function ruleProblem(rule, symbols) {
  if (!rule || typeof rule !== 'object') return 'a rule is { write, move, next }';
  if (!Number.isInteger(rule.write) || rule.write < 0 || rule.write >= symbols) return `write must be an ink from 0 to ${symbols - 1}`;
  if (!MOVES.includes(rule.move)) return 'move must be L, R or S';
  if (rule.next !== HALT && !isStateName(rule.next)) return 'next must be a state name or halt';
  return null;
}

/**
 * What is wrong with a whole rule table over an alphabet of `symbols`,
 * or null: the one check every table passes before the game runs it.
 * @param {any} rules @param {number} symbols @returns {string | null}
 */
export function checkRules(rules, symbols) {
  if (!Number.isInteger(symbols) || symbols < 2 || symbols > SYMBOLS_MAX) return `a program reads 2 to ${SYMBOLS_MAX} inks`;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return 'the rule table must be an object of states';
  const states = Object.keys(rules);
  if (states.length === 0) return 'a program needs at least one state';
  if (states.length > MAX_STATES) return `a dancer remembers at most ${MAX_STATES} states`;
  for (const state of states) {
    if (!isStateName(state)) return `"${state}" is not a state name (a letter, then letters, digits or _)`;
    const row = rules[state];
    if (!Array.isArray(row) || row.length !== symbols) return `state ${state} must answer each of the ${symbols} inks`;
    for (let symbol = 0; symbol < symbols; symbol++) {
      const problem = ruleProblem(row[symbol], symbols);
      if (problem) return `${state} reading ${INK_NAMES[symbol]}: ${problem}`;
      const next = row[symbol].next;
      if (next !== HALT && !states.includes(next)) return `${state} reading ${INK_NAMES[symbol]}: there is no state ${next}`;
    }
  }
  return null;
}

/**
 * The rule that does nothing at all: keep the ink, stay, halt — what a
 * fresh state answers until someone teaches it a step.
 * @param {number} symbol @returns {Rule}
 */
export const restRule = (symbol) => ({ write: symbol, move: 'S', next: HALT });

/**
 * A fresh program: one state, resting on every ink.
 * @param {number} symbols @returns {RuleTable}
 */
export function freshRules(symbols) {
  return { q0: Array.from({ length: symbols }, (_, s) => restRule(s)) };
}

/**
 * The program as an executable jaren-fsm document.
 * @param {RuleTable} rules
 * @returns {{ $fsm: '0.1', initial: string, states: Array<string | { id: string, final: true }>, transitions: any[] }}
 * @throws {RangeError} when the table fails {@link checkRules}
 */
export function rulesToProgram(rules) {
  const first = rules && typeof rules === 'object' ? Object.values(rules)[0] : undefined;
  const symbols = Array.isArray(first) ? first.length : 0;
  const problem = checkRules(rules, symbols);
  if (problem) throw new RangeError(problem);
  const states = Object.keys(rules);
  const transitions = [];
  for (const from of states) {
    for (let symbol = 0; symbol < symbols; symbol++) {
      const rule = rules[from][symbol];
      transitions.push({
        from,
        event: 'read',
        guard: { $eq: ['$.payload.symbol', symbol] },
        to: rule.next,
        effects: [{ run: 'write', with: rule.write }, { run: 'move', with: rule.move }],
      });
    }
  }
  return { $fsm: '0.1', initial: states[0], states: [...states, { id: HALT, final: true }], transitions };
}

/**
 * Read the rule table back out of a program document — the inverse of
 * {@link rulesToProgram}. A document the table cannot represent exactly
 * (a transition out of place, a foreign effect, a halt that is not
 * final) throws: the grid must never show a table that is not the
 * program it claims to be.
 * @param {any} doc @returns {RuleTable}
 * @throws {RangeError}
 */
export function programToRules(doc) {
  if (!doc || doc.$fsm !== '0.1' || !Array.isArray(doc.states) || !Array.isArray(doc.transitions)) {
    throw new RangeError('not a jaren-fsm program document');
  }
  const ids = doc.states.map((/** @type {any} */ s) => (typeof s === 'string' ? s : s?.id));
  if (doc.states[ids.indexOf(HALT)]?.final !== true) throw new RangeError('the halt state must be declared final');
  // a state's own effects would run beside the rule's, and only halt may end the dance
  const plain = doc.states.every((/** @type {any} */ s) => typeof s === 'string'
    || (s?.entry === undefined && s?.exit === undefined && (s?.final !== true || s.id === HALT)));
  if (!plain) throw new RangeError('program states carry no effects of their own, and only halt is final');
  const control = ids.filter((/** @type {any} */ id) => id !== HALT);
  if (control.length === 0 || doc.initial !== control[0]) throw new RangeError('the program must start in its first state');
  const symbols = doc.transitions.length / control.length;
  /** @type {RuleTable} */
  const rules = {};
  doc.transitions.forEach((/** @type {any} */ t, /** @type {number} */ index) => {
    const state = control[Math.floor(index / symbols)];
    const symbol = index % symbols;
    const [write, move] = Array.isArray(t?.effects) ? t.effects : [];
    const guard = t?.guard?.$eq;
    if (t?.from !== state || t.event !== 'read' || Object.keys(t.guard ?? {}).length !== 1 || guard?.length !== 2
      || guard[0] !== '$.payload.symbol' || guard[1] !== symbol
      || write?.run !== 'write' || move?.run !== 'move' || t.effects.length !== 2) {
      throw new RangeError(`transition ${index} is not the rule for (${state}, ${symbol})`);
    }
    (rules[state] ??= []).push({ write: write.with, move: move.with, next: t.to });
  });
  const problem = checkRules(rules, symbols);
  if (problem) throw new RangeError(problem);
  return rules;
}

/** Compiled programs, by document identity: a program compiles once,
 * however many steps and tapes it dances. */
const compiled = new WeakMap();

/**
 * The compiled machine for a program document, memoized by identity.
 * The layout is checked before the engine sees it, so the tape unit only
 * ever runs documents it can read back as a table.
 * @param {object} doc @returns {Machine}
 * @throws {RangeError} when the document is not in the program layout
 */
export function compileProgram(doc) {
  let machine = compiled.get(doc);
  if (machine === undefined) {
    programToRules(doc);
    machine = compileFsm(doc);
    compiled.set(doc, machine);
  }
  return machine;
}

/**
 * A tape with the head placed on it: paper is added at either end until
 * the head stands on a cell, and `origin` counts the cells added in
 * front of the input. Pure; the input tape is never mutated.
 * @param {readonly number[]} tape @param {number} head
 * @returns {{ tape: number[], head: number, origin: number }}
 */
export function placeHead(tape, head) {
  const cells = tape.length > 0 ? tape.slice() : [BLANK];
  let at = head;
  let origin = 0;
  for (; at < 0; at++, origin++) cells.unshift(BLANK);
  while (at >= cells.length) cells.push(BLANK);
  return { tape: cells, head: at, origin };
}

/**
 * Dance a program over a tape: read, write, step, change state, until
 * the machine halts, finds no rule for the ink it reads (`stuck`), or
 * has taken `maxSteps` steps. Every step counts, the halting one too.
 * The tape grows paper at whichever end the dancer steps past.
 *
 * `state` continues a dance from a control state other than the first,
 * which is how the game advances its animated run one beat at a time
 * with the same semantics the grader uses.
 * @param {object} doc - a program document ({@link rulesToProgram})
 * @param {readonly number[]} tape
 * @param {{ head?: number, maxSteps?: number, state?: string }} [options]
 * @returns {RunResult}
 */
export function runProgram(doc, tape, options = {}) {
  const machine = compileProgram(doc);
  const placed = placeHead(tape, options.head ?? 0);
  const cells = placed.tape;
  let { head, origin } = placed;
  let state = options.state ?? /** @type {string} */ (machine.initial);
  const limit = options.maxSteps ?? MAX_STEPS;
  /** @type {TraceStep[]} */
  const trace = [];
  let halted = machine.final(state);
  let stuck = false;
  while (!halted && trace.length < limit) {
    const read = cells[head];
    const result = machine.step(state, 'read', { payload: { symbol: read } });
    if (!result.changed) {
      stuck = true;
      break;
    }
    let write = read;
    /** @type {Move} */
    let move = 'S';
    for (const effect of result.effects) {
      if (effect.run === 'write') write = effect.with;
      else move = effect.with;
    }
    cells[head] = write;
    trace.push({ state, at: head - origin, read, write, move, next: result.state });
    state = result.state;
    halted = result.final;
    head += DELTA[move];
    if (head < 0) {
      cells.unshift(BLANK);
      head = 0;
      origin += 1;
    }
    else if (head >= cells.length) {
      cells.push(BLANK);
    }
  }
  return { tape: cells, head, origin, state, steps: trace.length, halted, stuck, trace };
}

/**
 * The JSON size of a whole-table call (`dancers_program`) for a rule
 * table, in characters — what a model must emit in one breath to set
 * the program at once, against a few dozen for one rule.
 * @param {RuleTable} rules @returns {number}
 */
export function programChars(rules) {
  return JSON.stringify({ rules }).length;
}
