//@ts-check
/** @file Prints local and auto solves as JSON, for the host-time-zone test to compare. */

import { registerRules, solve } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from './rules/reference.js';
import { DAY_RULES } from './rules/days.js';
import { tinyInstance } from './oracle/instances.js';
import { dayInstance } from './oracle/days.js';
import { fixtureProvider } from './days-provider.js';
import { ROSTER_RULES, rosterFixture } from './solve-fixtures.js';
import { REPAIR_RULES, rosterRepair } from './local-fixtures.js';

const out = [];
const { problem } = rosterRepair(2, 's3', 7, 12);
out.push(solve(problem, registerRules(REPAIR_RULES), { strategy: 'local', seed: 2, budgets: { maxRestarts: 2 } }));
out.push(solve(tinyInstance(9), registerRules(REFERENCE_RULES), { strategy: 'auto', seed: 9 }));
out.push(solve(rosterFixture(5), registerRules(ROSTER_RULES), { strategy: 'auto', seed: 5, budgets: { maxMoves: 4000 } }));
const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
const dayRules = registerRules(DAY_RULES);
for (const [anchor, zone] of /** @type {[string, string][]} */ ([['2026-03-29T01:00:00Z', 'Europe/Amsterdam'], ['2011-12-30T10:00:00Z', 'Pacific/Apia']]))
  out.push(solve(dayInstance(7, Date.parse(anchor), zone), dayRules, { strategy: 'local', seed: 7, days, budgets: { maxMoves: 400 } }));
process.stdout.write(`${JSON.stringify(out)}\n`);
