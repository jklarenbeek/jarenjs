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
  it('a projected return is a ROW residual carrying a COMPLETE one-row document', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 21] },
      $return: { n: '$it.name' },
    }, SHAPE);
    assert.strictEqual(planned.mode, 'row');
    assert.deepStrictEqual(planned.rowReturn, {
      $for: { it: '$[*]' },
      $return: [{ n: '$it.name' }],
    }, 'the binding travels WITH the projection that references it');
    assert.strictEqual(planned.plan.filter !== null, true, 'predicates stay pushed');
    assert.match(planned.reasons[0].reason, /row residual/);
  });

  it('the one-row document binds whatever the caller named the collection', () => {
    // the binding is the document's choice; a wrapper that assumed a
    // name would leave the projection referencing an unbound variable
    for (const name of ['it', 'user', 'row']) {
      const planned = planQuery({
        $for: { [name]: '$[*]' },
        $where: { $gt: [`$${name}.age`, 21] },
        $return: { n: `$${name}.name` },
      }, SHAPE);
      assert.strictEqual(planned.mode, 'row');
      assert.deepStrictEqual(planned.rowReturn, {
        $for: { [name]: '$[*]' },
        $return: [{ n: `$${name}.name` }],
      }, `the binding '${name}' survived planning`);
    }
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

// ————— spatial promotions —————

const PLACES_MODEL = {
  $model: '0.1',
  collections: {
    places: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          at: { type: ['array', 'object'] },
          maybe: { type: ['array', 'null'] },
          label: { type: 'string' },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_box', path: '$.at', derive: 'bbox' },
        { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
        { name: 'by_maybe', path: '$.maybe', derive: 'bbox' },
      ],
    },
  },
};
const places = normalizeModel(PLACES_MODEL).get('places');
const placesPhysical = planCollection('places', places, sqliteDialect);
const PLACES_SHAPE = {
  collection: 'places',
  schema: places.schema,
  columnByCanonical: placesPhysical.columnByCanonical,
};
const BOX_COLUMNS = {
  w: 'gx_at_bbox_w', s: 'gx_at_bbox_s', e: 'gx_at_bbox_e', n: 'gx_at_bbox_n',
};
const REGION = {
  type: 'Polygon',
  coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]],
};
const where = (predicate) =>
  ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it' });

describe('spatial promotions (the implied conjunct)', () => {
  it('$bbox-intersects against a literal is EXACT: box columns, no residual', () => {
    const planned = planQuery(where({ '$bbox-intersects': ['$it.at', REGION] }), PLACES_SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan.filter, {
      p: 'bboxOverlap', columns: BOX_COLUMNS, probe: { box: [4, 52, 5, 53] },
    });
    assert.deepStrictEqual(planned.prefilters, [{
      construct: '$bbox-intersects',
      columns: ['gx_at_bbox_w', 'gx_at_bbox_e', 'gx_at_bbox_s', 'gx_at_bbox_n'],
      exact: true,
    }]);
    assert.deepStrictEqual(planned.reasons, []);
  });

  it('the subject may be either operand of $bbox-intersects, and only the first of $within', () => {
    const flipped = planQuery(where({ '$bbox-intersects': [REGION, '$it.at'] }), PLACES_SHAPE);
    assert.strictEqual(flipped.plan.filter.p, 'bboxOverlap');
    // `$within(area, subject)` asks the other question, and the planner
    // must not answer it by symmetry
    const wrong = planQuery(where({ $within: [REGION, '$it.at'] }), PLACES_SHAPE);
    assert.strictEqual(wrong.plan.filter, null);
    assert.strictEqual(wrong.mode, 'set');
  });

  it('$within pushes the SAME box and keeps itself in the residual', () => {
    const planned = planQuery(where({ $within: ['$it.at', REGION] }), PLACES_SHAPE);
    assert.strictEqual(planned.mode, 'set');
    assert.deepStrictEqual(planned.plan.filter, {
      p: 'bboxOverlap', columns: BOX_COLUMNS, probe: { box: [4, 52, 5, 53] },
    });
    assert.deepStrictEqual(planned.reasons, [{
      construct: '$within',
      reason: 'a bounding-box pre-filter is pushed; exact containment refines in the engine',
    }]);
    assert.strictEqual(planned.prefilters[0].exact, false);
  });

  it('an external region becomes a probe the binder resolves, not a literal box', () => {
    const planned = planQuery(where({ $within: ['$it.at', '$region'] }), PLACES_SHAPE);
    assert.deepStrictEqual(planned.plan.filter,
      { p: 'bboxOverlap', columns: BOX_COLUMNS, probe: { ext: 'region' } });
  });

  it('a bounded $distance pushes the circle box; "farther than" pushes nothing', () => {
    for (const document of [
      where({ $le: [{ $distance: ['$it.at', [5, 52]] }, 1000] }),
      where({ $lt: [{ $distance: [[5, 52], '$it.at'] }, 1000] }),
      where({ $ge: [1000, { $distance: ['$it.at', [5, 52]] }] }),
    ]) {
      const planned = planQuery(document, PLACES_SHAPE);
      assert.strictEqual(planned.plan.filter.p, 'bboxOverlap', JSON.stringify(document));
      const box = planned.plan.filter.probe.box;
      assert.ok(box[0] < 5 && box[2] > 5 && box[1] < 52 && box[3] > 52, box.join(','));
      assert.deepStrictEqual(planned.reasons, [{
        construct: '$distance',
        reason: 'a geodesic-circle box pre-filter is pushed; the exact distance refines in the engine',
      }]);
    }
    const farther = planQuery(where({ $ge: [{ $distance: ['$it.at', [5, 52]] }, 1000] }), PLACES_SHAPE);
    assert.strictEqual(farther.plan.filter, null);
    assert.match(farther.reasons[0].reason, /only a BOUNDED distance/);
  });

  it('a circle over a pole or across the antimeridian pushes NOTHING', () => {
    for (const [centre, why] of [
      [[0, 89.99], /reaches a pole/],
      [[179.99, 0], /crosses the antimeridian/],
      [[-179.99, 0], /crosses the antimeridian/],
    ]) {
      const planned = planQuery(
        where({ $le: [{ $distance: ['$it.at', centre] }, 5000] }), PLACES_SHAPE);
      assert.strictEqual(planned.plan.filter, null, centre.join(','));
      assert.deepStrictEqual(planned.prefilters, []);
      assert.match(planned.reasons[0].reason, why, centre.join(','));
    }
  });

  it('a geohash prefix is exact up to the column precision and implied beyond it', () => {
    const short = planQuery(
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u17'] }), PLACES_SHAPE);
    assert.deepStrictEqual(short.plan.filter,
      { p: 'cellPrefix', column: 'gx_at_gh6', prefix: 'u17' });
    assert.strictEqual(short.mode, 'native');

    const whole = planQuery(
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u173zc'] }), PLACES_SHAPE);
    assert.deepStrictEqual(whole.plan.filter,
      { p: 'cellIn', column: 'gx_at_gh6', cells: ['u173zc'] });
    assert.strictEqual(whole.mode, 'native');

    const long = planQuery(
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u173zcb'] }), PLACES_SHAPE);
    assert.deepStrictEqual(long.plan.filter,
      { p: 'cellIn', column: 'gx_at_gh6', cells: ['u173zc'] });
    assert.strictEqual(long.mode, 'set');
    assert.strictEqual(long.prefilters[0].exact, false);
    assert.match(long.reasons[0].reason, /longer prefix refines/);
  });

  it('a different precision is a different column, and no column is no promotion', () => {
    for (const precision of [5, 7]) {
      const planned = planQuery(
        where({ '$starts-with': [{ $geohash: ['$it.at', precision] }, 'u17'] }), PLACES_SHAPE);
      assert.strictEqual(planned.plan.filter, null, `precision ${precision}`);
      assert.match(planned.reasons[0].reason, /no derived spatial index/);
    }
  });

  it('the nine-cell neighbourhood is a membership test over the same column (D7)', () => {
    const planned = planQuery(where({
      $exists: {
        '$index-of': [{ '$geohash-neighbours': 'u173zc' }, { $geohash: ['$it.at', 6] }],
      },
    }), PLACES_SHAPE);
    assert.strictEqual(planned.plan.filter.p, 'cellIn');
    assert.strictEqual(planned.plan.filter.column, 'gx_at_gh6');
    assert.strictEqual(planned.plan.filter.cells.length, 9);
    assert.ok(planned.plan.filter.cells.includes('u173zc'), 'the cell itself is one of the nine');
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.prefilters[0].exact, true);
    // a cell that is not the column's own length compares whole strings
    // against a different length, so nothing may be assumed
    const mismatched = planQuery(where({
      $exists: {
        '$index-of': [{ '$geohash-neighbours': 'u17' }, { $geohash: ['$it.at', 6] }],
      },
    }), PLACES_SHAPE);
    assert.strictEqual(mismatched.plan.filter, null);
    assert.match(mismatched.reasons[0].reason, /must match the derived column/);
  });

  it('a member the schema does not type as geography is never promoted', () => {
    // a string member, an untyped one, and a union that also admits null
    for (const [predicate, why] of [
      [{ $within: ['$it.label', REGION] }, 'a string member'],
      [{ $within: ['$it.other', REGION] }, 'an untyped member'],
      [{ $within: ['$it.maybe', REGION] }, 'a union that admits null'],
    ]) {
      const planned = planQuery(where(predicate), PLACES_SHAPE);
      assert.strictEqual(planned.plan.filter, null, why);
      assert.match(planned.reasons[0].reason, /array or an object/, why);
    }
  });

  it('an implied conjunct may not be negated; an exact one may', () => {
    const negatedImplied = planQuery(
      where({ $not: { $within: ['$it.at', REGION] } }), PLACES_SHAPE);
    assert.strictEqual(negatedImplied.plan.filter, null);
    assert.match(negatedImplied.reasons[0].reason, /negating a superset drops rows/);

    const negatedExact = planQuery(
      where({ $not: { '$bbox-intersects': ['$it.at', REGION] } }), PLACES_SHAPE);
    assert.deepStrictEqual(negatedExact.plan.filter,
      { p: 'not', item: { p: 'bboxOverlap', columns: BOX_COLUMNS, probe: { box: [4, 52, 5, 53] } } });
    assert.strictEqual(negatedExact.mode, 'native');
  });

  it('an implied conjunct still narrows beside an exact one, and says so once', () => {
    const planned = planQuery(where({
      $and: [{ $eq: ['$it.id', 'a'] }, { $within: ['$it.at', REGION] }],
    }), PLACES_SHAPE);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan.filter.p, 'and');
    assert.strictEqual(planned.plan.filter.items.length, 2);
    assert.deepStrictEqual(planned.reasons.map((r) => r.construct), ['$within']);
    assertNoSqlText(planned.plan);
  });

  it('a probe that cannot be folded to a value, or has no box, refuses', () => {
    const computed = planQuery(
      where({ $within: ['$it.at', { $centroid: '$it.at' }] }), PLACES_SHAPE);
    assert.strictEqual(computed.plan.filter, null);
    const boxless = planQuery(
      where({ $within: ['$it.at', { type: 'FeatureCollection', features: [] }] }), PLACES_SHAPE);
    assert.strictEqual(boxless.plan.filter, null);
    assert.match(boxless.reasons[0].reason, /no bounding box/);
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
