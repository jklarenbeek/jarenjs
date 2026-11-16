//@ts-check
/**
 * @file `solve`: propose assignments for a problem's open places with
 * the `exhaustive` or the `construct` strategy, re-validate the proposal
 * with a full scoring, and say how much the answer proves.
 */

import { AssignError } from '../errors.js';
import { indexOfProblem, isRecord, pointer } from '../model.js';
import { ruleSetOf } from '../rules.js';
import { limitsOf, provenanceOf, scoreAssignment, seamOf } from '../score.js';
import { createEvaluator } from '../incremental.js';
import { stableStringify } from '../../object.js';
import { classOf, FEASIBLE } from './order.js';
import { exhaustive, spaceOf } from './exhaustive.js';
import { construct } from './construct.js';

/** @typedef {import('../model.js').Assignment} Assignment */
/** @typedef {import('../model.js').ProblemIndex} ProblemIndex */
/** @typedef {import('../rules.js').RuleSet} RuleSet */
/** @typedef {import('../score.js').AssignResult} AssignResult */
/** @typedef {import('../score.js').AssignScore} AssignScore */
/** @typedef {import('../score.js').AssignLimits} AssignLimits */
/** @typedef {import('../score.js').AssignProvenance} AssignProvenance */
/** @typedef {import('../days.js').CivilDays} CivilDays */
/** @typedef {import('./construct.js').RankHook} RankHook */
/** @typedef {import('./construct.js').RankCandidate} RankCandidate */
/** @typedef {import('./construct.js').RankState} RankState */

/**
 * The size `exhaustive` is declared for: the number of candidates its
 * space may hold. Past it, `solve` refuses (`JN0024`) before scoring
 * anything, and never switches to another strategy.
 * @type {Readonly<{ maxSpace: number }>}
 */
export const SOLVE_LIMITS = /* @__PURE__ */ Object.freeze({
  maxSpace: 100000,
});

/**
 * Counted work budgets; a search stops before work they do not cover.
 * `maxNodes` counts the candidates `exhaustive` scores (the problem as
 * given is the first) and the places `construct` decides; `maxMoves`
 * counts the evaluator answers both ask for (an edit or a preview).
 * @typedef {{ maxNodes?: number, maxMoves?: number }} SolveBudgets
 */

/**
 * @typedef {Object} SolveOptions
 * @property {'exhaustive' | 'construct'} strategy
 * @property {number} [seed] - construct only: a whole number from 0 to 4294967295
 *   that breaks ties between resources; without one, the first in id order wins
 * @property {SolveBudgets} [budgets]
 * @property {RankHook} [rank] - construct only: the host's candidate order
 * @property {{ readonly aborted: boolean }} [signal] - an AbortSignal, read before each node and move
 * @property {AssignLimits} [limits] - each scoring's limits, as `scoreAssignment` takes them
 * @property {CivilDays} [days] - the civil-day seam, as `scoreAssignment` takes it
 */

/**
 * What a solve did, counted. `space` is the number of candidates of the
 * exhaustive space (null for construct); `undecided` counts the scorings
 * the search made whose verdict was `unknown` (a hard rule could not
 * decide) or that stopped at a limit.
 * @typedef {Object} SolveCounts
 * @property {number} nodes
 * @property {number} moves
 * @property {number} ranked - rank hook answers
 * @property {number} undecided
 * @property {number | null} space
 */

/**
 * What produced a solve: the scoring's provenance of the problem as
 * given (its revision, fact and baseline revisions, the rule set and the
 * days provider), the strategy as `algorithm`, the seed, the budgets
 * (null for none), each scoring's limits and whether a rank hook ordered
 * the candidates.
 * @typedef {Omit<AssignProvenance, 'algorithm'> & {
 *   algorithm: 'exhaustive' | 'construct',
 *   budgets: { maxMoves: number | null, maxNodes: number | null },
 *   limits: Required<AssignLimits>,
 *   rank: boolean,
 *   seed: number | null,
 * }} SolveProvenance
 */

/**
 * A solve's answer. `best` is the whole assignment list proposed (the
 * problem's own assignments and the ones the solve adds, in `added`),
 * and `score` is `scoreAssignment` of it, made again after the search.
 * `bound`, when present, is a score no candidate of the space can beat.
 * @typedef {Object} SolveResult
 * @property {'optimal' | 'infeasible' | 'feasible' | 'limit' | 'unknown'} status
 * @property {readonly Assignment[]} added
 * @property {readonly Assignment[]} best
 * @property {AssignResult} score
 * @property {AssignScore} [bound]
 * @property {true} [cancelled] - the signal stopped the search (status `limit`)
 * @property {Readonly<SolveCounts>} counts
 * @property {SolveProvenance} provenance
 */

/**
 * One search in progress, as the strategies see it.
 * @typedef {Object} Run
 * @property {ProblemIndex} index
 * @property {import('../incremental.js').AssignEvaluator} evaluator
 * @property {SolveCounts} counts
 * @property {(node: boolean) => boolean} halted - whether the next node (true) or
 *   move (false) is past a budget or the signal aborted; it records why
 */

const OPTIONS = /* @__PURE__ */ Object.freeze(['strategy', 'seed', 'budgets', 'rank', 'signal', 'limits', 'days']);
const BUDGETS = /* @__PURE__ */ Object.freeze(['maxNodes', 'maxMoves']);

/**
 * Read solve's options.
 * @param {unknown} options
 * @returns {{ strategy: 'exhaustive' | 'construct', seed: number | null, maxNodes: number | null, maxMoves: number | null,
 *   rank: RankHook | undefined, signal: { readonly aborted: boolean } | undefined, scoring: { limits?: AssignLimits, days?: CivilDays } }}
 */
function optionsOf(options) {
  if (!isRecord(options)) throw new AssignError('JN0015', 'solve options are { strategy, seed?, budgets?, rank?, signal?, limits?, days? }', '/options');
  for (const key of Object.keys(options))
    if (!OPTIONS.includes(key)) throw new AssignError('JN0015', `${key} is not a solve option`, `/options/${pointer(key)}`);
  const strategy = options.strategy;
  if (strategy !== 'exhaustive' && strategy !== 'construct')
    throw new AssignError('JN0015', `the strategy is exhaustive or construct, not ${JSON.stringify(strategy) ?? String(strategy)}`, '/options/strategy');
  let seed = null;
  if (options.seed !== undefined) {
    if (strategy !== 'construct') throw new AssignError('JN0015', 'exhaustive takes no seed: a tie goes to the first candidate it visits', '/options/seed');
    if (!Number.isSafeInteger(options.seed) || /** @type {number} */ (options.seed) < 0 || /** @type {number} */ (options.seed) > 0xFFFFFFFF)
      throw new AssignError('JN0015', `a seed is a whole number from 0 to 4294967295, not ${String(options.seed)}`, '/options/seed');
    seed = /** @type {number} */ (options.seed);
  }
  const rank = options.rank;
  if (rank !== undefined) {
    if (strategy !== 'construct') throw new AssignError('JN0015', 'exhaustive takes no rank: it visits every candidate', '/options/rank');
    if (typeof rank !== 'function') throw new AssignError('JN0015', 'rank is a function (candidate, state) answering an integer', '/options/rank');
  }
  /** @type {Record<string, number | null>} */
  const budgets = { maxNodes: null, maxMoves: null };
  if (options.budgets !== undefined) {
    if (!isRecord(options.budgets)) throw new AssignError('JN0015', 'budgets is { maxNodes?, maxMoves? }', '/options/budgets');
    for (const [name, value] of Object.entries(options.budgets)) {
      if (!BUDGETS.includes(name)) throw new AssignError('JN0015', `${name} is not a solve budget`, `/options/budgets/${pointer(name)}`);
      if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
        throw new AssignError('JN0015', `${name} is a whole number from 1, not ${String(value)}`, `/options/budgets/${pointer(name)}`);
      budgets[name] = /** @type {number} */ (value);
    }
  }
  const signal = options.signal;
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || typeof (/** @type {any} */ (signal)).aborted !== 'boolean'))
    throw new AssignError('JN0015', 'signal is an AbortSignal', '/options/signal');
  /** @type {{ limits?: AssignLimits, days?: CivilDays }} */
  const scoring = {};
  if (options.limits !== undefined) scoring.limits = /** @type {AssignLimits} */ (options.limits);
  if (options.days !== undefined) scoring.days = /** @type {CivilDays} */ (options.days);
  limitsOf(scoring);
  seamOf(scoring);
  return {
    strategy, seed, maxNodes: budgets.maxNodes, maxMoves: budgets.maxMoves,
    rank: /** @type {RankHook | undefined} */ (rank),
    signal: /** @type {{ readonly aborted: boolean } | undefined} */ (signal),
    scoring,
  };
}

/**
 * Propose assignments for the open places of a problem: each demand
 * slot's room past the assignments the problem already holds. Those
 * stay as they are (a solve fills; it does not repair), and a candidate
 * is the problem's list plus, per slot, a set of resources not already
 * in it no larger than its room; a place may stay open.
 *
 * - `exhaustive` scores every candidate of the space (at most
 *   `SOLVE_LIMITS.maxSpace`, else `JN0024`), each with the evaluator's
 *   exact answer, and proves what it can: `optimal` when the best
 *   feasible candidate is no worse than any candidate could be, whatever
 *   its unknowns would decide; `infeasible` when every candidate has a
 *   hard match. When a hard rule could not decide (or a scoring stopped
 *   at a limit) for a candidate that could beat it, the answer is
 *   `feasible` with a validated feasible best, else `unknown`.
 * - `construct` fills the places greedily (see `rank`), and answers
 *   `feasible` for a validated feasible proposal, else `unknown`; it
 *   never answers `optimal` or `infeasible`.
 *
 * A search stopped by a budget or the signal answers `limit` (with
 * `cancelled: true` for the signal) and the best it held. In every case
 * `score` is a fresh `scoreAssignment` of `best`, and the search's own
 * scoring of it must be the same bytes. The same inputs, seed and
 * budgets give the same bytes; no clock is read and work is counted.
 * The answer is a proposal: nothing is written, and the host rechecks
 * revisions and authority before applying it.
 * @param {unknown} problem - admitted with `admitProblem` when it is not yet
 * @param {RuleSet} ruleSet - from `registerRules`
 * @param {SolveOptions} options
 * @returns {SolveResult}
 * @throws {AssignError} JN0015 for an option out of form, JN0024 for an
 *   exhaustive space past its limit, JN0025 for a rank hook that threw or
 *   answered other than an integer, JN0026 when the fresh scoring of
 *   `best` differs from the search's, and what `scoreAssignment` throws
 */
export function solve(problem, ruleSet, options) {
  const index = indexOfProblem(problem);
  const set = ruleSetOf(ruleSet);
  const read = optionsOf(options);
  const space = read.strategy === 'exhaustive' ? spaceOf(index, SOLVE_LIMITS.maxSpace) : null;
  const evaluator = createEvaluator(index.problem, set, index.problem.assignments, read.scoring);
  /** @type {SolveCounts} */
  const counts = { nodes: 0, moves: 0, ranked: 0, undecided: 0, space: null };
  /** @type {'budget' | 'abort' | null} */
  let stopped = null;
  /** @type {Run} */
  const run = {
    index, evaluator, counts,
    halted(node) {
      if (read.signal?.aborted === true) stopped = 'abort';
      else if (node && read.maxNodes !== null && counts.nodes >= read.maxNodes) stopped = 'budget';
      else if (!node && read.maxMoves !== null && counts.moves >= read.maxMoves) stopped = 'budget';
      return stopped !== null;
    },
  };
  /** @type {import('./order.js').Candidate} */
  let best;
  /** @type {SolveResult['status']} */
  let status;
  /** @type {AssignScore | null} */
  let bound = null;
  try {
    if (space !== null) {
      const found = exhaustive(run, space);
      best = found.best;
      status = found.status ?? 'limit';
      bound = found.bound;
    }
    else {
      best = construct(run, read.rank, read.seed);
      status = classOf(best.result) === FEASIBLE ? 'feasible' : 'unknown';
    }
  }
  finally {
    evaluator.close();
  }
  if (stopped !== null) {
    status = 'limit';
    bound = null;
  }
  const score = scoreAssignment(index.problem, set, best.list, read.scoring);
  if (stableStringify(score) !== stableStringify(best.result))
    throw new AssignError('JN0026', 'a fresh scoring of the best list differs from the search\'s scoring of it: a rule reads state past its view', '/ruleSet');
  const key = (/** @type {Assignment} */ item) => JSON.stringify([item.task, item.slot, item.resource]);
  const fixed = new Set((index.problem.assignments ?? []).map(key));
  const provenance = provenanceOf(index, set, index.problem.assignments ?? [], read.scoring.days);
  return Object.freeze({
    added: Object.freeze(best.list.filter((item) => !fixed.has(key(item)))),
    best: best.list,
    ...(bound === null ? {} : { bound }),
    ...(stopped === 'abort' ? { cancelled: /** @type {const} */ (true) } : {}),
    counts: Object.freeze({ ...counts }),
    provenance: /** @type {SolveProvenance} */ (Object.freeze({
      ...provenance,
      algorithm: read.strategy,
      budgets: Object.freeze({ maxMoves: read.maxMoves, maxNodes: read.maxNodes }),
      limits: Object.freeze(limitsOf(read.scoring)),
      rank: read.rank !== undefined,
      seed: read.seed,
    })),
    score,
    status,
  });
}
