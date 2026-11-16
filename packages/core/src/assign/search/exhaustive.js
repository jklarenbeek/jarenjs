//@ts-check
/**
 * @file The exhaustive strategy: every candidate of the space, each
 * reached by one evaluator edit from its parent, so each is scored with
 * the evaluator's exact answer. No pruning: rules are host code, so no
 * bound on what a rule answers holds for every rule.
 */

import { AssignError } from '../errors.js';
import { better, candidateOf, compareLevels, FEASIBLE, heldOf, INCOMPLETE, INFEASIBLE, slotKey, UNDECIDED } from './order.js';

/** @typedef {import('../model.js').ProblemIndex} ProblemIndex */
/** @typedef {import('./order.js').Candidate} Candidate */
/** @typedef {import('./solve.js').Run} Run */

/**
 * One way to fill one open place: a resource for a slot.
 * @typedef {Object} Item
 * @property {number} at - the slot's place in `open`
 * @property {string} task
 * @property {string} slot
 * @property {string} resource
 */

/**
 * The space of a problem: per slot with room left, the resources not
 * already in it, and the number of candidates (per slot, every set of
 * those resources no larger than the room, multiplied over the slots).
 * Refused past `maxSpace` before anything is scored.
 * @param {ProblemIndex} index @param {number} maxSpace
 * @returns {{ items: readonly Item[], open: number[], space: number }}
 * @throws {AssignError} JN0024 past maxSpace
 */
export function spaceOf(index, maxSpace) {
  const held = heldOf(index);
  /** @type {Item[]} */
  const items = [];
  /** @type {number[]} */
  const open = [];
  let space = 1n;
  const limit = BigInt(maxSpace);
  for (const task of index.tasks)
    for (const demand of task.demands) {
      const holders = held.get(slotKey(task.id, demand.slot)) ?? new Set();
      const room = demand.count - holders.size;
      if (room <= 0) continue;
      const free = index.resources.filter((resource) => !holders.has(resource.id));
      let ways = 0n;
      let choose = 1n;
      for (let k = 0; k <= Math.min(room, free.length); k++) {
        ways += choose;
        choose = (choose * BigInt(free.length - k)) / BigInt(k + 1);
      }
      space *= ways;
      if (space > limit)
        throw new AssignError('JN0024', `the exhaustive space holds more than SOLVE_LIMITS.maxSpace (${maxSpace}) candidates`, '/options/strategy');
      const at = open.length;
      open.push(room);
      for (const resource of free) items.push({ at, task: task.id, slot: demand.slot, resource: resource.id });
    }
  return { items, open, space: Number(space) };
}

/**
 * Visit every candidate of the space in a fixed order (each slot's
 * resources in id order, slots in task and slot order, a set before the
 * sets that extend it) and keep the best (see `better`; on a tie the
 * first visited). The status is the proof the visit gives: see `statusOf`.
 * @param {Run} run @param {{ items: readonly Item[], open: number[], space: number }} space
 * @returns {{ best: Candidate, status: 'optimal' | 'infeasible' | 'feasible' | 'unknown' | null, bound: import('../score.js').AssignScore | null }}
 */
export function exhaustive(run, space) {
  const { evaluator, counts } = run;
  const { items, open } = space;
  counts.space = space.space;
  /** @type {Candidate | null} */
  let best = null;
  /** @type {Candidate | null} */
  let top = null;
  /** @type {Candidate | null} */
  let second = null;
  let incomplete = 0;
  let possible = 0;
  /** @param {Candidate} candidate */
  const consider = (candidate) => {
    if (candidate.cls === INCOMPLETE || candidate.cls === UNDECIDED) counts.undecided++;
    if (candidate.cls === INCOMPLETE) {
      incomplete++;
      return;
    }
    if (candidate.cls !== INFEASIBLE) possible++;
    if (best === null || better(candidate, best)) best = candidate;
    if (top === null || compareLevels(candidate.upper, top.upper) > 0) {
      second = top;
      top = candidate;
    }
    else if (second === null || compareLevels(candidate.upper, second.upper) > 0) second = candidate;
  };
  counts.nodes = 1;
  const root = candidateOf(evaluator.result, evaluator.assignments);
  consider(root);
  /** @param {number} start @returns {boolean} false once the run stopped */
  const walk = (start) => {
    for (let j = start; j < items.length; j++) {
      if (counts.nodes === space.space) return true;
      const item = items[j];
      if (open[item.at] === 0) continue;
      if (run.halted(true) || run.halted(false)) return false;
      counts.moves++;
      counts.nodes++;
      evaluator.apply({ op: 'assign', task: item.task, slot: item.slot, resource: item.resource });
      consider(candidateOf(evaluator.result, evaluator.assignments));
      open[item.at]--;
      const more = walk(j + 1);
      open[item.at]++;
      if (!more) return false;
      if (counts.nodes === space.space) return true;
      if (run.halted(false)) return false;
      counts.moves++;
      evaluator.apply({ op: 'unassign', task: item.task, slot: item.slot, resource: item.resource });
    }
    return true;
  };
  walk(0);
  /** @type {Candidate} */
  const found = best ?? root;
  if (counts.nodes !== space.space) return { best: found, status: null, bound: null };
  if (incomplete > 0) return { best: found, status: found.cls === FEASIBLE ? 'feasible' : 'unknown', bound: null };
  const bound = /** @type {Candidate} */ (top).result;
  const score = /** @type {import('../score.js').AssignCompleteResult} */ (bound).score;
  if (possible === 0) return { best: found, status: 'infeasible', bound: score };
  if (found.cls !== FEASIBLE) return { best: found, status: 'unknown', bound: score };
  const other = top === found ? second : top;
  const proved = other === null || compareLevels(other.upper, found.lower) <= 0;
  return { best: found, status: proved ? 'optimal' : 'feasible', bound: score };
}
