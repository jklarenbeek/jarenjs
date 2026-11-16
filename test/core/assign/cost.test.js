//@ts-check
/**
 * Scoring's work grows with the instance, not with its square: over an
 * 8x step in tasks and resources (tasks per resource held), the
 * deterministic work counter grows about 8x, in step with the matches.
 * Counters, not wall time, so the bound holds on any host.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { REFERENCE_RULES, noOverlap, coverageMin } from './rules/reference.js';
import { largeProblem } from './fixtures.js';

/** Ten rules: the eight reference rules and two re-levelled copies. */
const TEN = registerRules([...REFERENCE_RULES,
  { ...noOverlap, id: 'no-overlap-soft', level: 'soft' },
  { ...coverageMin, id: 'coverage-min-hard', level: 'hard' }]);

/** @param {number} tasks */
function counts(tasks) {
  const { problem, assignments } = largeProblem(tasks, tasks / 10);
  const result = scoreAssignment(problem, TEN, assignments);
  assert.strictEqual(result.complete, true);
  return result.counts;
}

describe('scoring cost', () => {
  it('grows linearly over an 8x step (1,000 to 8,000 tasks)', () => {
    const small = counts(1000);
    const large = counts(8000);
    assert.strictEqual(small.rules, 10);
    assert.ok(small.matches > 500, `${small.matches} matches`);
    const work = large.work / small.work;
    const matches = large.matches / small.matches;
    assert.ok(work > 6 && work < 10, `work grew ${work.toFixed(2)}x`);
    assert.ok(matches > 6 && matches < 10, `matches grew ${matches.toFixed(2)}x`);
    assert.ok(Math.abs(large.units / small.units - 8) < 0.01, 'units (two global rules evaluate once at any size)');
  });
});
