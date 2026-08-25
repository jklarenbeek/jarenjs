//@ts-check
/**
 * @file The plan algebra invariants: fresh plans, filter conjunction,
 * the plan version stamp, and the no-SQL tripwire — including the
 * proof it can actually fail.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { selectPlan, conjoin, assertNoSqlText, PLAN_VERSION } from '@jarenjs/db';

describe('the plan algebra', () => {
  it('a fresh select plan is versioned, unfiltered, whole-document', () => {
    const plan = selectPlan('users');
    assert.deepStrictEqual(plan, {
      planVersion: PLAN_VERSION,
      alg: 'select',
      collection: 'users',
      filter: null,
      order: null,
      window: null,
      rank: null,
      aggregate: null,
      project: 'document',
    });
  });

  it('conjoin grows a conjunction without nesting', () => {
    const a = { p: 'const', value: true };
    const b = { p: 'const', value: false };
    const c = { p: 'not', item: a };
    assert.strictEqual(conjoin(null, a), a);
    assert.deepStrictEqual(conjoin(a, b), { p: 'and', items: [a, b] });
    assert.deepStrictEqual(conjoin(conjoin(a, b), c), { p: 'and', items: [a, b, c] });
  });

  it('the no-SQL tripwire passes clean plans and fails leaky ones', () => {
    assertNoSqlText(selectPlan('users'));
    assertNoSqlText({ filter: { p: 'cmp', op: 'eq', ref: { segments: [{ name: 'where_ish' }] } } });
    assert.throws(() => assertNoSqlText({ leaked: 'SELECT json("doc")' }),
      /plan carries SQL text/);
    assert.throws(() => assertNoSqlText({ leaked: "jsonb_extract(x)" }),
      /jsonb_extract/);
  });
});
