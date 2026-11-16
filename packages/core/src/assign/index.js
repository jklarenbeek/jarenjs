//@ts-check

/**
 * `@jarenjs/core/assign` - the assignment engine's mechanism without its
 * vocabulary: an assignment problem as plain revisioned JSON (resources,
 * timed tasks with demand slots, fact tables, assignments with locks and
 * a baseline) admitted against its schema twin; the rule contract
 * through which the host supplies every constraint (the engine ships no
 * rules); and exact, explained scoring, where the lexicographic score
 * (hard, service, soft) is the integer sum of the matches it reports, an
 * undecided hard rule makes the verdict unknown and never feasible, and
 * a scoring past its limits is incomplete and claims no total; and an
 * evaluator that, after an edit or for a hypothetical one, re-evaluates
 * only the units the edit touches and answers the bytes full scoring
 * answers; and `solve`, which proposes assignments for the open places
 * by exhaustive enumeration (within a declared size) or a greedy fill,
 * improves or repairs a list by local search against a baseline (hard
 * locks never move, soft ones only as churn, which it reports beside the
 * score), re-validates the proposal and says how much its status proves. Pure
 * JSON in and out, no clock, no storage. A `resource-day` rule's civil days
 * come through `@jarenjs/core/assign/days`, so this entry carries no
 * calendar. See docs/ASSIGN.md.
 * @module
 */

export { AssignError, ASSIGN_CODES } from './errors.js';
export { admitProblem } from './model.js';
export { registerRules } from './rules.js';
export { scoreAssignment, compareScores, ASSIGN_LIMITS } from './score.js';
export { explain } from './explain.js';
export { createEvaluator } from './incremental.js';
export { solve, SOLVE_LIMITS } from './search/solve.js';

/** @typedef {import('./model.js').AssignProblem} AssignProblem */
/** @typedef {import('./model.js').AssignResource} AssignResource */
/** @typedef {import('./model.js').AssignTask} AssignTask */
/** @typedef {import('./model.js').AssignDemand} AssignDemand */
/** @typedef {import('./model.js').AssignInterval} AssignInterval */
/** @typedef {import('./model.js').AssignFact} AssignFact */
/** @typedef {import('./model.js').AssignBaseline} AssignBaseline */
/** @typedef {import('./model.js').Assignment} Assignment */
/** @typedef {import('./model.js').Revision} Revision */
/** @typedef {import('./rules.js').AssignRule} AssignRule */
/** @typedef {import('./rules.js').RegisteredRule} RegisteredRule */
/** @typedef {import('./rules.js').RuleSet} RuleSet */
/** @typedef {import('./rules.js').RuleUnit} RuleUnit */
/** @typedef {import('./rules.js').RuleAnswer} RuleAnswer */
/** @typedef {import('./rules.js').RuleMatchInput} RuleMatchInput */
/** @typedef {import('./rules.js').RuleUnknownInput} RuleUnknownInput */
/** @typedef {import('./rules.js').RuleLevel} RuleLevel */
/** @typedef {import('./rules.js').RuleScope} RuleScope */
/** @typedef {import('./view.js').AssignView} AssignView */
/** @typedef {import('./day-table.js').AssignDay} AssignDay */
/** @typedef {import('./day-table.js').DayPiece} DayPiece */
/** @typedef {import('./score.js').AssignResult} AssignResult */
/** @typedef {import('./score.js').AssignCompleteResult} AssignCompleteResult */
/** @typedef {import('./score.js').AssignIncompleteResult} AssignIncompleteResult */
/** @typedef {import('./score.js').AssignScore} AssignScore */
/** @typedef {import('./score.js').AssignMatch} AssignMatch */
/** @typedef {import('./score.js').AssignUnknown} AssignUnknown */
/** @typedef {import('./score.js').AssignCounts} AssignCounts */
/** @typedef {import('./score.js').AssignProvenance} AssignProvenance */
/** @typedef {import('./score.js').AssignLimits} AssignLimits */
/** @typedef {import('./explain.js').Explanation} Explanation */
/** @typedef {import('./incremental.js').AssignEvaluator} AssignEvaluator */
/** @typedef {import('./incremental.js').AssignEdit} AssignEdit */
/** @typedef {import('./incremental.js').EvaluatorCounts} EvaluatorCounts */
/** @typedef {import('./explain.js').ExplainGroup} ExplainGroup */
/** @typedef {import('./search/solve.js').SolveOptions} SolveOptions */
/** @typedef {import('./search/solve.js').SolveBudgets} SolveBudgets */
/** @typedef {import('./search/solve.js').SolveResult} SolveResult */
/** @typedef {import('./search/solve.js').SolveCounts} SolveCounts */
/** @typedef {import('./search/solve.js').SolveProvenance} SolveProvenance */
/** @typedef {import('./search/churn.js').SolveChurn} SolveChurn */
/** @typedef {import('./search/construct.js').RankHook} RankHook */
/** @typedef {import('./search/construct.js').RankCandidate} RankCandidate */
/** @typedef {import('./search/construct.js').RankState} RankState */
