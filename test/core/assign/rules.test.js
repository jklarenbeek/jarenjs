//@ts-check
/**
 * The rule contract: registerRules checks each declaration with its own
 * code, answers a frozen set sorted by id, and its hash moves with any
 * declared member - a version above all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { registerRules, scoreAssignment, AssignError } from '@jarenjs/core/assign';
import { REFERENCE_RULES, noOverlap } from './rules/reference.js';
import { rosterProblem } from './fixtures.js';

/** @param {() => unknown} run */
function refusal(run) {
  try {
    run();
  }
  catch (error) {
    assert.ok(error instanceof AssignError, String(error));
    return { code: error.code, docPath: error.docPath };
  }
  assert.fail('no refusal');
}

const base = () => ({ id: 'r', version: 1, level: 'soft', scope: 'task', evaluate: () => ({}) });

describe('registerRules', () => {
  it('answers a frozen set sorted by id, with defaults filled', () => {
    const set = registerRules([...REFERENCE_RULES].reverse());
    assert.deepStrictEqual(set.rules.map((rule) => rule.id), [
      'attribute-match', 'availability-required', 'avoid-preference', 'coverage-min', 'max-sum-in-window', 'min-gap-between', 'no-overlap', 'spread-fairness',
    ]);
    assert.ok(Object.isFrozen(set) && Object.isFrozen(set.rules) && Object.isFrozen(set.rules[0]) && Object.isFrozen(set.rules[0].reads.facts));
    const overlap = set.rules.find((rule) => rule.id === 'no-overlap');
    assert.strictEqual(overlap?.weight, 1);
    assert.strictEqual(overlap?.measure, 'ms');
    assert.deepStrictEqual(overlap?.reads, { facts: [] });
    assert.strictEqual(registerRules([base()]).rules[0].measure, 'count');
  });

  it('hashes the declarations: the same rules in any order agree; a changed version, level, weight, measure, scope or read does not', () => {
    const hash = registerRules(REFERENCE_RULES).hash;
    assert.strictEqual(registerRules([...REFERENCE_RULES].reverse()).hash, hash);
    assert.match(hash, /^[0-9a-z]+$/);
    const changes = [{ version: 2 }, { version: '1' }, { level: 'soft' }, { weight: 5 }, { measure: 'minutes' }, { scope: 'task' }, { reads: { facts: ['x'] } }];
    const seen = new Set([hash]);
    for (const change of changes) {
      const rules = REFERENCE_RULES.map((rule) => (rule === noOverlap ? { ...rule, ...change } : rule));
      const changed = registerRules(/** @type {any} */ (rules)).hash;
      assert.ok(!seen.has(changed), `${JSON.stringify(change)} moves the hash`);
      seen.add(changed);
    }
    // The functions are not hashed: behaviour is versioned by the host.
    assert.strictEqual(registerRules(REFERENCE_RULES.map((rule) => (rule === noOverlap ? { ...rule, evaluate: () => ({}) } : rule))).hash, hash);
  });

  const REFUSALS = /** @type {[string, unknown, string, string][]} */ ([
    ['a set that is not an array', 'rules', 'JN0010', '/rules'],
    ['a rule that is not an object', ['rule'], 'JN0010', '/rules/0'],
    ['a rule without evaluate', [{ ...base(), evaluate: undefined }], 'JN0010', '/rules/0/evaluate'],
    ['an evaluate that is not a function', [{ ...base(), evaluate: 'x' }], 'JN0010', '/rules/0/evaluate'],
    ['an unknown member', [{ ...base(), facts: ['a'] }], 'JN0010', '/rules/0/facts'],
    ['an empty measure', [{ ...base(), measure: '' }], 'JN0010', '/rules/0/measure'],
    ['reads that is not an object', [{ ...base(), reads: ['a'] }], 'JN0010', '/rules/0/reads'],
    ['an unknown member of reads', [{ ...base(), reads: { tables: [] } }], 'JN0010', '/rules/0/reads/tables'],
    ['reads.facts that is not an array', [{ ...base(), reads: { facts: 'a' } }], 'JN0010', '/rules/0/reads/facts'],
    ['a fact read twice', [{ ...base(), reads: { facts: ['a', 'a'] } }], 'JN0010', '/rules/0/reads/facts'],
    ['an empty fact name', [{ ...base(), reads: { facts: [''] } }], 'JN0002', '/rules/0/reads/facts/0'],
    ['an empty id', [{ ...base(), id: '' }], 'JN0002', '/rules/0/id'],
    ['a duplicate id', [base(), { ...base() }], 'JN0003', '/rules/1/id'],
    ['a fractional version', [{ ...base(), version: 1.5 }], 'JN0004', '/rules/0/version'],
    ['an unknown level', [{ ...base(), level: 'critical' }], 'JN0011', '/rules/0/level'],
    ['the reserved resource-day scope', [{ ...base(), scope: 'resource-day' }], 'JN0012', '/rules/0/scope'],
    ['a zero weight', [{ ...base(), weight: 0 }], 'JN0013', '/rules/0/weight'],
    ['a fractional weight', [{ ...base(), weight: 1.5 }], 'JN0013', '/rules/0/weight'],
  ]);

  for (const [what, rules, code, docPath] of REFUSALS) {
    it(`refuses ${what} with ${code}`, () => {
      assert.deepStrictEqual(refusal(() => registerRules(/** @type {any} */ (rules))), { code, docPath });
    });
  }

  it('scoring refuses a rule set registerRules did not build (JN0014)', () => {
    const copy = { ...registerRules(REFERENCE_RULES) };
    assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), /** @type {any} */ (copy), [])), { code: 'JN0014', docPath: '/ruleSet' });
    assert.deepStrictEqual(refusal(() => scoreAssignment(rosterProblem(), /** @type {any} */ (null), [])), { code: 'JN0014', docPath: '/ruleSet' });
  });
});
