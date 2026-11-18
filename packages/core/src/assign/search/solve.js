//@ts-check
/**
 * @file `solve`: propose assignments for a problem's open places with
 * the `exhaustive` or the `construct` strategy, improve or repair its
 * list with `local`, or let `auto` choose by size; re-validate the
 * proposal with a full scoring, and say how much the answer proves.
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
import { local } from './local.js';
import { churnOf, ChurnTotal, itemKey } from './churn.js';

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
/** @typedef {import('./churn.js').SolveChurn} SolveChurn */

/**
 * The size `exhaustive` is declared for: the number of candidates its
 * space may hold. Past it, `solve` with `exhaustive` refuses (`JN0024`)
 * before scoring anything and never switches to another strategy; `auto`
 * reads it to choose, and says in its provenance what it ran.
 * @type {Readonly<{ maxSpace: number }>}
 */
export const SOLVE_LIMITS = /* @__PURE__ */ Object.freeze({
  maxSpace: 100000,
});

/**
 * Counted work budgets; a search stops before work they do not cover.
 * `maxNodes` counts the candidates `exhaustive` scores (the problem as
 * given is the first), the places `construct` decides and the positions
 * `local` tries; `maxMoves` counts the evaluator answers each asks for
 * (an edit or a preview). `local` and `auto` take two more:
 * `maxRestarts`, the number of seeded restarts after the first descent
 * (it needs a seed), and `maxEditWork`, the rule evaluations over one
 * unit the evaluator may make (`EvaluatorCounts.evaluated`, the first
 * full scoring included), checked before each move.
 * @typedef {{ maxNodes?: number, maxMoves?: number, maxRestarts?: number, maxEditWork?: number }} SolveBudgets
 */

/**
 * @typedef {Object} SolveOptions
 * @property {'exhaustive' | 'construct' | 'local' | 'auto'} strategy
 * @property {number} [seed] - not for exhaustive: a whole number from 0 to 4294967295
 *   that breaks ties (and draws `local`'s restarts); without one, the first in order wins
 * @property {SolveBudgets} [budgets]
 * @property {RankHook} [rank] - construct and auto only: the host's candidate order
 * @property {{ readonly aborted: boolean }} [signal] - an AbortSignal, read before each node and move
 * @property {AssignLimits} [limits] - each scoring's limits, as `scoreAssignment` takes them
 * @property {CivilDays} [days] - the civil-day seam, as `scoreAssignment` takes it
 */

/**
 * What a solve did, counted. `space` is the number of candidates of the
 * exhaustive space (null when it was not counted); `undecided` counts
 * the scorings the search made whose verdict was `unknown` (a hard rule
 * could not decide) or that stopped at a limit. `local` and `auto`
 * also count the restarts made and the evaluator's rule evaluations
 * over one unit (`editWork`). `construct`, `local` and `auto` count the
 * evaluator answers (edits and previews) in which a rule was evaluated
 * over every unit of its scope because it read outside its row
 * (`fullFallbacks`, `EvaluatorCounts.fullFallbacks`; one per such rule
 * per answer), so a host sees why each move cost a full re-evaluation.
 * @typedef {Object} SolveCounts
 * @property {number} nodes
 * @property {number} moves
 * @property {number} ranked - rank hook answers
 * @property {number} undecided
 * @property {number | null} space
 * @property {number} [restarts]
 * @property {number} [editWork]
 * @property {number} [fullFallbacks]
 */

/**
 * What produced a solve: the scoring's provenance of the problem as
 * given (its revision, fact and baseline revisions, the rule set and the
 * days provider), the strategy that ran as `algorithm`, the seed, the
 * budgets (null for none), each scoring's limits and whether a rank
 * hook ordered the candidates. For `local` and `auto`, `strategy` is the
 * one asked for, `algorithm` what ran (`auto` runs `exhaustive`,
 * `construct` and, unless construct was stopped, `construct+local`) and
 * `budgets` names all four.
 * @typedef {Omit<AssignProvenance, 'algorithm'> & {
 *   algorithm: 'exhaustive' | 'construct' | 'local' | 'construct+local',
 *   budgets: { maxEditWork?: number | null, maxMoves: number | null, maxNodes: number | null, maxRestarts?: number | null },
 *   limits: Required<AssignLimits>,
 *   rank: boolean,
 *   seed: number | null,
 *   strategy?: 'local' | 'auto',
 * }} SolveProvenance
 */

/**
 * A solve's answer. `best` is the whole assignment list proposed (the
 * problem's own assignments and the ones the solve adds, in `added`;
 * for `local` and `auto`, `removed` lists the problem's own assignments
 * it no longer holds), and `score` is `scoreAssignment` of it, made
 * again after the search. `bound`, when present, is a score no candidate
 * of the space can beat. `churn`, for `local` and `auto` on a problem
 * with a baseline, is how `best` differs from the baseline; it is never
 * part of `score`.
 * @typedef {Object} SolveResult
 * @property {'optimal' | 'infeasible' | 'feasible' | 'limit' | 'unknown'} status
 * @property {readonly Assignment[]} added
 * @property {readonly Assignment[]} [removed]
 * @property {readonly Assignment[]} best
 * @property {Readonly<SolveChurn>} [churn]
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
 * @property {(node: boolean, need?: number) => boolean} halted - whether the next node
 *   (true) or the next `need` moves (false; one unless given) are past a budget, or the
 *   signal aborted; it records why
 */

const OPTIONS = /* @__PURE__ */ Object.freeze(['strategy', 'seed', 'budgets', 'rank', 'signal', 'limits', 'days']);
const BUDGETS = /* @__PURE__ */ Object.freeze(['maxNodes', 'maxMoves', 'maxRestarts', 'maxEditWork']);
const STRATEGIES = /* @__PURE__ */ Object.freeze(['exhaustive', 'construct', 'local', 'auto']);

/**
 * Read solve's options.
 * @param {unknown} options
 * @returns {{ strategy: 'exhaustive' | 'construct' | 'local' | 'auto', seed: number | null, maxNodes: number | null, maxMoves: number | null,
 *   maxRestarts: number | null, maxEditWork: number | null,
 *   rank: RankHook | undefined, signal: { readonly aborted: boolean } | undefined, scoring: { limits?: AssignLimits, days?: CivilDays } }}
 */
function optionsOf(options) {
  if (!isRecord(options)) throw new AssignError('JN0015', 'solve options are { strategy, seed?, budgets?, rank?, signal?, limits?, days? }', '/options');
  for (const key of Object.keys(options))
    if (!OPTIONS.includes(key)) throw new AssignError('JN0015', `${key} is not a solve option`, `/options/${pointer(key)}`);
  const strategy = /** @type {'exhaustive' | 'construct' | 'local' | 'auto'} */ (options.strategy);
  if (!STRATEGIES.includes(strategy))
    throw new AssignError('JN0015', `the strategy is exhaustive, construct, local or auto, not ${JSON.stringify(strategy) ?? String(strategy)}`, '/options/strategy');
  const searches = strategy === 'local' || strategy === 'auto';
  let seed = null;
  if (options.seed !== undefined) {
    if (strategy === 'exhaustive') throw new AssignError('JN0015', 'exhaustive takes no seed: a tie goes to the first candidate it visits', '/options/seed');
    if (!Number.isSafeInteger(options.seed) || /** @type {number} */ (options.seed) < 0 || /** @type {number} */ (options.seed) > 0xFFFFFFFF)
      throw new AssignError('JN0015', `a seed is a whole number from 0 to 4294967295, not ${String(options.seed)}`, '/options/seed');
    seed = /** @type {number} */ (options.seed);
  }
  const rank = options.rank;
  if (rank !== undefined) {
    if (strategy === 'exhaustive') throw new AssignError('JN0015', 'exhaustive takes no rank: it visits every candidate', '/options/rank');
    if (strategy === 'local') throw new AssignError('JN0015', 'local takes no rank: it takes an edit only when the objective prefers it', '/options/rank');
    if (typeof rank !== 'function') throw new AssignError('JN0015', 'rank is a function (candidate, state) answering an integer', '/options/rank');
  }
  /** @type {Record<string, number | null>} */
  const budgets = { maxNodes: null, maxMoves: null, maxRestarts: null, maxEditWork: null };
  if (options.budgets !== undefined) {
    if (!isRecord(options.budgets)) throw new AssignError('JN0015', 'budgets is { maxNodes?, maxMoves?, maxRestarts?, maxEditWork? }', '/options/budgets');
    for (const [name, value] of Object.entries(options.budgets)) {
      if (!BUDGETS.includes(name)) throw new AssignError('JN0015', `${name} is not a solve budget`, `/options/budgets/${pointer(name)}`);
      if (!searches && (name === 'maxRestarts' || name === 'maxEditWork'))
        throw new AssignError('JN0015', `${name} is a budget of local and auto, not of ${strategy}`, `/options/budgets/${pointer(name)}`);
      if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
        throw new AssignError('JN0015', `${name} is a whole number from 1, not ${String(value)}`, `/options/budgets/${pointer(name)}`);
      budgets[name] = /** @type {number} */ (value);
    }
  }
  if (budgets.maxRestarts !== null && seed === null)
    throw new AssignError('JN0015', 'a restart is a seeded perturbation: maxRestarts needs a seed', '/options/budgets/maxRestarts');
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
    strategy, seed, maxNodes: budgets.maxNodes, maxMoves: budgets.maxMoves, maxRestarts: budgets.maxRestarts, maxEditWork: budgets.maxEditWork,
    rank: /** @type {RankHook | undefined} */ (rank),
    signal: /** @type {{ readonly aborted: boolean } | undefined} */ (signal),
    scoring,
  };
}

/**
 * The exhaustive space of a problem for `auto`, or null past the limit.
 * @param {ProblemIndex} index
 * @returns {ReturnType<typeof spaceOf> | null}
 */
function autoSpaceOf(index) {
  try {
    return spaceOf(index, SOLVE_LIMITS.maxSpace);
  }
  catch (error) {
    if (error instanceof AssignError && error.code === 'JN0024') return null;
    throw error;
  }
}

/**
 * What `local` holds and the locks it gives back. A fill (`auto`) holds
 * every assignment the problem already has. A repair (`local`) holds the
 * `hard`-locked ones, and the `soft`-locked ones it could not count as
 * churn: every one when the problem has no baseline, else the ones the
 * baseline does not hold. Any other may change; a `soft` lock it changes
 * is then a change against the baseline, listed in the churn.
 * @param {ProblemIndex} index @param {boolean} fill
 * @returns {{ held: Set<string>, locks: Map<string, 'hard' | 'soft'> }}
 */
function holdsOf(index, fill) {
  const baseline = index.problem.baseline;
  const base = new Set((baseline?.assignments ?? []).map((item) => itemKey(item.task, item.slot, item.resource)));
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Map<string, 'hard' | 'soft'>} */
  const locks = new Map();
  for (const item of index.problem.assignments ?? []) {
    const key = itemKey(item.task, item.slot, item.resource);
    if (item.lock !== undefined) locks.set(key, item.lock);
    if (fill || item.lock === 'hard' || (item.lock === 'soft' && (baseline === undefined || !base.has(key)))) held.add(key);
  }
  return { held, locks };
}

/**
 * Propose assignments for a problem. An open place is a demand slot's
 * room past the assignments the problem already holds.
 *
 * - `exhaustive` scores every candidate of the space: the problem's own
 *   assignments, kept as they are, plus per slot a set of resources not
 *   already in it no larger than its room (a place may stay open); at
 *   most `SOLVE_LIMITS.maxSpace` candidates, else `JN0024`. It proves
 *   what it can: `optimal` when the best feasible candidate is no worse
 *   than any candidate could be, whatever its unknowns would decide;
 *   `infeasible` when every candidate has a hard match. When a hard rule
 *   could not decide (or a scoring stopped at a limit) for a candidate
 *   that could beat it, the answer is `feasible` with a validated
 *   feasible best, else `unknown`.
 * - `construct` fills the same places greedily (see `rank`).
 * - `local` improves the problem's own list, or repairs it: it assigns,
 *   unassigns, moves and swaps, one strictly better edit at a time (see
 *   the objective below), never touching a `hard`-locked assignment, nor
 *   a `soft`-locked one whose change it cannot count as churn (no
 *   baseline, or one the baseline does not hold).
 * - `auto` runs `exhaustive` when its space is within
 *   `SOLVE_LIMITS.maxSpace`, else `construct` and then `local` over the
 *   same space (the problem's own assignments kept); `provenance.algorithm`
 *   names what ran.
 *
 * The objective of `local` is lexicographic: the class (feasible, then
 * undecided, then infeasible by validation), the hard and service
 * levels, then, with a baseline, the churn total (fewer changes first),
 * then the soft level. `auto` keeps the other strategies' order, so its
 * two paths answer one question. Churn is never part of `score`; a host
 * that wants churn scored writes a rule that reads `baseline()`.
 *
 * `construct`, `local` and `auto`'s construct path answer `feasible` for
 * a validated feasible proposal, else `unknown`, and never `optimal` or
 * `infeasible`. A search stopped by a budget or the signal answers
 * `limit` (with `cancelled: true` for the signal) and the best it held.
 * In every case `score` is a fresh `scoreAssignment` of `best`, and the
 * search's own scoring of it must be the same bytes. The same inputs,
 * seed and budgets give the same bytes; no clock is read and work is
 * counted. The answer is a proposal: nothing is written, and the host
 * rechecks revisions and authority before applying it.
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
  const searches = read.strategy === 'local' || read.strategy === 'auto';
  const space = read.strategy === 'exhaustive' ? spaceOf(index, SOLVE_LIMITS.maxSpace) : read.strategy === 'auto' ? autoSpaceOf(index) : null;
  const evaluator = createEvaluator(index.problem, set, index.problem.assignments, read.scoring);
  /** @type {SolveCounts} */
  const counts = { nodes: 0, moves: 0, ranked: 0, undecided: 0, space: null };
  if (searches) {
    counts.restarts = 0;
    counts.editWork = 0;
  }
  /** @type {'budget' | 'abort' | null} */
  let stopped = null;
  /** @type {Run} */
  const run = {
    index, evaluator, counts,
    halted(node, need = 1) {
      if (read.signal?.aborted === true) stopped = 'abort';
      else if (node && read.maxNodes !== null && counts.nodes >= read.maxNodes) stopped = 'budget';
      else if (!node && read.maxMoves !== null && counts.moves + need > read.maxMoves) stopped = 'budget';
      else if (!node && read.maxEditWork !== null && evaluator.counts.evaluated >= read.maxEditWork) stopped = 'budget';
      return stopped !== null;
    },
  };
  const baseline = index.problem.baseline;
  /** @type {SolveProvenance['algorithm']} */
  let algorithm = read.strategy === 'auto' ? (space === null ? 'construct' : 'exhaustive') : read.strategy;
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
      if (read.strategy === 'local') best = local(run, { ...holdsOf(index, false), churn: baseline === undefined ? null : new ChurnTotal(baseline.assignments, evaluator.assignments), seed: read.seed, maxRestarts: read.maxRestarts });
      else {
        best = construct(run, read.rank, read.seed);
        if (read.strategy === 'auto' && stopped === null) {
          algorithm = 'construct+local';
          best = local(run, { ...holdsOf(index, true), churn: null, seed: read.seed, maxRestarts: read.maxRestarts });
        }
      }
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
  if (searches) counts.editWork = evaluator.counts.evaluated;
  if (searches || read.strategy === 'construct') counts.fullFallbacks = evaluator.counts.fullFallbacks;
  const score = scoreAssignment(index.problem, set, best.list, read.scoring);
  if (stableStringify(score) !== stableStringify(best.result))
    throw new AssignError('JN0026', 'a fresh scoring of the best list differs from the search\'s scoring of it: a rule reads state past its view', '/ruleSet');
  const key = (/** @type {Assignment} */ item) => JSON.stringify([item.task, item.slot, item.resource]);
  const own = index.problem.assignments ?? [];
  const fixed = new Set(own.map(key));
  const provenance = provenanceOf(index, set, own, read.scoring.days);
  /** @type {Record<string, unknown>} */
  const extra = {};
  if (searches) {
    const kept = new Set(best.list.map(key));
    extra.removed = Object.freeze(own.filter((item) => !kept.has(key(item))));
    if (baseline !== undefined) extra.churn = churnOf(baseline.assignments, best.list);
  }
  return /** @type {SolveResult} */ (Object.freeze({
    added: Object.freeze(best.list.filter((item) => !fixed.has(key(item)))),
    best: best.list,
    ...(bound === null ? {} : { bound }),
    ...(stopped === 'abort' ? { cancelled: /** @type {const} */ (true) } : {}),
    ...('churn' in extra ? { churn: extra.churn } : {}),
    counts: Object.freeze({ ...counts }),
    provenance: /** @type {SolveProvenance} */ (Object.freeze({
      ...provenance,
      algorithm,
      budgets: Object.freeze(searches
        ? { maxEditWork: read.maxEditWork, maxMoves: read.maxMoves, maxNodes: read.maxNodes, maxRestarts: read.maxRestarts }
        : { maxMoves: read.maxMoves, maxNodes: read.maxNodes }),
      limits: Object.freeze(limitsOf(read.scoring)),
      rank: read.rank !== undefined,
      seed: read.seed,
      ...(searches ? { strategy: read.strategy } : {}),
    })),
    ...('removed' in extra ? { removed: extra.removed } : {}),
    score,
    status,
  }));
}
