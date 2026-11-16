//@ts-check
/**
 * @file The oracle's optimum search: every assignment list of a problem
 * (`enumerate`), each scored by the oracle (`oracleScore`), and what a
 * complete search of that space can prove, read by brute force over
 * every pair. It imports only the oracle's own files.
 *
 * Semantics (shared with nothing in the engine):
 * - an unknown can only hide matches, so a list scores at best its
 *   oracle score and at worst that score with every level from the
 *   first level an unknown is reported at unbounded below;
 * - `optimal` when some list of verdict `feasible` scores at worst no
 *   less than every other list not of verdict `infeasible-by-validation`
 *   scores at best; its score is the optimum;
 * - `infeasible` when every list is `infeasible-by-validation`;
 * - else `feasible` when some list is `feasible`, else `unknown`;
 * - the best list's score: the best feasible score, else the best score
 *   of a list of verdict `unknown`, else the best score of any list;
 * - the bound: the best score of any list.
 */

import { oracleScore, LEVEL } from './score.js';
import { enumerate } from './instances.js';

const LEVELS = ['hard', 'service', 'soft'];

/**
 * @param {(bigint | null)[]} a @param {(bigint | null)[]} b
 * @returns {number} 1 when a is better
 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return -1;
    if (b[i] === null) return 1;
    return /** @type {bigint} */ (a[i]) > /** @type {bigint} */ (b[i]) ? 1 : -1;
  }
  return 0;
}

/**
 * @typedef {Object} OracleSolve
 * @property {'optimal' | 'infeasible' | 'feasible' | 'unknown'} status
 * @property {{ hard: string, service: string, soft: string }} score - the best list's score
 * @property {{ hard: string, service: string, soft: string }} bound
 * @property {number} lists
 * @property {number} undecided - lists of verdict unknown
 */

/**
 * @param {any} problem - raw problem JSON
 * @returns {OracleSolve}
 */
export function oracleSolve(problem) {
  const scored = [];
  for (const list of enumerate(problem)) {
    const answer = oracleScore(problem, list);
    const upper = LEVELS.map((level) => BigInt(/** @type {any} */ (answer.score)[level]));
    let first = 3;
    for (const line of answer.unknowns) first = Math.min(first, LEVELS.indexOf(LEVEL[line.split('|')[0]]));
    scored.push({ answer, upper, lower: upper.map((value, i) => (i >= first ? null : value)) });
  }
  const text = (/** @type {(bigint | null)[]} */ levels) => ({ hard: String(levels[0]), service: String(levels[1]), soft: String(levels[2]) });
  const best = (/** @type {typeof scored} */ list) => list.reduce((a, b) => (compare(b.upper, a.upper) > 0 ? b : a));
  const feasible = scored.filter((item) => item.answer.verdict === 'feasible');
  const unknown = scored.filter((item) => item.answer.verdict === 'unknown');
  const bound = text(best(scored).upper);
  let status = /** @type {OracleSolve['status']} */ ('unknown');
  if (feasible.length === 0 && unknown.length === 0) status = 'infeasible';
  else if (feasible.length > 0) {
    status = 'feasible';
    for (const candidate of feasible) {
      const beaten = scored.some((other) => other !== candidate && other.answer.verdict !== 'infeasible-by-validation'
        && compare(other.upper, candidate.lower) > 0);
      if (!beaten) status = 'optimal';
    }
  }
  const pick = feasible.length > 0 ? feasible : unknown.length > 0 ? unknown : scored;
  return { status, score: text(best(pick).upper), bound, lists: scored.length, undecided: unknown.length };
}
