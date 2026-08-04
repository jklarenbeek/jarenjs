//@ts-check
/**
 * @file The planner: golden PLANS (algebra values, no database), the
 * no-SQL-in-plan tripwire over every golden, the exhaustive-dispatch
 * throw naming the kind and AST_VERSION, mode decisions
 * (native/row/set) with their reasons, and the narrowing-soundness
 * rule ($let/$as forbid conjunct pushdown).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { AST_VERSION } from '@jarenjs/json/query';
import {
  planQuery, assertDecidedKind, normalizeModel, planCollection,
  sqliteDialect, assertNoSqlText, PLAN_VERSION,
} from '@jarenjs/db';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};

const users = normalizeModel(MODEL).get('users');
const physical = planCollection('users', users, sqliteDialect);
const SHAPE = {
  collection: 'users',
  schema: users.schema,
  columnByCanonical: physical.columnByCanonical,
};

describe('golden plans (algebra, no SQL anywhere)', () => {
  it('a guarded comparison over an indexed path', () => {
    const planned = planQuery(
      { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' }, SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan, {
      planVersion: PLAN_VERSION,
      alg: 'select',
      collection: 'users',
      filter: {
        p: 'cmp', op: 'gt',
        ref: { segments: [{ name: 'age' }], type: 'integer', column: 'gx_age' },
        operand: { lit: 21 },
      },
      order: null,
      window: null,
      aggregate: null,
      project: 'document',
    });
  });

  it('boolean/null literals become type tests; unindexed paths carry no column', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $and: [
        { $eq: ['$it.active', true] },
        { $ne: ['$it.name', null] },
        { $exists: '$it.age' },
      ] },
      $return: '$it',
    }, SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan.filter, {
      p: 'and',
      items: [
        { p: 'typeIs', ref: { segments: [{ name: 'active' }], type: 'boolean', column: null }, types: ['true'], positive: true },
        { p: 'typeIs', ref: { segments: [{ name: 'name' }], type: 'string', column: null }, types: ['null'], positive: false },
        { p: 'typeIs', ref: { segments: [{ name: 'age' }], type: 'integer', column: 'gx_age' }, types: [], positive: true },
      ],
    });
  });

  it('ordering vs an unorderable literal is constant false; flipped operands reverse', () => {
    const constant = planQuery(
      { $for: { it: '$[*]' }, $where: { $lt: ['$it.active', true] }, $return: '$it' }, SHAPE);
    assert.deepStrictEqual(constant.plan.filter, { p: 'const', value: false });

    const flipped = planQuery(
      { $for: { it: '$[*]' }, $where: { $lt: [21, '$it.age'] }, $return: '$it' }, SHAPE);
    assert.strictEqual(flipped.plan.filter.op, 'gt', '21 < age becomes age > 21');
  });

  it('windows compose onto a pushed selection; orderby carries dir and empties', () => {
    const planned = planQuery({
      $subsequence: [{
        $subsequence: [{
          $for: { it: '$[*]' },
          $orderby: [{ $key: '$it.name', $dir: 'desc', $empty: 'greatest' }],
          $return: '$it',
        }, 2],
      }, 1, 3],
    }, SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assert.deepStrictEqual(planned.plan.window, { offset: 3, limit: 3 });
    assert.deepStrictEqual(planned.plan.order, [{
      ref: { segments: [{ name: 'name' }], type: 'string', column: null },
      desc: true,
      emptyGreatest: true,
    }]);
    assertNoSqlText(planned.plan);
  });

  it('aggregates: count over the bare binding, sum over a typed path', () => {
    const count = planQuery(
      { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' } }, SHAPE);
    assert.strictEqual(count.mode, 'native');
    assert.deepStrictEqual(count.plan.aggregate, { fn: 'count', ref: null });

    const sum = planQuery(
      { $sum: { $for: { it: '$[*]' }, $return: '$it.age' } }, SHAPE);
    assert.strictEqual(sum.mode, 'native');
    assert.strictEqual(sum.plan.aggregate.fn, 'sum');
    assert.strictEqual(sum.plan.aggregate.ref.column, 'gx_age');
    assertNoSqlText(sum.plan);
  });
});

describe('mode decisions and reasons', () => {
  it('a projected return is a ROW residual carrying the raw $return', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 21] },
      $return: { n: '$it.name' },
    }, SHAPE);
    assert.strictEqual(planned.mode, 'row');
    assert.deepStrictEqual(planned.rowReturn, { n: '$it.name' });
    assert.strictEqual(planned.plan.filter !== null, true, 'predicates stay pushed');
    assert.match(planned.reasons[0].reason, /row residual/);
  });

  it('an untranslatable conjunct is a SET residual that still narrows by the rest', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $and: [
        { $gt: ['$it.age', 21] },
        { $match: ['$it.name', '^a'] },
      ] },
      $return: '$it',
    }, SHAPE);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan.filter.p, 'cmp', 'the translatable conjunct still pushes');
    assert.match(planned.reasons[0].construct, /\$match/);
  });

  it('$let forbids narrowing entirely (clause order: bindings run before where)', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $let: { d: { $mul: ['$it.age', 2] } },
      $where: { $gt: ['$it.age', 21] },
      $return: '$it',
    }, SHAPE);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan.filter, null,
      'no conjunct may push: a let binding could throw on a row the conjunct would exclude');
  });

  it('a partially translatable $or refuses whole; untyped ordering refuses', () => {
    const orMixed = planQuery({
      $for: { it: '$[*]' },
      $where: { $or: [{ $gt: ['$it.age', 21] }, { $match: ['$it.name', 'x'] }] },
      $return: '$it',
    }, SHAPE);
    assert.strictEqual(orMixed.mode, 'set');
    assert.strictEqual(orMixed.plan.filter, null, 'a disjunct cannot split');

    // a $collation cannot even be ANALYZED without a registry, so it
    // fails with the engine's own error before the planner sees it —
    // parity by construction. The reachable ordering refusal is the
    // schema-untyped key:
    const untyped = planQuery({
      $for: { it: '$[*]' },
      $orderby: ['$it.mystery'],
      $return: '$it',
    }, SHAPE);
    assert.strictEqual(untyped.mode, 'set');
    assert.match(untyped.reasons.map((r) => r.reason).join(','), /schema-typed/);
  });

  it('non-collection sources, non-literal windows and the empty pattern refuse', () => {
    const twoBindings = planQuery({
      $for: { a: '$[*]', b: '$[*]' },
      $return: '$a',
    }, SHAPE);
    assert.strictEqual(twoBindings.mode, 'set');
    assert.match(twoBindings.reasons[0].reason, /single plain binding/);

    const externalWindow = planQuery(
      { $subsequence: [{ $for: { it: '$[*]' }, $return: '$it' }, '$n'] }, SHAPE);
    assert.strictEqual(externalWindow.mode, 'set');
    assert.match(externalWindow.reasons[0].reason, /literal numbers/);

    const emptyPattern = planQuery(
      { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.name', ''] }, $return: '$it' }, SHAPE);
    assert.strictEqual(emptyPattern.mode, 'set');
    assert.match(emptyPattern.reasons[0].reason, /vacuous-truth/);
  });

  it('a non-FLWOR root is a set residual naming its kind', () => {
    const planned = planQuery({ $add: [1, 2] }, SHAPE);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan, null);
  });
});

describe('exhaustive dispatch', () => {
  it('an unrecognised kind throws naming the kind and the AST_VERSION', () => {
    assert.throws(() => assertDecidedKind({ kind: 'zebra' }), (error) => {
      assert.match(error.message, /'zebra'/);
      assert.match(error.message, new RegExp(`AST_VERSION ${AST_VERSION}`));
      return true;
    });
  });
});
