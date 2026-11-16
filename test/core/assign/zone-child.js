//@ts-check
/** @file Prints scorings as JSON, for the host-time-zone test to compare. */

import { registerRules, scoreAssignment, explain } from '@jarenjs/core/assign';
import { REFERENCE_RULES } from './rules/reference.js';
import { rosterProblem } from './fixtures.js';
import { tinyInstance, enumerate } from './oracle/instances.js';

const rules = registerRules(REFERENCE_RULES);
const out = [];
const roster = scoreAssignment(rosterProblem(), rules, [
  { task: 'mon-early', slot: 'lead', resource: 'nina' }, { task: 'mon-early', slot: 'crew', resource: 'ari' }, { task: 'mon-late', slot: 'crew', resource: 'ari' }]);
out.push(roster, explain(roster, { group: 'task' }));
for (const seed of [3, 11, 19]) {
  const problem = tinyInstance(seed);
  let n = 0;
  for (const assignments of enumerate(problem)) if (n++ % 17 === 0) out.push(scoreAssignment(problem, rules, assignments));
}
process.stdout.write(`${JSON.stringify(out)}\n`);
