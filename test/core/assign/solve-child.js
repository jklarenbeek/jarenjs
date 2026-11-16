//@ts-check
/** @file Prints solves as JSON, for the host-time-zone test to compare. */

import { registerRules, solve } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { tinyInstance } from './oracle/instances.js';
import { dayInstance } from './oracle/days.js';
import { fixtureProvider } from './days-provider.js';
import { ROSTER_RULES, rosterFixture, leastTimeRank } from './solve-fixtures.js';

const rules = registerRules(REFERENCE_RULES);
const out = [];
for (const seed of [3, 9, 21]) {
  out.push(solve(tinyInstance(seed), rules, { strategy: 'exhaustive' }));
  out.push(solve(tinyInstance(seed), rules, { strategy: 'construct', seed }));
}
const roster = rosterFixture(2);
out.push(solve(roster, registerRules(ROSTER_RULES), { strategy: 'construct', rank: leastTimeRank(roster) }));
const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
const dayRules = registerRules(DAY_RULES);
for (const [anchor, zone] of /** @type {[string, string][]} */ ([['2026-03-29T01:00:00Z', 'Europe/Amsterdam'], ['2011-12-30T10:00:00Z', 'Pacific/Apia']])) {
  const problem = dayInstance(7, Date.parse(anchor), zone);
  out.push(solve(problem, dayRules, { strategy: 'exhaustive', days, budgets: { maxNodes: 200 } }));
  out.push(solve(problem, dayRules, { strategy: 'construct', days }));
}
process.stdout.write(`${JSON.stringify(out)}\n`);
