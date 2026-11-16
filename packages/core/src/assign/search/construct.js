//@ts-check
/**
 * @file The construct strategy: one greedy pass over the open places in
 * task and slot order. Each place is decided once, between leaving it
 * open and each resource not yet in its slot, previewed with the
 * evaluator's `whatIf`.
 */

import { AssignError } from '../errors.js';
import { mulberry32, randomInt } from '../../random.js';
import { candidateOf, compareLevels, heldOf, INCOMPLETE, slotKey, UNDECIDED } from './order.js';

/** @typedef {import('../model.js').Assignment} Assignment */
/** @typedef {import('../model.js').AssignProblem} AssignProblem */
/** @typedef {import('../score.js').AssignResult} AssignResult */
/** @typedef {import('./order.js').Candidate} Candidate */
/** @typedef {import('./solve.js').Run} Run */

/**
 * What a `rank` hook is shown: one way to decide a place, with the
 * scoring it would have. `resource` is null for leaving the place open,
 * whose `result` is the current one.
 * @typedef {Object} RankCandidate
 * @property {string} task
 * @property {string} slot
 * @property {string | null} resource
 * @property {AssignResult} result
 */

/**
 * What a `rank` hook is shown of the pass so far, all of it frozen: the
 * admitted problem, the current assignment list (the problem's own and
 * the ones this pass added) and the ones this pass added, in the order
 * it added them.
 * @typedef {Object} RankState
 * @property {AssignProblem} problem
 * @property {readonly Assignment[]} assignments
 * @property {readonly Assignment[]} added
 */

/**
 * A host's candidate order: an integer for each candidate, lower first.
 * @typedef {(candidate: RankCandidate, state: RankState) => number | bigint} RankHook
 */

/**
 * @typedef {Candidate & { resource: string | null, rank: bigint }} Choice
 */

/**
 * Whether a candidate may be chosen over leaving the place open: its
 * scoring is complete, it is decided no worse than open (feasible,
 * undecided and infeasible by validation, in that order) and it adds no
 * hard match. A rank orders the candidates; it never waives a hard rule.
 * @param {Candidate} candidate @param {Candidate} open
 * @returns {boolean}
 */
function admissible(candidate, open) {
  if (candidate.cls === INCOMPLETE || candidate.cls < open.cls) return false;
  return open.cls === INCOMPLETE || /** @type {bigint} */ (candidate.upper[0]) >= /** @type {bigint} */ (open.upper[0]);
}

/**
 * Ask the hook for one candidate's rank.
 * @param {RankHook} rank @param {RankCandidate} candidate @param {RankState} state
 * @returns {bigint}
 * @throws {AssignError} JN0025 when it throws or answers other than an integer
 */
function rankOf(rank, candidate, state) {
  /** @type {unknown} */
  let value;
  try {
    value = rank(candidate, state);
  }
  catch (error) {
    throw new AssignError('JN0025', 'the rank hook threw', '/options/rank', error);
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new AssignError('JN0025', `the rank hook answered ${typeof value === 'number' ? String(value) : typeof value}, not a safe integer or a bigint`, '/options/rank');
}

/**
 * Fill the open places greedily. For each place, in task, slot and
 * resource order, the choice is the admissible candidate with the lowest
 * rank (every rank is 0 without a hook), then the best class, then the
 * best score; leaving the place open wins a tie, and a tie between
 * resources goes to the first in id order, or with a seed to the one a
 * draw of `mulberry32(seed)` (`randomInt` over them) picks. A place left open ends
 * its slot's filling.
 * @param {Run} run @param {RankHook | undefined} rank @param {number | null} seed
 * @returns {Candidate}
 */
export function construct(run, rank, seed) {
  const { evaluator, counts, index } = run;
  const random = seed === null ? null : mulberry32(seed);
  /** @type {Assignment[]} */
  const added = [];
  const held = heldOf(index);
  const current = () => candidateOf(evaluator.result, evaluator.assignments);
  for (const task of index.tasks)
    for (const demand of task.demands) {
      const key = slotKey(task.id, demand.slot);
      let holders = held.get(key);
      if (holders === undefined) held.set(key, holders = new Set());
      while (holders.size < demand.count) {
        if (run.halted(true)) return current();
        counts.nodes++;
        const open = current();
        /** @type {Choice[]} */
        const choices = [{ ...open, resource: null, rank: 0n }];
        for (const resource of index.resources) {
          if (holders.has(resource.id)) continue;
          if (run.halted(false)) return current();
          counts.moves++;
          const result = evaluator.whatIf({ op: 'assign', task: task.id, slot: demand.slot, resource: resource.id });
          const candidate = candidateOf(result, evaluator.assignments);
          if (candidate.cls === INCOMPLETE || candidate.cls === UNDECIDED) counts.undecided++;
          if (admissible(candidate, open)) choices.push({ ...candidate, resource: resource.id, rank: 0n });
        }
        if (rank !== undefined) {
          const state = Object.freeze({ problem: index.problem, assignments: evaluator.assignments, added: Object.freeze(added.slice()) });
          for (const choice of choices) {
            choice.rank = rankOf(rank, Object.freeze({ task: task.id, slot: demand.slot, resource: choice.resource, result: choice.result }), state);
            counts.ranked++;
          }
        }
        /** @param {Choice} a @param {Choice} b @returns {number} below 0 when a comes first */
        const order = (a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0) || b.cls - a.cls || -compareLevels(a.upper, b.upper);
        let first = choices[0];
        for (const choice of choices) if (order(choice, first) < 0) first = choice;
        if (first.resource === null) break;
        const tied = choices.filter((choice) => order(choice, first) === 0);
        const chosen = random === null || tied.length === 1 ? tied[0] : tied[randomInt(random, 0, tied.length)];
        if (run.halted(false)) return current();
        counts.moves++;
        const resource = /** @type {string} */ (chosen.resource);
        evaluator.apply({ op: 'assign', task: task.id, slot: demand.slot, resource });
        holders.add(resource);
        added.push(/** @type {Assignment} */ (Object.freeze({ resource, slot: demand.slot, task: task.id })));
      }
    }
  return current();
}
