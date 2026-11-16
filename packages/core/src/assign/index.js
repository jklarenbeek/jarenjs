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
 * a scoring past its limits is incomplete and claims no total. Pure JSON
 * in and out, no clock, no storage. See docs/ASSIGN.md.
 * @module
 */

export { AssignError, ASSIGN_CODES } from './errors.js';
export { admitProblem } from './model.js';
export { registerRules } from './rules.js';
export { scoreAssignment, compareScores, ASSIGN_LIMITS } from './score.js';
export { explain } from './explain.js';

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
/** @typedef {import('./explain.js').ExplainGroup} ExplainGroup */
