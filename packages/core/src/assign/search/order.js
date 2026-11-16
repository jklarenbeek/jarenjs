//@ts-check
/**
 * @file How search reads a scoring it made: what the validation decided
 * about the candidate (its class) and the scores the candidate can have
 * at best and at worst. An unknown only hides matches: a rule that could
 * decide might lower a score, never raise it. So a candidate scores at
 * best what its scoring answers, and at worst that score with every level
 * from the first one an unknown is reported at unbounded below.
 */

import { RULE_LEVELS } from '../rules.js';

/** @typedef {import('../score.js').AssignResult} AssignResult */
/** @typedef {import('../model.js').Assignment} Assignment */

/**
 * A score as exact levels (hard, service, soft); `null` is a level
 * unbounded below.
 * @typedef {readonly (bigint | null)[]} Levels
 */

/**
 * One scored candidate: its result, the list it scored, its class and bounds.
 * @typedef {Object} Candidate
 * @property {AssignResult} result
 * @property {readonly Assignment[]} list
 * @property {number} cls - FEASIBLE, UNDECIDED, INFEASIBLE or INCOMPLETE
 * @property {Levels} upper - the score at best
 * @property {Levels} lower - the score at worst
 */

/** A complete scoring with the verdict `feasible`. */
export const FEASIBLE = 3;
/** A complete scoring with the verdict `unknown`: a hard rule could not decide. */
export const UNDECIDED = 2;
/** A complete scoring with the verdict `infeasible-by-validation`: a hard match. */
export const INFEASIBLE = 1;
/** A scoring stopped at a limit: no score. */
export const INCOMPLETE = 0;

/**
 * @param {AssignResult} result
 * @returns {number}
 */
export function classOf(result) {
  if (!result.complete) return INCOMPLETE;
  return result.verdict === 'feasible' ? FEASIBLE : result.verdict === 'unknown' ? UNDECIDED : INFEASIBLE;
}

/**
 * Read a scoring as a candidate.
 * @param {AssignResult} result @param {readonly Assignment[]} list
 * @returns {Candidate}
 */
export function candidateOf(result, list) {
  const cls = classOf(result);
  if (!result.complete) return { result, list, cls, upper: [null, null, null], lower: [null, null, null] };
  const score = result.score;
  const upper = [BigInt(score.hard), BigInt(score.service), BigInt(score.soft)];
  let first = RULE_LEVELS.length;
  for (const unknown of result.unknowns) first = Math.min(first, RULE_LEVELS.indexOf(unknown.level));
  return { result, list, cls, upper, lower: upper.map((value, i) => (i >= first ? null : value)) };
}

/**
 * Lexicographic order of two level lists, `null` below every value.
 * @param {Levels} a @param {Levels} b
 * @returns {number} 1 when a is better, -1 when worse, 0 when equal
 */
export function compareLevels(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === null) return -1;
    if (y === null) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Whether `a` is a better incumbent than `b`: a better class (feasible,
 * then undecided, then infeasible by validation; an incomplete scoring
 * is never one), then a better score, then a better worst score.
 * @param {Candidate} a @param {Candidate} b
 * @returns {boolean}
 */
export function better(a, b) {
  if (a.cls !== b.cls) return a.cls > b.cls;
  if (a.cls === INCOMPLETE) return false;
  const byScore = compareLevels(a.upper, b.upper);
  if (byScore !== 0) return byScore > 0;
  return compareLevels(a.lower, b.lower) > 0;
}

/**
 * The key of one slot of one task.
 * @param {string} task @param {string} slot
 * @returns {string}
 */
export function slotKey(task, slot) {
  return JSON.stringify([task, slot]);
}

/**
 * The resources already in each slot: the problem's own assignments,
 * which every candidate keeps.
 * @param {import('../model.js').ProblemIndex} index
 * @returns {Map<string, Set<string>>} by {@link slotKey}
 */
export function heldOf(index) {
  /** @type {Map<string, Set<string>>} */
  const held = new Map();
  for (const item of index.problem.assignments ?? []) {
    const key = slotKey(item.task, item.slot);
    let set = held.get(key);
    if (set === undefined) held.set(key, set = new Set());
    set.add(item.resource);
  }
  return held;
}
