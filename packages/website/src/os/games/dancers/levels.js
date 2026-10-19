//@ts-check
/**
 * The Tape Dancers levels and how a program is graded on them.
 *
 * Levels are data (`levels.json`): each names its tier, the Turing skill
 * it teaches and its difficulty on the skill ladder, the alphabet it
 * dances on, its test tapes and what each must become, its par, and a
 * reference solution — the proof the level can be solved within par,
 * and the well the hints are drawn from. Every level is checked once
 * when this module loads, by the same validators the game applies to
 * whatever a save or a tool hands it.
 *
 * A tape test passes when the dance halts and every goal it names
 * holds: the tape it must become (cells past the goal stay paper), the
 * cell the dancer must finish on, the ink it must halt standing on (how
 * a yes/no question is answered), or a count of blue cells (the busy
 * beavers). A program solves a level when it passes every tape; then
 * the stars climb a ladder — ★ solved, ★★ with no more states than par,
 * ★★★ also within the par steps, summed over the tapes.
 *
 * Grading is a skill ladder too: the OS's one-sided Elo
 * (`kernel/ladder.js`, the ladder Monkey Grove teaches with) rates each
 * graded run against the level's difficulty, and `suggestLevel` aims the
 * next level where the expected success is about two in three.
 */

import levelsDoc from './levels.json' with { type: 'json' };
import { expected, rate, LADDER } from '../../kernel/ladder.js';
import {
  BLANK, INK_NAMES, MAX_STATES, MAX_STEPS, SYMBOLS_MAX, checkRules, rulesToProgram, runProgram,
} from './program.js';

/**
 * @typedef {import('./program.js').RuleTable} RuleTable
 * @typedef {import('./program.js').RunResult} RunResult
 * @typedef {import('../../kernel/ladder.js').SkillRating} SkillRating
 * @typedef {{ input: number[], head?: number, goal?: number[], end?: number, mark?: number, ones?: number }} TapeTest
 *   - `head`: the starting cell (default 0); `goal`: the tape the input must become; `end`: the cell to finish on;
 *     `mark`: the ink to halt standing on; `ones`: at least this many blue cells. Cells count from the input's first.
 * @typedef {{ id: string, name: string, blurb: string }} Tier
 * @typedef {{ id: string, name: string, tier: string, skill: string, difficulty: number, symbols: number, maxSteps: number,
 *   prompt: string, tests: TapeTest[], par: { states: number, steps: number }, solution: RuleTable }} Level
 * @typedef {{ kind: 'halt' | 'cell' | 'end' | 'mark' | 'ones', cell?: number, want?: number, got?: number }} Miss
 *   - the first thing wrong with a finished tape
 * @typedef {{ test: number, passed: boolean, steps: number, halted: boolean, tape: number[], origin: number, head: number,
 *   state: string, miss: Miss | null }} TapeResult
 * @typedef {{ solved: boolean, stars: number, steps: number, states: number, failed: number, tapes: TapeResult[] }} Verdict
 *   - `failed`: the index of the first tape that did not pass, -1 when solved
 * @typedef {{ solved: boolean, stars: number, steps: number }} Progress
 */

/** The Turing skills the levels teach, one ladder rating each. */
export const SKILLS = Object.freeze(['move', 'write', 'branch', 'loop', 'carry', 'compare', 'optimize']);

/** The expected success a suggestion aims at: what the ladder's offset
 * below the rating gives, about two in three. */
export const TARGET_SUCCESS = expected(LADDER.offset, 0);

/** Longest tape a level may give or ask for, in cells. */
const TAPE_MAX = 32;

/** A level id: lowercase letters, digits and dashes. */
const LEVEL_ID = /^[a-z][a-z0-9-]{0,23}$/;

/** The tiers, easiest first. */
export const TIERS = /** @type {readonly Tier[]} */ (Object.freeze(levelsDoc.tiers));

/**
 * `n word` with the word pluralised when n is not one.
 * @param {number} n @param {string} word
 */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Whether a value is a tape over `symbols` inks, 1 to 32 cells long.
 * @param {unknown} tape @param {number} symbols
 */
function isTape(tape, symbols) {
  return Array.isArray(tape) && tape.length >= 1 && tape.length <= TAPE_MAX
    && tape.every((s) => Number.isInteger(s) && s >= 0 && s < symbols);
}

/**
 * What is wrong with one tape test over `symbols` inks, or null.
 * @param {any} test @param {number} symbols @returns {string | null}
 */
function testProblem(test, symbols) {
  if (!test || !isTape(test.input, symbols)) return `the input must be 1 to ${TAPE_MAX} cells of its inks`;
  if (test.head !== undefined && !Number.isInteger(test.head)) return 'the head must start on a cell';
  if (test.goal !== undefined && !isTape(test.goal, symbols)) return 'the goal must be a tape of its inks';
  if (test.end !== undefined && !Number.isInteger(test.end)) return 'the end must be a cell';
  if (test.mark !== undefined && !(Number.isInteger(test.mark) && test.mark >= 0 && test.mark < symbols)) return 'the mark must be one of its inks';
  if (test.ones !== undefined && !(Number.isInteger(test.ones) && test.ones >= 1)) return 'a count of blue cells must be at least one';
  if (test.goal === undefined && test.end === undefined && test.mark === undefined && test.ones === undefined) {
    return 'a tape needs a goal, an end, a mark or a count';
  }
  return null;
}

/**
 * What is wrong with a level, or null — the check every level passes
 * before the game will offer it.
 * @param {any} level @returns {string | null}
 */
export function levelProblem(level) {
  if (!level || typeof level !== 'object') return 'a level is an object';
  if (typeof level.id !== 'string' || !LEVEL_ID.test(level.id)) return 'a level needs an id of lowercase letters, digits and dashes';
  const at = `level ${level.id}`;
  if (typeof level.name !== 'string' || level.name === '') return `${at} needs a name`;
  if (!TIERS.some((t) => t.id === level.tier)) return `${at} names no tier`;
  if (!SKILLS.includes(level.skill)) return `${at} names no Turing skill`;
  if (!Number.isFinite(level.difficulty)) return `${at} needs a difficulty`;
  const symbols = level.symbols;
  if (!Number.isInteger(symbols) || symbols < 2 || symbols > SYMBOLS_MAX) return `${at} must dance on 2 to ${SYMBOLS_MAX} inks`;
  if (!Number.isInteger(level.maxSteps) || level.maxSteps < 1 || level.maxSteps > MAX_STEPS) return `${at} needs a step limit`;
  if (typeof level.prompt !== 'string' || level.prompt === '') return `${at} needs its goal in words`;
  if (!Array.isArray(level.tests) || level.tests.length === 0) return `${at} needs at least one tape`;
  for (const [index, test] of level.tests.entries()) {
    const problem = testProblem(test, symbols);
    if (problem) return `${at}, tape ${index + 1}: ${problem}`;
  }
  const par = level.par;
  if (!Number.isInteger(par?.states) || par.states < 1 || par.states > MAX_STATES || !Number.isInteger(par.steps) || par.steps < 1) {
    return `${at} needs a par of states and steps`;
  }
  const problem = checkRules(level.solution, symbols);
  return problem ? `${at}, solution: ${problem}` : null;
}

/**
 * Check a list of levels, refusing the first bad or repeated one.
 * @param {any[]} list @returns {Level[]}
 * @throws {RangeError}
 */
export function loadLevels(list) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const level of list) {
    const problem = levelProblem(level) ?? (seen.has(level.id) ? `level ${level.id} is listed twice` : null);
    if (problem) throw new RangeError(problem);
    seen.add(level.id);
  }
  return list;
}

/** Every level, in teaching order. */
export const LEVELS = /** @type {readonly Level[]} */ (Object.freeze(loadLevels(levelsDoc.levels)));

/**
 * The level with an id, or null.
 * @param {unknown} id @returns {Level | null}
 */
export function levelById(id) {
  return LEVELS.find((level) => level.id === id) ?? null;
}

/** The tier a level belongs to. @param {Level} level @returns {Tier} */
export function tierOf(level) {
  return /** @type {Tier} */ (TIERS.find((tier) => tier.id === level.tier));
}

/**
 * The first thing wrong with a finished tape, or null when it passes.
 * @param {TapeTest} test
 * @param {Pick<RunResult, 'tape' | 'origin' | 'head' | 'halted'>} run
 * @returns {Miss | null}
 */
export function checkTape(test, run) {
  if (!run.halted) return { kind: 'halt' };
  if (test.goal) {
    const lo = run.origin > 0 ? -run.origin : 0;
    const hi = Math.max(test.goal.length, run.tape.length - run.origin);
    for (let cell = lo; cell < hi; cell++) {
      const want = test.goal[cell] ?? BLANK;
      const got = run.tape[cell + run.origin] ?? BLANK;
      if (want !== got) return { kind: 'cell', cell, want, got };
    }
  }
  const at = run.head - run.origin;
  if (test.end !== undefined && at !== test.end) return { kind: 'end', cell: at, want: test.end };
  const under = run.tape[run.head];
  if (test.mark !== undefined && under !== test.mark) return { kind: 'mark', cell: at, want: test.mark, got: under };
  if (test.ones !== undefined) {
    const got = run.tape.filter((s) => s === 1).length;
    if (got < test.ones) return { kind: 'ones', want: test.ones, got };
  }
  return null;
}

/**
 * The stars a run earns: none unsolved, then ★ solved, ★★ with no more
 * states than par, ★★★ also within the par steps.
 * @param {Level} level @param {{ solved: boolean, states: number, steps: number }} result
 */
export function starsFor(level, result) {
  if (!result.solved) return 0;
  if (result.states > level.par.states) return 1;
  return result.steps <= level.par.steps ? 3 : 2;
}

/** Stars as the HUD prints them, filled then hollow. @param {number} stars */
export const starText = (stars) => '★'.repeat(stars) + '☆'.repeat(3 - stars);

/**
 * Grade a program on every tape of a level, from scratch.
 * @param {Level} level @param {RuleTable} rules
 * @returns {Verdict}
 * @throws {RangeError} when the program does not read the level's inks
 */
export function judge(level, rules) {
  const problem = checkRules(rules, level.symbols);
  if (problem) throw new RangeError(problem);
  const doc = rulesToProgram(rules);
  /** @type {TapeResult[]} */
  const tapes = level.tests.map((test, index) => {
    const run = runProgram(doc, test.input, { head: test.head ?? 0, maxSteps: level.maxSteps });
    const miss = checkTape(test, run);
    return { test: index, passed: miss === null, steps: run.steps, halted: run.halted, tape: run.tape, origin: run.origin, head: run.head, state: run.state, miss };
  });
  const failed = tapes.findIndex((t) => !t.passed);
  const solved = failed < 0;
  const steps = tapes.reduce((sum, t) => sum + t.steps, 0);
  const states = Object.keys(rules).length;
  return { solved, stars: starsFor(level, { solved, states, steps }), steps, states, failed, tapes };
}

/**
 * What went wrong, in a short sentence the dancer can say: "Cell 4
 * should be blue." Cells are numbered from 1 at the input's first cell,
 * as the stage labels them.
 * @param {Level} level @param {number} index - the tape @param {Miss} miss
 * @returns {string}
 */
export function missText(level, index, miss) {
  const tape = level.tests.length > 1 ? `on tape ${index + 1}, ` : '';
  const cell = (/** @type {number | undefined} */ n) => `cell ${Number(n) + 1}`;
  let text;
  if (miss.kind === 'halt') text = `${tape}the dancer never reached halt in ${plural(level.maxSteps, 'step')}: send a rule to halt`;
  else if (miss.kind === 'cell') text = `${tape}${cell(miss.cell)} should be ${INK_NAMES[Number(miss.want)]}`;
  else if (miss.kind === 'end') text = `${tape}the dancer should finish on ${cell(miss.want)}, not ${cell(miss.cell)}`;
  else if (miss.kind === 'mark') text = `${tape}the dancer should halt on ${INK_NAMES[Number(miss.want)]}, not ${INK_NAMES[Number(miss.got)]}`;
  else text = `${tape}only ${miss.got} blue on the tape: the goal is ${miss.want}`;
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** The reference's rules in the order its dance first fires them, by level id. */
const firings = new Map();

/**
 * The rules the reference solution fires on the level's tapes, in the
 * order it first fires them, as (state index, symbol) — what a hint
 * reveals first. Rules the reference never needs are never hinted.
 * @param {Level} level @returns {Array<{ index: number, symbol: number }>}
 */
export function firingOrder(level) {
  let order = firings.get(level.id);
  if (order === undefined) {
    const doc = rulesToProgram(level.solution);
    const states = Object.keys(level.solution);
    /** @type {Set<string>} */
    const seen = new Set();
    order = [];
    for (const test of level.tests) {
      for (const step of runProgram(doc, test.input, { head: test.head ?? 0, maxSteps: level.maxSteps }).trace) {
        const key = `${step.state}:${step.read}`;
        if (seen.has(key)) continue;
        seen.add(key);
        order.push({ index: states.indexOf(step.state), symbol: step.read });
      }
    }
    firings.set(level.id, order);
  }
  return order;
}

/**
 * The chance a player's ladder gives them on a level: the shared
 * ladder's expectation for their rating in the level's skill (a fresh
 * skill starts at the ladder's opening rating).
 * @param {Record<string, SkillRating> | null | undefined} ratings @param {Level} level
 */
export function chanceOf(ratings, level) {
  const r = ratings?.[level.skill]?.r;
  return expected(Number.isFinite(r) ? /** @type {number} */ (r) : LADDER.start, level.difficulty);
}

/**
 * The level to play next: of the unsolved levels, the one whose expected
 * success is closest to two in three; when every level is solved, the
 * same pick over those still short of three stars; null when nothing is
 * left to improve. `except` skips one level (the one being left).
 * @param {{ progress?: Record<string, Progress>, ratings?: Record<string, SkillRating> } | null | undefined} save
 * @param {string | null} [except]
 * @returns {string | null}
 */
export function suggestLevel(save, except = null) {
  const progress = save?.progress ?? {};
  const open = LEVELS.filter((level) => level.id !== except);
  const unsolved = open.filter((level) => progress[level.id]?.solved !== true);
  const pool = unsolved.length > 0 ? unsolved : open.filter((level) => (progress[level.id]?.stars ?? 0) < 3);
  let best = null;
  let gap = Infinity;
  for (const level of pool) {
    const g = Math.abs(chanceOf(save?.ratings, level) - TARGET_SUCCESS);
    if (g < gap) {
      gap = g;
      best = level.id;
    }
  }
  return best;
}

/**
 * Rate one graded run on the shared ladder: solved scores 1, solved
 * after a hint 0.7, unsolved 0, against the level's difficulty in its
 * skill.
 * @param {Record<string, SkillRating>} ratings @param {Level} level
 * @param {boolean} solved @param {boolean} hinted
 * @returns {{ ratings: Record<string, SkillRating>, delta: number }}
 */
export function rateRun(ratings, level, solved, hinted) {
  const out = rate({ xp: 0, badges: [], skills: ratings }, { skill: level.skill, correct: solved, difficulty: level.difficulty, hinted });
  return { ratings: out.profile.skills, delta: out.delta };
}
