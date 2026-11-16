//@ts-check
/**
 * Scoring against the independent oracle: for every assignment list of
 * every tiny instance, the engine's score, verdict, matches and unknowns
 * equal the oracle's (which reads raw JSON by brute force and shares no
 * code with the engine or the reference plugins), and the matches re-sum
 * exactly to the score.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { admitProblem, registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { REFERENCE_RULES } from './rules/reference.js';
import { oracleScore } from './oracle/score.js';
import { tinyInstance, enumerate, spaceOf } from './oracle/instances.js';

const INSTANCES = 30;
const ruleSet = registerRules(REFERENCE_RULES);

/** @param {any} result */
function engineView(result) {
  const ids = (/** @type {readonly string[]} */ list) => list.join(',');
  return {
    score: { hard: String(result.score.hard), service: String(result.score.service), soft: String(result.score.soft) },
    verdict: result.verdict,
    matches: result.matches.map((/** @type {any} */ m) => `${m.rule}|${m.magnitude}|${ids(m.subjects.resources)}|${ids(m.subjects.tasks)}`).sort(),
    unknowns: result.unknowns.map((/** @type {any} */ u) => `${u.rule}|${u.reason}|${u.fact}|${ids(u.subjects.resources)}|${ids(u.subjects.tasks)}`).sort(),
  };
}

describe('scoring equals the independent oracle', () => {
  it('the oracle imports nothing from the engine or the reference plugins', () => {
    for (const file of ['score.js', 'instances.js']) {
      const text = fs.readFileSync(new URL(`./oracle/${file}`, import.meta.url), 'utf8');
      const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      assert.deepStrictEqual(imports, [], `${file} imports ${imports.join(', ')}`);
      assert.doesNotMatch(text, /import\(/, `${file} imports dynamically`);
    }
  });

  it(`every assignment of ${INSTANCES} tiny instances scores as the oracle does`, () => {
    let lists = 0;
    const verdicts = new Map();
    for (let seed = 1; seed <= INSTANCES; seed++) {
      const raw = tinyInstance(seed);
      assert.ok(raw.resources.length <= 4 && raw.tasks.length <= 5);
      const problem = admitProblem(raw);
      let seen = 0;
      for (const assignments of enumerate(raw)) {
        seen++;
        const result = scoreAssignment(problem, ruleSet, assignments);
        assert.strictEqual(result.complete, true);
        const expected = oracleScore(raw, assignments);
        assert.deepStrictEqual(engineView(result), expected, `seed ${seed} ${JSON.stringify(assignments)}`);
        const sums = { hard: 0n, service: 0n, soft: 0n };
        for (const match of /** @type {any[]} */ (result.matches)) sums[/** @type {'hard'} */ (match.level)] += BigInt(match.score);
        assert.deepStrictEqual({ hard: String(sums.hard), service: String(sums.service), soft: String(sums.soft) }, expected.score);
        verdicts.set(result.verdict, (verdicts.get(result.verdict) ?? 0) + 1);
      }
      assert.strictEqual(seen, spaceOf(raw), `seed ${seed} enumerates its whole space`);
      lists += seen;
    }
    // The corpus reaches every verdict, so none of the three is vacuous.
    assert.deepStrictEqual([...verdicts.keys()].sort(), ['feasible', 'infeasible-by-validation', 'unknown']);
    assert.ok(lists > 1000, `${lists} assignment lists`);
  });
});
