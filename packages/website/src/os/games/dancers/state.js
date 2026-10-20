//@ts-check
/**
 * The Tape Dancers state and every move on it, as pure functions over
 * plain JSON: open a level, edit the rule table (one member, one rule, a
 * whole table, a state more or fewer), dance it on the beat or one step
 * at a time, grade it, ask for a hint, move on. Each move answers
 * `{ state, events }` (and `error` when it refuses), so the module's
 * `act` and the language-model tools are thin dispatchers over the same
 * functions: a person's press and a model's call are the same move.
 *
 * The dance on stage is the tape unit itself, one beat at a time: every
 * beat calls `runProgram` for a single step from where the dancer
 * stands, so what the stage shows and what the grader counts can never
 * disagree. Tapes are danced in order; the first that fails, or the
 * last that passes, ends the run, and then the whole program is graded
 * from scratch (`judge`) — that verdict is the one that counts.
 *
 * Any edit stops the dance and puts the first tape back: the program on
 * stage is always the program in the table.
 */

import { isProfile } from '../../kernel/ladder.js';
import {
  BLANK, HALT, INKS, INK_NAMES, MAX_STATES, MOVES, checkRules, freshRules, isStateName, placeHead, restRule,
  ruleProblem, rulesToProgram, runProgram,
} from './program.js';
import {
  LEVELS, checkTape, firingOrder, judge, levelById, missText, plural, rateRun, starText, suggestLevel,
} from './levels.js';

/**
 * @typedef {import('./program.js').RuleTable} RuleTable
 * @typedef {import('./program.js').Rule} Rule
 * @typedef {import('./program.js').TraceStep} TraceStep
 * @typedef {import('./levels.js').Level} Level
 * @typedef {import('./levels.js').TapeTest} TapeTest
 * @typedef {import('./levels.js').Miss} Miss
 * @typedef {import('./levels.js').Progress} Progress
 * @typedef {import('./levels.js').Verdict} Verdict
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {import('../game.js').Camera} Camera
 * @typedef {import('../game.js').V3} V3
 * @typedef {import('../../kernel/ladder.js').SkillRating} SkillRating
 * @typedef {'idle' | 'running' | 'paused' | 'done'} Mode
 * @typedef {{ mode: Mode, test: number, tape: number[], origin: number, head: number, from: number, state: string,
 *   steps: number, total: number, clock: number, fired: { state: string, symbol: number } | null }} Run
 *   - the dance on stage: `test` is the tape being danced, `origin` where its input starts in `tape`, `from` the
 *     cell the dancer hopped from (counted from the input's first cell), `steps` the steps on this tape, `total`
 *     the steps of the tapes already passed, `clock` the ticks since the last beat, `fired` the rule of the last step
 * @typedef {{ solved: boolean, stars: number, steps: number, states: number, failed: number, miss: Miss | null,
 *   text: string, hinted: boolean }} Shown - the verdict of the last graded run, while it stands
 * @typedef {{ v: 1, level: string, programs: Record<string, RuleTable>, progress: Record<string, Progress>,
 *   ratings: Record<string, SkillRating>, hinted: boolean, run: Run, verdict: Shown | null }} DancersState
 * @typedef {{ state: DancersState, events: GameEvent[], error?: string }} Move
 */

/** The save format this module writes. */
export const SAVE_VERSION = 1;

/** World units per tape cell. */
export const CELL = 1.25;

/** The stage camera: a low three-quarter view along the tape, aimed at its middle. */
export const CAMERA = Object.freeze(/** @type {Camera} */ ({
  azimuth: 0.1, elevation: 0.4, distance: 14.5, lift: 0.4, fov: 0.62, target: [0, 2.4, -0.2],
}));

/** The clock stops counting here; every animation has settled long before. */
export const CLOCK_REST = 60;

/** Ticks of rest between one passed tape and the next. */
const BREATH = 24;

/** A beat this short or shorter dances without a spark and a sound per step. */
const QUIET_BEAT = 4;

/** The rule members a grid cell can cycle. */
const MEMBERS = Object.freeze(['write', 'move', 'next']);

/** A grid cell id: `state:symbol:member`. */
const CELL_ID = /^([a-z][a-z0-9_]{0,11}):(\d):(write|move|next)$/;

/** Each ink's pitch: paper a fourth under the root, then the root, the third and the fifth. */
const PITCH = Object.freeze([0.75, 1, 1.26, 1.5]);

/** The steps, as the dancer says them. */
const STEP_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ L: 'step left', R: 'step right', S: 'stay' }));

/** Who speaks the game's lines. */
const SPEAKER = 'Tape Dancer';

/**
 * Ticks per beat after `steps` steps: the dance starts on the music and
 * quickens, so a long program still finishes while you watch.
 * @param {number} steps
 */
export function beatTicks(steps) {
  if (steps < 16) return 15;
  if (steps < 48) return 8;
  return steps < 120 ? 4 : 1;
}

/** How tall a block stands: paper lies flat, every ink a step taller. @param {number} symbol */
export const blockTop = (symbol) => (symbol === BLANK ? 0.14 : 0.3 + 0.14 * symbol);

/**
 * The world x of a cell of a tape test (counted from its input's first
 * cell): every input is centred on the stage.
 * @param {TapeTest} test @param {number} cell
 */
export const cellX = (test, cell) => (cell - (test.input.length - 1) / 2) * CELL;

/** @param {string} name @param {number} [pitch] @returns {GameEvent} */
const sfx = (name, pitch) => (pitch === undefined ? { kind: 'sfx', name } : { kind: 'sfx', name, pitch });

/** @param {string} text @returns {GameEvent} */
const say = (text) => ({ kind: 'say', who: SPEAKER, text });

/** The level a state is on. @param {DancersState} state @returns {Level} */
export const levelOf = (state) => /** @type {Level} */ (levelById(state.level));

/** The rule table of the level a state is on. @param {DancersState} state @returns {RuleTable} */
export const rulesOf = (state) => state.programs[state.level];

/** The ink at a cell of the run's tape (paper past either end). @param {Run} run @param {number} cell */
export const inkAt = (run, cell) => run.tape[cell + run.origin] ?? BLANK;

/**
 * Where the dancer stands at rest: on top of the block under the head.
 * @param {Level} level @param {Run} run @returns {V3}
 */
export function dancerPoint(level, run) {
  const cell = run.head - run.origin;
  return [cellX(level.tests[run.test], cell), blockTop(inkAt(run, cell)), 0];
}

/** Program documents by rule-table identity: a table compiles once, however many beats it dances. */
const docs = new WeakMap();

/** @param {RuleTable} rules */
function docOf(rules) {
  let doc = docs.get(rules);
  if (doc === undefined) {
    doc = rulesToProgram(rules);
    docs.set(rules, doc);
  }
  return doc;
}

/** A rule table copied member by member, so nothing the caller keeps aliases the state. @param {RuleTable} rules */
function copyRules(rules) {
  /** @type {RuleTable} */
  const out = {};
  for (const [state, row] of Object.entries(rules)) out[state] = row.map((r) => ({ write: r.write, move: r.move, next: r.next }));
  return out;
}

/**
 * The dance at the start of a tape.
 * @param {Level} level @param {RuleTable} rules @param {number} [test] @param {number} [total]
 * @returns {Run}
 */
function freshRun(level, rules, test = 0, total = 0) {
  const t = level.tests[test];
  const placed = placeHead(t.input, t.head ?? 0);
  return {
    mode: 'idle', test, tape: placed.tape, origin: placed.origin, head: placed.head, from: placed.head - placed.origin,
    state: Object.keys(rules)[0], steps: 0, total, clock: CLOCK_REST, fired: null,
  };
}

/** @param {DancersState} state @param {Mode} mode @returns {DancersState} */
const withMode = (state, mode) => ({ ...state, run: { ...state.run, mode } });

/** The stage back at the first tape, the verdict gone. @param {DancersState} state @returns {DancersState} */
const restart = (state) => ({ ...state, run: freshRun(levelOf(state), rulesOf(state)), verdict: null });

/**
 * Stand on a level: its program (a fresh one the first time), the first
 * tape on stage, no verdict, no hint taken.
 * @param {DancersState} state @param {Level} level @returns {DancersState}
 */
function enter(state, level) {
  const rules = state.programs[level.id] ?? freshRules(level.symbols);
  return {
    ...state, level: level.id, programs: { ...state.programs, [level.id]: rules }, hinted: false,
    run: freshRun(level, rules), verdict: null,
  };
}

/** A move refused: nothing changes, and the dancer says why. @param {DancersState} state @param {string} text @returns {Move} */
function refuse(state, text) {
  return { state, events: [sfx('wrong'), say(text)], error: text };
}

/**
 * A new program for the current level: the dance stops and the first
 * tape comes back.
 * @param {DancersState} state @param {RuleTable} rules @param {GameEvent[]} events @returns {Move}
 */
function edited(state, rules, events) {
  const level = levelOf(state);
  return { state: { ...state, programs: { ...state.programs, [level.id]: rules }, run: freshRun(level, rules), verdict: null }, events };
}

/**
 * The table with every named state present (new ones resting on every
 * ink, appended in order), or null when that would pass the limit.
 * @param {RuleTable} rules @param {number} symbols @param {string[]} names @returns {RuleTable | null}
 */
function withStates(rules, symbols, names) {
  const out = { ...rules };
  for (const name of names) {
    if (name === HALT || Object.hasOwn(out, name)) continue;
    out[name] = Array.from({ length: symbols }, (_, s) => restRule(s));
  }
  return Object.keys(out).length > MAX_STATES ? null : out;
}

/** Saved rule tables that fit their level, copied. @param {any} value @returns {Record<string, RuleTable>} */
function restorePrograms(value) {
  /** @type {Record<string, RuleTable>} */
  const out = {};
  for (const [id, rules] of Object.entries(value && typeof value === 'object' ? value : {})) {
    const level = levelById(id);
    if (level && checkRules(rules, level.symbols) === null) out[id] = copyRules(rules);
  }
  return out;
}

/** Saved progress for known levels, with every member made sane. @param {any} value @returns {Record<string, Progress>} */
function restoreProgress(value) {
  /** @type {Record<string, Progress>} */
  const out = {};
  for (const [id, p] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!levelById(id) || !p || p.solved !== true || !Number.isInteger(p.stars) || !Number.isInteger(p.steps)) continue;
    out[id] = { solved: true, stars: Math.max(1, Math.min(3, p.stars)), steps: Math.max(0, p.steps) };
  }
  return out;
}

/**
 * A fresh game, or the one a save describes. Anything in the save that
 * does not check out is dropped, never trusted: a program that does not
 * fit its level, progress for a level that does not exist, a ladder that
 * is not one. It opens `options.level` when named, else the level the
 * save says comes next, else the one it was on.
 * @param {{ save?: any, options?: any }} [init] @returns {DancersState}
 */
export function createState(init = {}) {
  const save = init.save && typeof init.save === 'object' ? init.save : {};
  const ratings = isProfile({ xp: 0, badges: [], skills: save.ratings }) ? structuredClone(save.ratings) : {};
  const level = levelById(init.options?.level) ?? levelById(save.next) ?? levelById(save.level) ?? LEVELS[0];
  // `enter` puts the stage up: the run and verdict here are only its placeholders
  /** @type {DancersState} */
  const base = {
    v: SAVE_VERSION, level: level.id, programs: restorePrograms(save.programs), progress: restoreProgress(save.progress),
    ratings, hinted: false, run: /** @type {any} */ (null), verdict: null,
  };
  return enter(base, level);
}

/**
 * Open a level.
 * @param {DancersState} state @param {unknown} id @returns {Move}
 */
export function openLevel(state, id) {
  const level = levelById(id);
  if (!level) return refuse(state, `There is no level called ${String(id)}.`);
  return {
    state: enter(state, level),
    events: [sfx('whoosh'), { kind: 'shot', shot: CAMERA, ms: 700 }, say(`${level.name}: ${level.prompt}`)],
  };
}

/**
 * Set one rule: `{ state, symbol, write, move, next }`. A state the rule
 * names that the table lacks yet is created, so a program can be built
 * one rule at a time in any order.
 * @param {DancersState} state @param {any} input @returns {Move}
 */
export function setRule(state, input) {
  const level = levelOf(state);
  const symbol = input?.symbol;
  if (!isStateName(input?.state)) return refuse(state, 'Name the state the rule belongs to.');
  if (!Number.isInteger(symbol) || symbol < 0 || symbol >= level.symbols) {
    return refuse(state, `The ink read must be a number from 0 to ${level.symbols - 1}.`);
  }
  /** @type {Rule} */
  const rule = { write: input.write, move: input.move, next: input.next };
  const problem = ruleProblem(rule, level.symbols);
  if (problem) return refuse(state, `That rule does not fit: ${problem}.`);
  const grown = withStates(rulesOf(state), level.symbols, [input.state, rule.next]);
  if (!grown) return refuse(state, `A dancer remembers at most ${MAX_STATES} states.`);
  const rules = { ...grown, [input.state]: grown[input.state].map((r, s) => (s === symbol ? rule : r)) };
  return edited(state, rules, [sfx('click', PITCH[rule.write])]);
}

/**
 * Cycle one member of one rule, by grid cell id (`q0:1:write`): the ink
 * through the level's inks, the step through L, R, S, the next state
 * through the table's states and halt.
 * @param {DancersState} state @param {unknown} id @returns {Move}
 */
export function cycleCell(state, id) {
  const level = levelOf(state);
  const rules = rulesOf(state);
  const parts = typeof id === 'string' ? CELL_ID.exec(id) : null;
  const symbol = Number(parts?.[2]);
  if (!parts || !Object.hasOwn(rules, parts[1]) || symbol >= level.symbols) return refuse(state, `There is no rule cell ${String(id)}.`);
  const [, name, , member] = parts;
  const rule = rules[name][symbol];
  const choices = [...Object.keys(rules), HALT];
  /** @type {Rule} */
  const changed = member === 'write' ? { ...rule, write: (rule.write + 1) % level.symbols }
    : member === 'move' ? { ...rule, move: MOVES[(MOVES.indexOf(rule.move) + 1) % MOVES.length] }
      : { ...rule, next: choices[(choices.indexOf(rule.next) + 1) % choices.length] };
  const pitch = PITCH[MEMBERS.indexOf(member) + 1];
  return edited(state, { ...rules, [name]: rules[name].map((r, s) => (s === symbol ? changed : r)) }, [sfx('click', pitch)]);
}

/**
 * Add a state, named `qN` with the first free N, resting on every ink.
 * @param {DancersState} state @returns {Move}
 */
export function addState(state) {
  const rules = rulesOf(state);
  if (Object.keys(rules).length >= MAX_STATES) return refuse(state, `A dancer remembers at most ${MAX_STATES} states.`);
  let n = 0;
  while (Object.hasOwn(rules, `q${n}`)) n++;
  const grown = /** @type {RuleTable} */ (withStates(rules, levelOf(state).symbols, [`q${n}`]));
  return edited(state, grown, [sfx('open')]);
}

/**
 * Remove a state (the last one when none is named). Every rule that went
 * to it halts instead; a program keeps at least one state.
 * @param {DancersState} state @param {unknown} [name] @returns {Move}
 */
export function removeState(state, name) {
  const rules = rulesOf(state);
  const states = Object.keys(rules);
  const target = name ?? states[states.length - 1];
  if (typeof target !== 'string' || !Object.hasOwn(rules, target)) return refuse(state, `There is no state ${String(target)}.`);
  if (states.length === 1) return refuse(state, 'A dancer needs at least one state.');
  /** @type {RuleTable} */
  const out = {};
  for (const q of states) {
    if (q !== target) out[q] = rules[q].map((r) => (r.next === target ? { ...r, next: HALT } : r));
  }
  return edited(state, out, [sfx('close')]);
}

/**
 * Replace the whole rule table at once (the tools' big move).
 * @param {DancersState} state @param {any} rules @returns {Move}
 */
export function setProgram(state, rules) {
  const level = levelOf(state);
  const problem = checkRules(rules, level.symbols);
  if (problem) return refuse(state, `That program does not fit ${level.name}: ${problem}.`);
  return edited(state, copyRules(rules), [sfx('pop')]);
}

/**
 * Put the first tape back on stage and the dancer at its start.
 * @param {DancersState} state @returns {Move}
 */
export function resetRun(state) {
  return { state: restart(state), events: [sfx('whoosh')] };
}

/**
 * Run the dance on the beat, or pause it if it is running. A finished
 * dance starts over from the first tape.
 * @param {DancersState} state @returns {Move}
 */
export function toggleRun(state) {
  if (state.run.mode === 'running') return { state: withMode(state, 'paused'), events: [sfx('stop')] };
  const base = state.run.mode === 'done' ? restart(state) : state;
  return { state: withMode(base, 'running'), events: [sfx('start')] };
}

/**
 * Dance exactly one step, pausing a running dance (a finished one starts
 * over first).
 * @param {DancersState} state @returns {Move}
 */
export function stepOnce(state) {
  const base = state.run.mode === 'done' ? restart(state) : state;
  return machineStep(withMode(base, 'paused'), false);
}

/**
 * One tick of the game clock: the hop animation advances, and a running
 * dance takes its next step when the beat comes round. A state with
 * nothing left to animate comes back as the same object.
 * @param {DancersState} state @returns {Move}
 */
export function advance(state) {
  const run = state.run;
  if (run.mode !== 'running' && run.clock >= CLOCK_REST) return { state, events: [] };
  const clock = Math.min(CLOCK_REST, run.clock + 1);
  const ticked = { ...state, run: { ...run, clock } };
  const beat = beatTicks(run.total + run.steps);
  if (run.mode !== 'running' || clock < beat) return { state: ticked, events: [] };
  return machineStep(ticked, beat <= QUIET_BEAT);
}

/**
 * The spark and the sound of one stamp, pitched by the ink written: a
 * stamp that changes the cell pops and throws sparks of the new ink
 * (sand for paper wiped clean); restamping the same ink is a light click.
 * @param {Level} level @param {Run} run @param {TraceStep} step @returns {GameEvent[]}
 */
function stampEvents(level, run, step) {
  if (step.write === step.read) return [sfx('click', PITCH[step.write])];
  /** @type {V3} */
  const at = [cellX(level.tests[run.test], step.at), blockTop(step.write) + 0.1, 0];
  return [
    { kind: 'fx', fx: 'sparks', at, colors: [step.write === BLANK ? '#fde68a' : INKS[step.write]], count: 10 },
    sfx('pop', PITCH[step.write]),
  ];
}

/**
 * One machine step of the dance on stage, through the tape unit.
 * @param {DancersState} state @param {boolean} quiet - no per-step juice (a fast beat) @returns {Move}
 */
function machineStep(state, quiet) {
  const level = levelOf(state);
  const rules = rulesOf(state);
  const run = state.run;
  const out = runProgram(docOf(rules), run.tape, { head: run.head, state: run.state, maxSteps: 1 });
  // a program that fits its level answers every ink, so a step always fires
  const step = /** @type {TraceStep} */ (out.trace[0]);
  /** @type {Run} */
  const moved = {
    ...run, tape: out.tape, origin: run.origin + out.origin, head: out.head, state: out.state, steps: run.steps + 1,
    from: step.at, clock: 0, fired: { state: step.state, symbol: step.read },
  };
  const events = quiet ? [] : stampEvents(level, moved, step);
  const after = { ...state, run: moved };
  if (out.halted) return tapeDone(after, events);
  if (moved.steps >= level.maxSteps) return finish(after, events);
  return { state: after, events };
}

/**
 * The dancer halted on a tape: a pass moves on to the next tape after a
 * breath; a miss, or the last tape, ends the run.
 * @param {DancersState} state @param {GameEvent[]} events @returns {Move}
 */
function tapeDone(state, events) {
  const level = levelOf(state);
  const run = state.run;
  const miss = checkTape(level.tests[run.test], { ...run, halted: true });
  if (miss || run.test === level.tests.length - 1) return finish(state, events);
  const next = { ...freshRun(level, rulesOf(state), run.test + 1, run.total + run.steps), mode: run.mode, clock: -BREATH };
  events.push(sfx('right'), { kind: 'fx', fx: 'stars', at: dancerPoint(level, run), count: 6 });
  return { state: { ...state, run: next }, events };
}

/**
 * Grade the program on every tape (the verdict that counts), keep the
 * best, rate the run on the ladder, and say how it went: confetti and a
 * level-up for a solve, a gentle knock and a pointer at the first wrong
 * cell for a miss.
 * @param {DancersState} state @param {GameEvent[]} events @param {Verdict} [verdict]
 * @returns {Move}
 */
function finish(state, events, verdict = judge(levelOf(state), rulesOf(state))) {
  const level = levelOf(state);
  const { solved, stars, steps, states, failed } = verdict;
  const miss = solved ? null : verdict.tapes[failed].miss;
  const text = miss
    ? missText(level, failed, miss)
    : `${starText(stars)} ${level.name} in ${plural(steps, 'step')} with ${plural(states, 'state')}; par is ${plural(level.par.steps, 'step')} with ${plural(level.par.states, 'state')}.`;
  const prior = state.progress[level.id];
  const progress = solved
    ? { ...state.progress, [level.id]: { solved: true, stars: Math.max(prior?.stars ?? 0, stars), steps: Math.min(prior?.steps ?? steps, steps) } }
    : state.progress;
  const { ratings } = rateRun(state.ratings, level, solved, state.hinted);
  /** @type {Run} */
  const run = { ...state.run, mode: 'done' };
  const at = dancerPoint(level, run);
  events.push({ kind: 'rate', skill: level.skill, correct: solved, difficulty: level.difficulty, hinted: state.hinted });
  if (solved) {
    events.push(
      sfx('levelup'),
      { kind: 'fx', fx: 'confetti', at: [at[0], at[1] + 1.4, at[2]], colors: INKS.slice(1) },
      { kind: 'fx', fx: 'radiance', at: [at[0], at[1] + 1, at[2]] },
      { kind: 'shake', amp: 4, ms: 300 },
      { kind: 'xp', amount: 10 * stars, reason: `${level.name} ${starText(stars)}` },
      say(text),
    );
  }
  else {
    events.push(sfx('wrong'), { kind: 'kick', body: 'dancer', impulse: [-4.5, 5.5] }, { kind: 'fx', fx: 'dust', at }, say(text));
  }
  /** @type {Shown} */
  const shown = { solved, stars, steps, states, failed, miss, text, hinted: state.hinted };
  return { state: { ...state, run, verdict: shown, progress, ratings }, events };
}

/**
 * Grade every tape at once, without the dance (the tools' run): the
 * stage shows the tape that failed, or the last one, as it ended.
 * @param {DancersState} state @returns {Move & { verdict: Verdict }}
 */
export function runAll(state) {
  const level = levelOf(state);
  const verdict = judge(level, rulesOf(state));
  const index = verdict.solved ? level.tests.length - 1 : verdict.failed;
  const tape = verdict.tapes[index];
  /** @type {Run} */
  const run = {
    mode: 'done', test: index, tape: tape.tape, origin: tape.origin, head: tape.head, from: tape.head - tape.origin,
    state: tape.state, steps: tape.steps, total: verdict.tapes.slice(0, index).reduce((sum, t) => sum + t.steps, 0),
    clock: CLOCK_REST, fired: null,
  };
  return { ...finish({ ...state, run }, [], verdict), verdict };
}

/**
 * Reveal one rule of the reference solution — the first one its dance
 * needs that this program gets wrong — and write it into the table. The
 * reference's states map onto this program's by position (its first
 * state is your first), so a hint never renames anything; the run is
 * marked hinted, which the ladder scores lower.
 * @param {DancersState} state @returns {Move}
 */
export function hint(state) {
  const level = levelOf(state);
  const rules = rulesOf(state);
  const reference = Object.keys(level.solution);
  const names = Object.keys(rules).slice(0, reference.length);
  for (let n = 0; names.length < reference.length; n++) {
    if (!Object.hasOwn(rules, `q${n}`) && !names.includes(`q${n}`)) names.push(`q${n}`);
  }
  for (const { index, symbol } of firingOrder(level)) {
    const want = level.solution[reference[index]][symbol];
    /** @type {Rule} */
    const rule = { write: want.write, move: want.move, next: want.next === HALT ? HALT : names[reference.indexOf(want.next)] };
    // the reference enters a state only through a rule fired before it, which this
    // program got right to come this far, so the program has the state already
    const own = rules[names[index]][symbol];
    if (own.write === rule.write && own.move === rule.move && own.next === rule.next) continue;
    const out = setRule({ ...state, hinted: true }, { state: names[index], symbol, ...rule });
    const then = rule.next === HALT ? 'halt' : `go to ${rule.next}`;
    const text = `Hint: in ${names[index]} reading ${INK_NAMES[symbol]}, stamp ${INK_NAMES[rule.write]}, ${STEP_WORDS[rule.move]} and ${then}.`;
    return { state: out.state, events: [sfx('chime'), { kind: 'fx', fx: 'stars', at: dancerPoint(level, out.state.run), count: 5 }, say(text)] };
  }
  return { state, events: [sfx('pass'), say('Every rule the dance needs is already right: press Run.')] };
}

/**
 * The level to move on to: the one the ladder suggests (never the one
 * being left), or, with nothing left to improve, simply the next one.
 * @param {DancersState} state @returns {string}
 */
export function followingLevel(state) {
  const after = LEVELS[(LEVELS.findIndex((l) => l.id === state.level) + 1) % LEVELS.length];
  return suggestLevel(state, state.level) ?? after.id;
}

/** Move on to the following level. @param {DancersState} state @returns {Move} */
export function nextLevel(state) {
  return openLevel(state, followingLevel(state));
}

/**
 * What a save keeps: the level on stage, every program touched, the best
 * results, the ladder — and, while a solve stands, the level to open
 * next, so a game started again from the save moves on instead of
 * replaying the level it just finished.
 * @param {DancersState} state
 */
export function saveOf(state) {
  return {
    v: SAVE_VERSION, level: state.level, next: state.verdict?.solved ? followingLevel(state) : null,
    programs: state.programs, progress: state.progress, ratings: state.ratings,
  };
}

/**
 * The outcome while a solve stands on stage: its stars, a score of
 * stars × 100 less the steps it took, and how it went.
 * @param {DancersState} state @returns {{ stars: number, score: number, summary: string } | null}
 */
export function outcomeOf(state) {
  const verdict = state.verdict;
  if (!verdict?.solved) return null;
  return { stars: verdict.stars, score: verdict.stars * 100 - verdict.steps, summary: verdict.text };
}
