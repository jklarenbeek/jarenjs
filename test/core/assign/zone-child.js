//@ts-check
/** @file Prints scorings as JSON, for the host-time-zone test to compare. */

import { registerRules, scoreAssignment, explain } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { rosterProblem } from './fixtures.js';
import { tinyInstance, enumerate } from './oracle/instances.js';
import { dayInstance } from './oracle/days.js';
import { fixtureProvider } from './days-provider.js';

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
// day-scoped scorings with the fixture provider, around both 2026 Amsterdam changes and Apia's skipped day
const dayRules = registerRules(DAY_RULES);
const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
for (const [anchor, zone] of /** @type {[string, string][]} */ ([['2026-03-29T01:00:00Z', 'Europe/Amsterdam'], ['2026-10-25T01:00:00Z', 'Europe/Amsterdam'], ['2011-12-30T10:00:00Z', 'Pacific/Apia']])) {
  const problem = dayInstance(7, Date.parse(anchor), zone);
  let n = 0;
  for (const assignments of enumerate(problem)) if (n++ % 13 === 0) out.push(scoreAssignment(problem, dayRules, assignments, { days }));
}
process.stdout.write(`${JSON.stringify(out)}\n`);
