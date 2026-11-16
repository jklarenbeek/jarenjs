//@ts-check
/**
 * @file The corpus run the corpus test asserts and the benchmark
 * publishes: every instance solved by every strategy that applies to it,
 * each answer held to the independent validator, with the proof of the
 * complete search wherever the oracle can enumerate the instance.
 */

import { admitProblem, registerRules, solve, SOLVE_LIMITS } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from '../rules/reference.js';
import { DAY_RULES } from '../rules/days.js';
import { rollingCap } from '../rules/rolling.js';
import { TRANSITIONS, fixtureProvider } from '../days-provider.js';
import { tinyInstance, spaceOf } from '../oracle/instances.js';
import { oracleOf, prove, validateAnswer } from '../oracle/validate.js';
import { DOMAINS, kindOf, domainInstance } from './domains.js';

/** Lists the oracle enumerates for a proof: larger spaces are validated answer by answer only. */
export const PROOF_SPACE = 20000;

/** The corpus: the tiny instances, then each domain at a small (enumerable) and a medium size. */
export function corpusInstances() {
  const out = [];
  for (let seed = 1; seed <= 30; seed++) out.push({ name: `tiny-${seed}`, domain: 'tiny', size: 'tiny', problem: tinyInstance(seed) });
  for (const domain of DOMAINS) {
    const small = domain === 'days' ? { resources: 2, tasks: 5 } : { resources: 3, tasks: 4 };
    const medium = domain === 'days' ? { resources: 4, tasks: 10 } : { resources: 8, tasks: 24 };
    for (let seed = 1; seed <= 3; seed++) out.push({ name: `${domain}-small-${seed}`, domain, size: 'small', problem: domainInstance(domain, seed, small, { maxSpace: PROOF_SPACE }) });
    for (let seed = 1; seed <= 2; seed++) out.push({ name: `${domain}-medium-${seed}`, domain, size: 'medium', problem: domainInstance(domain, seed, medium) });
  }
  return out;
}

const SETS = {
  reference: registerRules(REFERENCE_RULES),
  rolling: registerRules([...REFERENCE_RULES, rollingCap]),
  days: registerRules(DAY_RULES),
};
const DAYS = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });

/** The calls made on every instance; `exhaustive` only within SOLVE_LIMITS. */
export const CALLS = Object.freeze([
  { label: 'exhaustive', strategy: 'exhaustive', options: {} },
  { label: 'construct', strategy: 'construct', options: {} },
  { label: 'construct seed 7', strategy: 'construct', options: { seed: 7 } },
  { label: 'local', strategy: 'local', options: {} },
  { label: 'local seed 7, 2 restarts', strategy: 'local', options: { seed: 7, budgets: { maxRestarts: 2 } } },
  { label: 'local, 3 moves', strategy: 'local', options: { budgets: { maxMoves: 3 } } },
  { label: 'auto', strategy: 'auto', options: {} },
]);

/**
 * Solve one instance every applicable way and validate each answer.
 * @param {{ name: string, domain: string, problem: any }} instance
 * @returns {{ proof: import('../oracle/validate.js').Proof | null, runs: { label: string, strategy: string, status: string, answer: any, wrong: string[] }[], refused: string[] }}
 */
export function solveInstance(instance) {
  const kind = instance.domain === 'tiny' ? 'reference' : kindOf(instance.domain);
  const answerOf = oracleOf(kind, TRANSITIONS.zones);
  const space = spaceOf(instance.problem);
  const proof = space <= PROOF_SPACE ? prove(instance.problem, answerOf) : null;
  const problem = admitProblem(instance.problem);
  const ruleSet = SETS[kind];
  const runs = [];
  const refused = [];
  for (const call of CALLS) {
    const options = /** @type {any} */ ({ strategy: call.strategy, ...call.options, ...(kind === 'days' ? { days: DAYS } : {}) });
    if (call.strategy === 'exhaustive' && space > SOLVE_LIMITS.maxSpace) {
      try {
        solve(problem, ruleSet, options);
        refused.push(`${call.label} answered past SOLVE_LIMITS`);
      }
      catch (error) {
        if (/** @type {any} */ (error).code !== 'JN0024') throw error;
      }
      continue;
    }
    const answer = solve(problem, ruleSet, options);
    const wrong = validateAnswer(instance.problem, /** @type {any} */ (call.strategy), answer, answerOf,
      { stoppable: call.options.budgets !== undefined, proof });
    runs.push({ label: call.label, strategy: call.strategy, status: answer.status, answer, wrong });
  }
  return { proof, runs, refused };
}
