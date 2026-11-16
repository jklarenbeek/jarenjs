//@ts-check
/**
 * Day-scoped scoring against the independent day oracle: for every
 * assignment list of tiny instances placed around every change of the
 * clock in the fixture table (2011 and 2026, Pacific/Apia's skipped day
 * included), the engine with the fixture provider answers the oracle's
 * score, verdict, matches (with their zone and date) and unknowns. The
 * oracle reads raw JSON and the raw table and imports nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { admitProblem, registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { DAY_RULES } from './rules/days.js';
import { oracleDays, dayInstance } from './oracle/days.js';
import { enumerate, spaceOf } from './oracle/instances.js';
import { TRANSITIONS, fixtureProvider } from './days-provider.js';

const SEEDS = 6;
const ruleSet = registerRules(DAY_RULES);
const days = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });
const ANCHORS = Object.entries(TRANSITIONS.zones).flatMap(([zone, entry]) => /** @type {any} */ (entry).transitions
  .filter((/** @type {any} */ row) => /^(2011|2026)-/.test(row.at)).map((/** @type {any} */ row) => ({ zone, at: Date.parse(row.at) })));

/** @param {any} result */
function engineView(result) {
  const ids = (/** @type {readonly string[]} */ list) => list.join(',');
  return {
    score: { hard: String(result.score.hard), service: String(result.score.service), soft: String(result.score.soft) },
    verdict: result.verdict,
    matches: result.matches.map((/** @type {any} */ m) => `${m.rule}|${m.magnitude}|${ids(m.subjects.resources)}|${ids(m.subjects.tasks)}|${m.unit.zone}|${m.unit.date}`).sort(),
    unknowns: result.unknowns.map((/** @type {any} */ u) => `${u.rule}|${u.reason}|${u.fact}|${ids(u.subjects.resources)}|${ids(u.subjects.tasks)}|${u.unit.id}/${u.unit.zone ?? ''}/${u.unit.date ?? ''}`).sort(),
  };
}

describe('day-scoped scoring equals the independent day oracle', () => {
  it('the day oracle imports nothing', () => {
    const text = fs.readFileSync(new URL('./oracle/days.js', import.meta.url), 'utf8');
    const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepStrictEqual(imports, []);
    assert.doesNotMatch(text, /import\(/);
  });

  it(`every assignment of ${SEEDS} instances around each of ${ANCHORS.length} changes of the clock scores as the oracle does`, () => {
    assert.strictEqual(ANCHORS.length, 15);
    let lists = 0;
    const verdicts = new Map();
    const lengths = new Set();
    for (const { zone, at: anchor } of ANCHORS)
      for (let seed = 1; seed <= SEEDS; seed++) {
        const raw = dayInstance(seed + anchor / 1800000, anchor, zone);
        const problem = admitProblem(raw);
        let seen = 0;
        for (const assignments of enumerate(raw)) {
          seen++;
          const result = /** @type {any} */ (scoreAssignment(problem, ruleSet, assignments, { days }));
          assert.strictEqual(result.complete, true);
          assert.deepStrictEqual(engineView(result), oracleDays(TRANSITIONS.zones, raw, assignments), `anchor ${zone} ${new Date(anchor).toISOString()} seed ${seed} ${JSON.stringify(assignments)}`);
          for (const match of result.matches) if (match.rule === 'daily-rest') lengths.add(match.intervals[0].end - match.intervals[0].start);
          verdicts.set(result.verdict, (verdicts.get(result.verdict) ?? 0) + 1);
        }
        assert.strictEqual(seen, spaceOf(raw));
        lists += seen;
      }
    assert.deepStrictEqual([...verdicts.keys()].sort(), ['feasible', 'infeasible-by-validation', 'unknown']);
    // days of 23, 23.5, 24, 24.5 and 25 hours were all judged
    assert.deepStrictEqual([...lengths].sort((a, b) => a - b).map((ms) => ms / 1800000), [46, 47, 48, 49, 50]);
    assert.ok(lists > 2000, `${lists} assignment lists`);
  });
});
