//@ts-check
/**
 * @file The planner: golden PLANS (algebra values, no database), the
 * no-SQL-in-plan tripwire over every golden, the exhaustive-dispatch
 * throw naming the kind and AST_VERSION, mode decisions
 * (native/row/set) with their reasons, and the narrowing-soundness
 * rule ($let/$as forbid conjunct pushdown).
 */

import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as assert from 'node:assert';

import { AST_VERSION } from '@jarenjs/json/query';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import {
  planQuery, planEntityQuery, assertDecidedKind, normalizeModel, planCollection,
  normalizeEntities, explainMapping, sqliteDialect, assertNoSqlText,
  PLANNER_REASONS, reasonId, PLAN_VERSION,
} from '@jarenjs/db';
import { predicateTerms, boundPredicateTerms } from '../../packages/db/src/plan.js';

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
      rank: null,
      bucket: null,
      group: null,
      seeks: [],
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
  it('a projection the tree cannot rebuild is a ROW residual carrying a COMPLETE one-row document', () => {
    // a member path composes into the projection tree; an OPERATOR over
    // one does not — the whole projection then runs per row
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 21] },
      $return: { n: { $count: '$it.name' } },
    }, SHAPE);
    assert.strictEqual(planned.mode, 'row');
    assert.deepStrictEqual(planned.rowReturn, {
      $for: { it: '$[*]' },
      $return: [{ n: { $count: '$it.name' } }],
    }, 'the binding travels WITH the projection that references it');
    assert.strictEqual(planned.plan.filter !== null, true, 'predicates stay pushed');
    assert.match(planned.reasons[0].reason, /row residual/);
  });

  it('a projection of safe member paths is a TREE the statement fetches leaf by leaf', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $where: { $gt: ['$it.age', 21] },
      $return: { n: '$it.name', a: '$it.age', again: '$it.name', k: 7 },
    }, SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan.project, {
      leaves: [
        { segments: [{ name: 'name' }], type: 'string', column: null },
        { segments: [{ name: 'age' }], type: 'integer', column: 'gx_age' },
      ],
      tree: { p: 'object', members: [
        { name: 'n', node: { p: 'leaf', index: 0 } },
        { name: 'a', node: { p: 'leaf', index: 1 } },
        { name: 'again', node: { p: 'leaf', index: 0 } },
        { name: 'k', node: { p: 'lit', value: 7 } },
      ] },
    }, 'a path named twice is ONE leaf, referenced twice');
  });

  it('the one-row document binds whatever the caller named the collection', () => {
    // the binding is the document's choice; a wrapper that assumed a
    // name would leave the projection referencing an unbound variable
    for (const name of ['it', 'user', 'row']) {
      const planned = planQuery({
        $for: { [name]: '$[*]' },
        $where: { $gt: [`$${name}.age`, 21] },
        $return: { n: { $count: `$${name}.name` } },
      }, SHAPE);
      assert.strictEqual(planned.mode, 'row');
      assert.deepStrictEqual(planned.rowReturn, {
        $for: { [name]: '$[*]' },
        $return: [{ n: { $count: `$${name}.name` } }],
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
      via: 'columns',
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

  it('the nine-cell neighbourhood is a membership test over the same column', () => {
    const planned = planQuery(where({
      $exists: {
        '$index-of': [{ '$geohash-neighbours': 'u173zc' }, { $geohash: ['$it.at', 6] }],
      },
    }), PLACES_SHAPE);
    assert.strictEqual(planned.plan.filter.p, 'cellIn');
    assert.strictEqual(planned.plan.filter.column, 'gx_at_gh6');
    assert.strictEqual(planned.plan.filter.cells.length, 9);
    assert.ok(planned.plan.filter.cells.includes('u173zc'), 'the cell itself is one of the nine');
    assert.strictEqual(planned.plan.filter.keepEmpty, true);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.prefilters[0].exact, false);
    assert.match(planned.reasons[0].reason, /empty/);
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

// ————— The reason census: every cause a plan can name —————

describe('the planner\'s reason vocabulary', () => {
  const CENSUS_MODEL = {
    $model: '0.1',
    collections: {
      rows: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            n: { type: 'integer' },
            s: { type: 'string' },
            f: { type: 'number' },
            b: { type: 'boolean' },
            o: { type: 'object', properties: { k: { type: 'integer' } } },
          },
        },
        key: null,
        identity: 'integer',
        indexes: [{ name: 'by_n', path: '$.n' }, { name: 'by_s', path: '$.s' }],
      },
    },
    entities: {
      Person: {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            name: { type: 'string' },
            age: { type: 'integer', 'x-entity': { index: true } },
            ok: { type: 'boolean' },
            inner: { type: 'object', properties: { tag: { type: 'string' } } },
            pets: { 'x-entity': { relation: {
              to: 'Pet', many: true, via: 'ownerId', onDelete: 'cascade' } } },
          },
        },
      },
      Pet: {
        schema: {
          type: 'object',
          required: ['pid', 'ownerId'],
          properties: {
            pid: { type: 'integer', 'x-entity': { key: true } },
            ownerId: { type: 'string' },
            kind: { type: 'string' },
          },
        },
      },
    },
  };
  const rows = normalizeModel(CENSUS_MODEL).get('rows');
  const rowsPhysical = planCollection('rows', rows, sqliteDialect);
  const OPERATORS = { ...createJsltRegistry().use(mathPack).toOptions(),
    functions: { flag: (value) => String(value).length > 2 } };
  const CENSUS_SHAPE = {
    collection: 'rows',
    schema: rows.schema,
    columnByCanonical: rowsPhysical.columnByCanonical,
    operators: OPERATORS,
  };
  const entities = normalizeEntities(CENSUS_MODEL);
  const mapping = explainMapping(CENSUS_MODEL);

  const F = (extra) => ({ $for: { it: '$[*]' }, $return: '$it', ...extra });
  const E = (extra) => ({ $for: { p: '$.Person[*]' }, $return: '$p', ...extra });
  // no UDF hook: the store's deterministic-fragment promotion turns most
  // of these refusals into a registered predicate and a native plan, so
  // the census reads the planner's own answer
  const collection = (document) => planQuery(document, CENSUS_SHAPE);
  const entity = (document) => planEntityQuery(document, entities, mapping, OPERATORS);

  /**
   * One document per reason the census claims is reachable, with the
   * planner entry that reaches it. A reason nobody can reach is a
   * reason nobody can trust — and a vocabulary that grew a sentence no
   * document produces is how an explanation starts lying.
   */
  const REACHED = {
    'kind.object': [collection, F({ $where: { a: 1 } })],
    'kind.array': [collection, F({ $where: ['$it.n'] })],
    'kind.map': [collection, F({ $where: { $map: [['$it.n', 1]] } })],
    'kind.quant': [collection,
      F({ $where: { $some: { x: '$it.o' }, $satisfies: { $gt: ['$x.k', 0] } } })],
    'kind.call': [collection, F({ $where: { $call: ['flag', '$it.s'] } })],
    'kind.let': [collection, F({ $let: { z: 1 } })],
    'predicate.notPredicate': [collection, F({ $where: 5 })],
    'predicate.existence': [collection, F({ $where: { $exists: { $eq: [1, 1] } } })],
    'predicate.joinTerritory': [collection, F({ $where: { $eq: ['$it.o', '$it.n'] } })],
    'predicate.operands': [collection, F({ $where: { $eq: [1, 2] } })],
    'predicate.compoundLiteral': [collection,
      F({ $where: { $eq: ['$it.o', { $const: { k: 1 } }] } })],
    'predicate.stringSubject': [collection, F({ $where: { $contains: ['$it.n', 'a'] } })],
    'predicate.stringPattern': [collection, F({ $where: { $contains: ['$it.s', '$pat'] } })],
    'predicate.emptyPattern': [collection, F({ $where: { $contains: ['$it.s', ''] } })],
    'predicate.noSpelling': [collection, F({ $where: { $match: ['$it.s', 'a'] } })],
    'flwor.binding': [collection, { $for: { a: '$[*]', b: '$[*]' }, $return: '$a' }],
    'flwor.as': [collection, F({ $as: { it: 'object' } })],
    'flwor.orderPath': [collection, F({ $orderby: ['$it.b'] })],
    // a projection tree rebuilds an object of member paths; an OPERATOR
    // over one is what still runs per row
    'flwor.projection': [collection,
      { $for: { it: '$[*]' }, $return: { x: { $count: '$it.n' } } }],
    'plan.windowBounds': [collection, { $subsequence: [F({}), -1] }],
    'plan.windowedAggregate': [collection,
      { $subsequence: [{ $sum: { $for: { it: '$[*]' }, $return: '$it.n' } }, 0, 1] }],
    'plan.notFlwor': [collection, 3],
    // a constructor yields ONE item per row, so a count over one whose
    // operators cannot raise is a COUNT(*); an operator that can raise is
    // evaluated for every row by the engine, so its count stays there
    'plan.countProjection': [collection,
      { $count: { $for: { it: '$[*]' }, $return: { x: { $add: ['$it.n', 1] } } } }],
    // a conjunct the hatch takes runs as a registered function; the census plans without the store's hook,
    // so the hook here accepts every fragment
    'plan.registeredFunction': [(document) => planQuery(document, CENSUS_SHAPE,
      { udf: () => ({ name: 'registered_stub', key: 'stub' }) }),
    { $count: { $for: { it: '$[*]' }, $where: { $eq: [{ $upper: '$it.s' }, 'A'] },
      $return: { x: { $upper: '$it.s' } } } }],
    'operators.registered': [collection,
      { $for: { it: '$[*]' }, $return: { a: { $sqrt: '$it.f' } } }],
    'plan.aggregatePath': [collection,
      { $sum: { $for: { it: '$[*]' }, $return: '$it.s' } }],
    // `f` is a `number`: the engine's left-to-right addition decides it
    'plan.floatingAccumulation': [collection,
      { $sum: { $for: { it: '$[*]' }, $return: '$it.f' } }],
    // A bare key can omit an absent group's item, so its window still
    // needs the engine's output cardinality.
    'plan.windowedGroup': [collection, { $subsequence: [
      { $for: { it: '$[*]' }, $groupby: { g: '$it.s' }, $return: '$g' }, 0, 2] }],
    // the guard beside an integer sum is read on the groups a statement
    // returns, so a window over groups ordered by one cannot trust it
    'plan.windowedAccumulation': [collection, { $subsequence: [
      { $for: { it: '$[*]' }, $groupby: { g: '$it.s' }, $orderby: [{ $key: { $sum: '$it.n' }, $dir: 'desc' }],
        $return: { g: '$g' } }, 0, 2] }],
    'plan.groupedAggregate': [collection, { $sum: {
      $for: { it: '$[*]' }, $groupby: { g: '$it.s' }, $return: { g: '$g' } } }],
    'plan.distinctProjection': [collection, { $distinct: F({}) }],
    // a second read of the root sees what the engine is handed: never one row
    'plan.rootRead': [collection, F({ $return: { x: { $count: '$[*]' } } })],
    'entity.notFlwor': [entity, { $count: '$.Person[*]' }],
    'entity.distinct': [entity, { $distinct: { $for: { p: '$.Person[*]' }, $orderby: ['$p.id'], $return: '$p.name' } }],
    'entity.bindingRoot': [entity, { $for: { p: { $in: '$.Person[*]', $at: 'i' } }, $return: '$p' }],
    'entity.joinKey': [entity, { $for: { a: '$.Person[*]', b: '$.Pet[*]' }, $return: '$a' }],
    // a conjunct spanning two bindings that is neither a column equality
    // nor a comparison of two mapped columns of one family — here a
    // string column against an integer one — belongs to neither binding
    'entity.conjunctBinding': [entity, {
      $for: { a: '$.Person[*]', b: '$.Pet[*]' },
      $where: { $and: [{ $eq: ['$a.id', '$b.ownerId'] }, { $gt: ['$a.name', '$b.pid'] }] },
      $return: '$a' }],
    'entity.external': [entity, E({ $where: { $eq: ['$p.inner.tag', '$who'] } })],
    // a bound membership list binds its strings and numbers, so against a
    // boolean column it could only answer false — and a `true` in it must match
    'entity.booleanList': [entity, E({ $where: { $eq: ['$p.ok', '$flags[*]'] } })],
    // a shape of member paths projects; an OPERATOR over one does not,
    // and neither does a bare member path (the entity answers documents)
    'entity.projection': [entity,
      { $for: { p: '$.Person[*]' }, $return: { n: { $count: '$p.name' } } }],
    'entity.scalarAggregate': [entity, { $sum: E({}) }],
    'entity.order': [entity, E({ $orderby: ['$p.ok'] })],
    // a hop is ONE plain correlated FLWOR; an inner ordering is not
    'entity.hopShape': [entity, E({ $where: { $exists: { $for: { q: '$.Pet[*]' },
      $where: { $eq: ['$q.ownerId', '$p.id'] }, $orderby: ['$q.pid'], $return: '$q' } } })],
    // a hop read as a value reaches one row only through the related key;
    // `ownerId` is not the pet's
    'entity.hopValue': [entity, { $for: { p: '$.Person[*]' }, $return: { kind: {
      $for: { q: '$.Pet[*]' }, $where: { $eq: ['$q.ownerId', '$p.id'] }, $return: '$q.kind' } } }],
    'interval.operands': [collection, F({ $where: { $overlaps: ['$it.o', '$it.o'] } })],
    'interval.probe': [collection,
      F({ $where: { $overlaps: ['$it.o', { $const: { start: 2, end: 1 } }] } })],
    // `o` is an object the schema does not type as a half-open span
    'interval.notInterval': [collection,
      F({ $where: { $overlaps: ['$it.o', { $const: { start: 1, end: 2 } }] } })],
    // the bound is a dialect's (PostgreSQL sets 128), applied where a plan
    // becomes a statement; the census passes its own, small one: 32 `$and`
    // pairs over two members plus one equality on a third are 65 leaves,
    // one past a bound of 64
    'predicate.termBound': [(document) => boundPredicateTerms(collection(document), 64),
      F({ $where: { $or: [
        ...Array.from({ length: 32 }, (_, i) => ({ $and: [{ $eq: ['$it.s', `s${i}`] }, { $ge: ['$it.n', i] }] })),
        { $eq: ['$it.id', 'x'] },
      ] } })],
  };

  /**
   * The rest of the vocabulary, each with the reason this census does
   * not reach it. Two of these are findings, not gaps: `kind.raw` names
   * a node the grammar only ever builds as a registry operator's inert
   * argument, so it can be neither a document root nor a whole
   * predicate — the sentence is unreachable by construction; and
   * `bind.untranslated` is a defensive fallback for a set-mode plan
   * carrying no reason, which no shape produces. The others are owned
   * by the suite whose model they need.
   */
  const NOT_REACHED = {
    'entity.groupOrder': 'group-order-aggregates.test.js and native-read-boundaries.test.js exercise the '
      + 'compound physical group ordering refusal',
    'predicate.physicalCodec': 'the explicit codec model and load refusal live in physical.test.js',
    'kind.raw': 'a raw node is only a registry operator\'s inert argument — never a root or a predicate',
    'flwor.collation': 'a $collation cannot be ANALYZED without a collation registry, '
      + 'so the engine refuses the document first',
    'predicate.negatedPrefilter': 'needs a spatial pre-filter under $not (the spatial suites)',
    'bind.untranslated': 'the defensive fallback for a set plan carrying no reason at all',
    'bind.externalLiteral': 'a literal slot the driver cannot bind; the planner only makes '
      + 'slots from bindable literals',
    'bind.pushdown': 'a harness switch on a query engine, not a plan (the explain suites)',
    'bind.external': 'a bind-time diversion on a query engine, not a plan (the explain suites)',
    'bind.wrappedWindow': "a chain's element window, classified by a cursor (the explain suites)",
    'bind.bucketWhole': 'a native temporal bucket (the series suites)',
    'bind.accumulation': 'an integer sum past its exactness bound, found by a run (the accumulation suite)',
    'bind.accumulationWhole': "a whole integer sum's cursor barrier, classified by a cursor (the accumulation suite)",
    'bind.entityGrouping': 'an entity grouping on a dialect whose guards are not qualified, decided by the '
      + 'entity engine (group-order-aggregates.test.js, over a store-owned PostgreSQL table)',
    'bind.entityGroupWhole': "an entity grouping's cursor barrier, classified by the entity engine",
    'bind.path': 'a member name the dialect cannot spell (the hostile suite)',
    'bind.identity': 'a table that takes every spelling of the row identity, decided by the entity emitter '
      + '(row-identity.test.js)',
    'interval.overlap': 'the promotion itself needs a declared interval (the interval suite)',
    'interval.noColumns': 'an interval the schema declares and the model does not map '
      + '(the interval suite)',
    ...Object.fromEntries(Object.keys(PLANNER_REASONS)
      .filter((id) => id.startsWith('spatial.'))
      .map((id) => [id, 'the spatial suites own the geographic models'])),
    ...Object.fromEntries(Object.keys(PLANNER_REASONS)
      .filter((id) => id.startsWith('knn.'))
      .map((id) => [id, 'the vector suites own the declared vector widths'])),
    ...Object.fromEntries(Object.keys(PLANNER_REASONS)
      .filter((id) => id.startsWith('series.'))
      .map((id) => [id, 'the temporal planner gates its own table, code for code'])),
  };

  const idsOf = (planned) => planned.reasons.map((entry) => reasonId(entry.reason));

  it('no reason is written at a refusal site — the vocabulary is the only source', () => {
    // the assertion that keeps the census COMPLETE: `reasonId` proves
    // the sentences the vocabulary claims, and this proves the
    // vocabulary claims them all, by refusing prose at the site
    const source = fs.readFileSync('packages/db/src/plan.js', 'utf8');
    const flat = source.replace(/\s+/g, ' ');
    // the reason is the LAST argument, and a call's arguments nest
    // (`refusal(used.join(', '), TABLE.entry(used))`), so the split is
    // paren- and quote-aware rather than a comma regex
    const reasonArgumentsOf = (text, call) => {
      const found = [];
      for (const match of text.matchAll(new RegExp(`\\b${call}\\(`, 'g'))) {
        let depth = 1;
        let quote = null;
        let start = match.index + match[0].length;
        const args = [];
        for (let i = start; i < text.length && depth > 0; i++) {
          const c = text[i];
          if (quote !== null) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
          }
          if (c === "'" || c === '"' || c === '`') quote = c;
          else if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) args.push(text.slice(start, i).trim());
          }
          else if (c === ',' && depth === 1) {
            args.push(text.slice(start, i).trim());
            start = i + 1;
          }
        }
        if (args.length >= 2) found.push(args.at(-1));
      }
      return found;
    };
    const literals = [...reasonArgumentsOf(flat, 'refusal'), ...reasonArgumentsOf(flat, 'residual')]
      .filter((argument) => /^['"`]/.test(argument));
    assert.deepStrictEqual(literals, [],
      'a reason sentence belongs in a named table, not at the refusal site');
    assert.deepStrictEqual(
      [...source.matchAll(/^\s*reason: ['"`]/gm)].map((m) => m[0]), [],
      'a reason sentence belongs in a named table, not in an object literal');
  });

  it('every sentence is claimed exactly once, by a stable identifier', () => {
    const seen = new Map();
    for (const [id, entry] of Object.entries(PLANNER_REASONS)) {
      const claim = entry.text ?? `prefix:${entry.prefix}`;
      assert.strictEqual(seen.get(claim), undefined,
        `'${id}' and '${seen.get(claim)}' claim the same sentence`);
      seen.set(claim, id);
      if (entry.text !== undefined) {
        assert.strictEqual(reasonId(entry.text), id,
          `'${id}' does not round-trip through reasonId`);
      }
    }
  });

  it('the vocabulary is either reached here or accounted for, with no third case', () => {
    assert.deepStrictEqual(
      Object.keys(PLANNER_REASONS).filter((id) => !(id in REACHED) && !(id in NOT_REACHED)),
      [], 'a new reason must be reached by a document or given its owner');
    assert.deepStrictEqual(
      Object.keys(NOT_REACHED).filter((id) => !(id in PLANNER_REASONS)),
      [], 'the accounted-for list names a reason the vocabulary does not carry');
  });

  for (const [id, [plan, document]] of Object.entries(REACHED)) {
    it(`${id} is reachable`, () => {
      const planned = plan(document);
      assert.notStrictEqual(planned.mode, 'native',
        `${id}: the document planned native, so no reason was named`);
      assert.ok(idsOf(planned).includes(id),
        `${id} unreached: ${JSON.stringify(planned.reasons)}`);
    });
  }

  it('every reason a document reaches is one the vocabulary claims', () => {
    for (const [id, [plan, document]] of Object.entries(REACHED)) {
      for (const entry of plan(document).reasons) {
        assert.notStrictEqual(reasonId(entry.reason), null,
          `${id} produced an unnamed reason: ${JSON.stringify(entry)}`);
      }
    }
  });
});

// ————— The general GROUP BY —————

describe('a grouping the plan can rebuild lowers to a GROUP BY', () => {
  const GROUP_SHAPE = SHAPE;

  it('keys, aggregates and the order of first appearance are the plan\'s, in one node', () => {
    const planned = planQuery({
      $for: { it: '$[*]' },
      $groupby: { g: '$it.name' },
      $return: { g: '$g', n: { $count: '$it' }, s: { $sum: '$it.age' }, again: { $sum: '$it.age' } },
    }, GROUP_SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan.group.keys,
      [{ as: 'g', ref: { segments: [{ name: 'name' }], type: 'string', column: null } }]);
    assert.deepStrictEqual(planned.plan.group.aggregates.map((a) => [a.fn, a.empty]),
      [['rows', 'zero'], ['sum', 'zero']], 'one aggregate per distinct question');
    assert.strictEqual(planned.plan.group.order, 'first-seen');
    assert.deepStrictEqual(planned.plan.group.tree, { p: 'object', members: [
      { name: 'g', node: { p: 'key', index: 0 } },
      { name: 'n', node: { p: 'agg', index: 0 } },
      { name: 's', node: { p: 'agg', index: 1 } },
      { name: 'again', node: { p: 'agg', index: 1 } },
    ] });
    assert.strictEqual(planned.plan.bucket, null, 'a general grouping is not a temporal bucket');
  });

  it('an $orderby over the keys becomes the groups\' order; anything else is engine work', () => {
    const ordered = planQuery({
      $for: { it: '$[*]' },
      $groupby: { g: '$it.name' },
      $orderby: [{ $key: '$g', $dir: 'desc' }],
      $return: { g: '$g' },
    }, GROUP_SHAPE);
    // descending under the default `$empty: 'least'` puts the empty key
    // last, which is what `NULLS LAST` spells
    assert.deepStrictEqual(ordered.plan.group.order,
      [{ index: 0, desc: true, nullsFirst: false }]);
    // ordering by a MEMBER after a grouping names a value the group does
    // not have; the engine answers it
    const byMember = planQuery({
      $for: { it: '$[*]' },
      $groupby: { g: '$it.name' },
      $orderby: ['$it.age'],
      $return: { g: '$g' },
    }, GROUP_SHAPE);
    assert.strictEqual(byMember.mode, 'set');
  });

  it('an integer sum or average orders the groups beside the aggregate it is; a window over them is engine work', () => {
    const grouped = (/** @type {any} */ order, /** @type {boolean} */ windowed = false) => {
      const document = { $for: { it: '$[*]' }, $groupby: { g: '$it.name' }, $orderby: order, $return: { g: '$g' } };
      return planQuery(windowed ? { $subsequence: [document, 0, 2] } : document, GROUP_SHAPE);
    };
    const bySum = grouped([{ $key: { $sum: '$it.age' }, $dir: 'desc' }]);
    assert.strictEqual(bySum.mode, 'native');
    assertNoSqlText(bySum.plan);
    assert.deepStrictEqual(bySum.plan.group.aggregates.map((a) => [a.fn, a.empty]), [['sum', 'zero']]);
    assert.deepStrictEqual(bySum.plan.group.order, [{ aggregate: 0, desc: true, nullsFirst: false }]);
    // a bare key is ascending, and an average over no values is the empty key, which orders first
    const byAvg = grouped([{ $avg: '$it.age' }]);
    assert.strictEqual(byAvg.mode, 'native');
    assert.deepStrictEqual(byAvg.plan.group.aggregates.map((a) => [a.fn, a.empty]), [['avg', 'omit']]);
    assert.deepStrictEqual(byAvg.plan.group.order, [{ aggregate: 0, desc: false, nullsFirst: true }]);
    // the guard beside a sum is read on the groups a statement returns, so a window leaves the groups to the engine
    for (const order of [[{ $key: { $sum: '$it.age' }, $dir: 'desc' }], [{ $avg: '$it.age' }]]) {
      const windowed = grouped(order, true);
      assert.strictEqual(windowed.mode, 'set');
      assert.deepStrictEqual(windowed.reasons.map((entry) => reasonId(entry.reason)), ['plan.windowedAccumulation']);
    }
    // a count and an extreme have no such guard to read
    for (const key of [{ $count: '$it' }, { $min: '$it.age' }, { $max: '$it.age' }])
      assert.strictEqual(grouped([{ $key: key, $dir: 'desc' }], true).mode, 'native');
  });

  it('the nullable form of a sum and the plain sum are two aggregates, whichever the return or the order names first', () => {
    const rows = { $for: { x: '$it' }, $where: { $ne: ['$x.age', null] }, $return: '$x.age' };
    const nullable = { $if: [{ $exists: rows }, { $sum: rows }, null] };
    for (const ret of [{ g: '$g', s: nullable }, { s: nullable, g: '$g', t: { $sum: '$it.age' } }]) {
      const planned = planQuery({ $for: { it: '$[*]' }, $groupby: { g: '$it.name' },
        $orderby: [{ $key: { $sum: '$it.age' }, $dir: 'asc' }], $return: ret }, GROUP_SHAPE);
      assert.strictEqual(planned.mode, 'native');
      const aggregates = planned.plan.group.aggregates;
      assert.deepStrictEqual(aggregates.map((a) => [a.fn, a.empty]).sort(), [['sum', 'null'], ['sum', 'zero']]);
      // a group with no value is `null` in the form that says so and `0` for the order
      assert.strictEqual(aggregates[planned.plan.group.order[0].aggregate].empty, 'zero');
    }
  });

  it('a key or an aggregate the plan cannot prove refuses the whole grouping', () => {
    // an untyped key: SQL's grouping and the engine's need not agree
    const untyped = planQuery({
      $for: { it: '$[*]' }, $groupby: { g: '$it.mystery' }, $return: { g: '$g' } }, GROUP_SHAPE);
    assert.strictEqual(untyped.mode, 'set');
    // the binding after a grouping holds the group's ROWS, and an object
    // member of several items is the engine's own error
    const reads = planQuery({
      $for: { it: '$[*]' }, $groupby: { g: '$it.name' },
      $return: { g: '$g', all: '$it' } }, GROUP_SHAPE);
    assert.strictEqual(reads.mode, 'set');
    // `$count` over a PATH counts the rows that have the member, which
    // COUNT(column) does not reproduce for a stored null
    const countPath = planQuery({
      $for: { it: '$[*]' }, $groupby: { g: '$it.name' },
      $return: { g: '$g', n: { $count: '$it.age' } } }, GROUP_SHAPE);
    assert.strictEqual(countPath.mode, 'set');
  });
});

describe('a disjunction regrouped by member', () => {
  const AGE = { segments: [{ name: 'age' }], type: 'integer', column: 'gx_age' };
  const NAME = { segments: [{ name: 'name' }], type: 'string', column: null };
  const ACTIVE = { segments: [{ name: 'active' }], type: 'boolean', column: null };
  const age = (/** @type {string} */ op, /** @type {any} */ value) => ({ [op]: ['$it.age', value] });
  const name = (/** @type {any} */ value) => ({ $eq: ['$it.name', value] });
  const filterOf = (/** @type {any} */ predicate, shape = SHAPE) => planQuery(where(predicate), shape).plan.filter;

  it('equalities of one member become one list and its rays one bound, each at its group\'s first position', () => {
    const planned = planQuery(where({ $or: [age('$gt', 30), name('ann'), age('$gt', 21),
      { $ne: ['$it.name', 'zed'] }, name('bob'), age('$ge', 21)] }), SHAPE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.plan.filter, { p: 'or', items: [
      { p: 'cmp', op: 'ge', ref: AGE, operand: { lit: 21 } },
      { p: 'in', ref: NAME, operand: { list: ['ann', 'bob'] } },
      { p: 'cmp', op: 'ne', ref: NAME, operand: { lit: 'zed' } },
    ] });
  });

  it('the literal may sit on either side, and the bound is the engine\'s order: numbers by value, strings by code point, the inclusive operator on a tie', () => {
    assert.deepStrictEqual(filterOf({ $or: [{ $lt: [30, '$it.age'] }, age('$gt', 40)] }),
      { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 30 } });
    assert.deepStrictEqual(filterOf({ $or: [age('$lt', 5), age('$le', 9), age('$lt', 9)] }),
      { p: 'cmp', op: 'le', ref: AGE, operand: { lit: 9 } });
    for (const items of [[age('$gt', 21), age('$ge', 21)], [age('$ge', 21), age('$gt', 21)]])
      assert.deepStrictEqual(filterOf({ $or: items }), { p: 'cmp', op: 'ge', ref: AGE, operand: { lit: 21 } });
    // U+FFFF sorts below U+10000 by code point and above it by UTF-16 code unit
    assert.deepStrictEqual(filterOf({ $or: [{ $gt: ['$it.name', '\u{10000}'] }, { $gt: ['$it.name', '￿'] }] }),
      { p: 'cmp', op: 'gt', ref: NAME, operand: { lit: '￿' } });
  });

  it('directions, JSON types and members never share a bound', () => {
    assert.deepStrictEqual(filterOf({ $or: [age('$gt', 21), age('$lt', 65), { $gt: ['$it.name', 'm'] }, age('$gt', 'x')] }),
      { p: 'or', items: [
        { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 21 } },
        { p: 'cmp', op: 'lt', ref: AGE, operand: { lit: 65 } },
        { p: 'cmp', op: 'gt', ref: NAME, operand: { lit: 'm' } },
        { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 'x' } },
      ] });
  });

  it('booleans, null and externals never fold, and a lone equality keeps its place', () => {
    const isTrue = { p: 'typeIs', ref: ACTIVE, types: ['true'], positive: true };
    assert.deepStrictEqual(filterOf({ $or: [{ $eq: ['$it.active', true] }, { $eq: ['$it.active', true] }] }),
      { p: 'or', items: [isTrue, isTrue] });
    const isNull = { p: 'typeIs', ref: NAME, types: ['null'], positive: true };
    assert.deepStrictEqual(filterOf({ $or: [name(null), name(null), name('a')] }),
      { p: 'or', items: [isNull, isNull, { p: 'cmp', op: 'eq', ref: NAME, operand: { lit: 'a' } }] });
    assert.deepStrictEqual(filterOf({ $or: [age('$eq', '$lo'), age('$eq', '$hi')] }), { p: 'or', items: [
      { p: 'cmp', op: 'eq', ref: AGE, operand: { ext: 'lo' } },
      { p: 'cmp', op: 'eq', ref: AGE, operand: { ext: 'hi' } },
    ] });
  });

  it('a compound literal or any other refused item refuses the whole disjunction: nothing is split', () => {
    for (const [item, id] of [
      [{ $eq: ['$it.name', { $const: ['x'] }] }, 'predicate.compoundLiteral'],
      [{ $gt: [{ $add: ['$it.name', 1] }, 5] }, 'predicate.operands'],
    ]) {
      const planned = planQuery(where({ $or: [name('a'), name('b'), item] }), SHAPE);
      assert.strictEqual(planned.mode, 'set', id);
      assert.strictEqual(planned.plan.filter, null, id);
      assert.strictEqual(reasonId(planned.reasons[0].reason), id);
    }
  });

  it('nested disjunctions flatten before the regroup, without a call per level', () => {
    assert.deepStrictEqual(filterOf({ $or: [{ $or: [name('a'), name('b')] }, name('c')] }),
      { p: 'in', ref: NAME, operand: { list: ['a', 'b', 'c'] } });
    // as a client that does not flatten builds it: { $or: [acc, next] }
    let nested = /** @type {any} */ (name('n0'));
    for (let i = 1; i < 5000; i++) nested = { $or: [nested, name(`n${i}`)] };
    const filter = filterOf(nested);
    assert.strictEqual(filter.p, 'in');
    assert.strictEqual(filter.operand.list.length, 5000);
    assert.deepStrictEqual(filter.operand.list.slice(0, 3), ['n0', 'n1', 'n2'], 'in document order');
  });

  it('a spatial item keeps its pre-filter inside a regrouped disjunction, and the neighbourhood\'s error column is unchanged', () => {
    const label = (/** @type {string} */ value) => ({ $eq: ['$it.label', value] });
    const LABEL = { segments: [{ name: 'label' }], type: 'string', column: null };
    const within = planQuery(where({ $or: [label('a'), label('b'), { $within: ['$it.at', REGION] }] }), PLACES_SHAPE);
    assert.strictEqual(within.mode, 'set');
    assert.deepStrictEqual(within.plan.filter, { p: 'or', items: [
      { p: 'in', ref: LABEL, operand: { list: ['a', 'b'] } },
      { p: 'bboxOverlap', columns: BOX_COLUMNS, probe: { box: [4, 52, 5, 53] } },
    ] });
    assert.strictEqual(within.prefilters.length, 1);
    assert.strictEqual(within.prefilters[0].construct, '$within');
    const neighbours = { $exists: { '$index-of': [{ '$geohash-neighbours': 'u173zc' }, { $geohash: ['$it.at', 6] }] } };
    const regrouped = planQuery(where({ $or: [label('a'), label('b'), neighbours] }), PLACES_SHAPE);
    const single = planQuery(where({ $or: [label('a'), neighbours] }), PLACES_SHAPE);
    const errorColumn = { p: 'cellIn', column: 'gx_at_gh6', cells: [], keepEmpty: true };
    for (const planned of [regrouped, single]) {
      assert.strictEqual(planned.plan.filter.p, 'or');
      assert.deepStrictEqual(planned.plan.filter.items[1], errorColumn);
      assert.strictEqual(planned.plan.filter.items[0].items[1].p, 'cellIn');
      assert.ok(planned.reasons.some((entry) => /empty/.test(entry.reason)));
    }
    assert.strictEqual(regrouped.plan.filter.items[0].items[0].p, 'in');
    assert.strictEqual(single.plan.filter.items[0].items[0].p, 'cmp');
  });

  it('an interval item keeps its pre-filter inside a regrouped disjunction', () => {
    const SPANS_MODEL = { $model: '0.1', collections: { spans: {
      schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' },
        span: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } } } },
      key: '/id', indexes: [{ name: 'from', path: '$.span.start' }, { name: 'to', path: '$.span.end' }] } } };
    const spans = normalizeModel(SPANS_MODEL).get('spans');
    const shape = { collection: 'spans', schema: spans.schema,
      columnByCanonical: planCollection('spans', spans, sqliteDialect).columnByCanonical };
    const planned = planQuery(where({ $or: [{ $eq: ['$it.label', 'a'] }, { $eq: ['$it.label', 'b'] },
      { $overlaps: ['$it.span', { start: 1, end: 5 }] }] }), shape);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan.filter.p, 'or');
    assert.strictEqual(planned.plan.filter.items.length, 2);
    assert.strictEqual(planned.plan.filter.items[0].p, 'in');
    assert.strictEqual(planned.plan.filter.items[1].p, 'interval');
    assert.strictEqual(planned.prefilters[0].construct, '$overlaps');
  });

  it('an infinity or a string a JSON list cannot carry never regroups: the item keeps its place', () => {
    assert.deepStrictEqual(filterOf({ $or: [age('$lt', Infinity), age('$lt', 5), age('$eq', -Infinity), age('$eq', 3)] }), { p: 'or', items: [
      { p: 'cmp', op: 'lt', ref: AGE, operand: { lit: Infinity } },
      { p: 'cmp', op: 'lt', ref: AGE, operand: { lit: 5 } },
      { p: 'cmp', op: 'eq', ref: AGE, operand: { lit: -Infinity } },
      { p: 'cmp', op: 'eq', ref: AGE, operand: { lit: 3 } },
    ] });
    // a lone surrogate is no JSON text: it cannot ride the one bound list
    assert.deepStrictEqual(filterOf({ $or: [name('\ud800'), name('b'), age('$gt', 8)] }), { p: 'or', items: [
      { p: 'cmp', op: 'eq', ref: NAME, operand: { lit: '\ud800' } },
      { p: 'cmp', op: 'eq', ref: NAME, operand: { lit: 'b' } },
      { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 8 } },
    ] });
  });

  it('a NaN literal is no bound: it equals nothing and orders against nothing, and differs from every present member', () => {
    // no database binds NaN as the engine compares it (SQLite stores NULL, PostgreSQL
    // sorts it above every number), so the planner answers it where it plans it
    const NOTHING = { p: 'const', value: false };
    const PRESENT = { p: 'typeIs', ref: AGE, types: [], positive: true };
    for (const op of ['$eq', '$lt', '$le', '$gt', '$ge'])
      assert.deepStrictEqual(filterOf(age(op, NaN)), NOTHING, op);
    assert.deepStrictEqual(filterOf(age('$ne', NaN)), PRESENT);
    assert.deepStrictEqual(filterOf({ $gt: [NaN, '$it.age'] }), NOTHING, 'on the left');
    assert.deepStrictEqual(filterOf({ $ne: [NaN, '$it.age'] }), PRESENT, 'on the left');
    // beside other items it keeps its place and never becomes a group's bound
    assert.deepStrictEqual(filterOf({ $or: [age('$gt', NaN), age('$gt', 5)] }), { p: 'or', items: [
      NOTHING, { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 5 } },
    ] });
    assert.deepStrictEqual(filterOf({ $or: [age('$gt', 5), age('$ge', NaN), age('$gt', 3)] }), { p: 'or', items: [
      { p: 'cmp', op: 'gt', ref: AGE, operand: { lit: 3 } }, NOTHING,
    ] });
    assert.deepStrictEqual(filterOf({ $or: [age('$eq', NaN), age('$eq', 7), age('$eq', 8)] }), { p: 'or', items: [
      NOTHING, { p: 'in', ref: AGE, operand: { list: [7, 8] } },
    ] });
    assert.deepStrictEqual(filterOf({ $not: age('$lt', NaN) }), { p: 'not', item: NOTHING });
  });

  it('equalities on an instant column keep their epoch narrowing: no list, one range per instant; its rays still fold', () => {
    const MODEL = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      n: { type: 'number', 'x-entity': { index: true } },
      at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer', index: true } } } } } } };
    const entities = normalizeEntities(MODEL);
    const mapping = explainMapping(MODEL);
    const at = (/** @type {string} */ op, /** @type {string} */ value) => ({ [op]: ['$it.at', value] });
    const A = '2024-01-01T00:00:00Z';
    const B = '2024-01-01T09:00:00Z';
    const filterOf = (/** @type {any} */ predicate) => {
      const planned = planEntityQuery({ $for: { it: '$.Item[*]' }, $where: predicate, $return: '$it.id' }, entities, mapping);
      assert.strictEqual(planned.mode, 'native');
      return planned.plan.filters[0].filter;
    };
    const mixed = filterOf({ $or: [at('$eq', A), at('$eq', B), { $gt: ['$it.n', 8] }] });
    assert.deepStrictEqual(mixed.items.map((/** @type {any} */ item) => [item.p, item.op, item.epoch]),
      [['cmp', 'eq', Date.parse(A)], ['cmp', 'eq', Date.parse(B)], ['cmp', 'gt', undefined]]);
    const alone = filterOf({ $or: [at('$eq', A), at('$eq', B)] });
    assert.deepStrictEqual(alone.items.map((/** @type {any} */ item) => [item.p, item.epoch]), [['cmp', Date.parse(A)], ['cmp', Date.parse(B)]]);
    const rays = filterOf({ $or: [at('$gt', B), at('$gt', A), { $gt: ['$it.n', 8] }] });
    assert.deepStrictEqual(rays.items.map((/** @type {any} */ item) => [item.p, item.op, item.epoch]),
      [['cmp', 'gt', Date.parse(A)], ['cmp', 'gt', undefined]]);
  });
});

describe('the predicate term bound', () => {
  const where = (/** @type {any} */ predicate, /** @type {any} */ ret = '$it') =>
    planQuery({ $for: { it: '$[*]' }, $where: predicate, $return: ret }, SHAPE);
  const name = (/** @type {string} */ value) => ({ $eq: ['$it.name', value] });
  const age = (/** @type {string} */ op, /** @type {number} */ value) => ({ [op]: ['$it.age', value] });
  /** `count` pairs over two members: two leaves each, which nothing regroups. */
  const pairs = (/** @type {number} */ count) =>
    Array.from({ length: count }, (_, i) => ({ $and: [name(`n${i}`), age('$ge', i)] }));
  const BOUND_REASON = { construct: '$where', reason: PLANNER_REASONS['predicate.termBound'].text };

  it('counts the leaves of a plan or a predicate: connectives are not terms, a membership list is one', () => {
    assert.strictEqual(predicateTerms(null), 0);
    assert.strictEqual(predicateTerms(where(age('$gt', 1)).plan), 1);
    assert.strictEqual(predicateTerms(where({ $and: [age('$gt', 1), age('$lt', 9), name('a')] }).plan), 3);
    assert.strictEqual(predicateTerms(where({ $not: { $or: [age('$gt', 1), name('a')] } }).plan), 2);
    // equalities of one member regroup into one bound list, as a `$seq` is: one leaf
    assert.strictEqual(predicateTerms(where({ $or: [name('a'), name('b'), name('c')] }).plan), 1);
    assert.strictEqual(predicateTerms(where({ $eq: ['$it.name', { $seq: ['a', 'b', 'c'] }] }).plan), 1);
    const planned = where({ $or: pairs(32) });
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(predicateTerms(planned.plan), 64, '32 pairs are 64 leaves');
    assert.strictEqual(predicateTerms(planned.plan.filter), 64, 'a bare predicate node counts alike');
    assert.strictEqual(predicateTerms({ ...planned.plan, filter: null }), 0);
  });

  it('counts an entity statement over every binding filter and every comparison that refines a join; a join equality is not a term', () => {
    const MODEL = { $model: '0.1', entities: {
      Person: { schema: { type: 'object', required: ['id'], properties: {
        id: { type: 'string', 'x-entity': { key: true } }, age: { type: 'integer', 'x-entity': { index: true } } } } },
      Pet: { schema: { type: 'object', required: ['pid'], properties: {
        pid: { type: 'string', 'x-entity': { key: true } }, ownerId: { type: 'string', 'x-entity': { index: true } },
        kind: { type: 'string', 'x-entity': { index: true } }, weight: { type: 'integer', 'x-entity': { index: true } } } } } } };
    const entities = normalizeEntities(MODEL);
    const mapping = explainMapping(MODEL);
    const planned = planEntityQuery({ $for: { a: '$.Person[*]', b: '$.Pet[*]' },
      $where: { $and: [{ $eq: ['$a.id', '$b.ownerId'] }, { $gt: ['$a.age', 1] }, { $lt: ['$a.age', 9] }, { $eq: ['$b.kind', 'cat'] }] },
      $return: '$a' }, entities, mapping);
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.plan.joins.length, 2);
    assert.strictEqual(predicateTerms(planned.plan), 3);
    const demoted = boundPredicateTerms(planned, 2);
    assert.strictEqual(demoted.mode, 'set');
    assert.strictEqual(demoted.plan, null);
    assert.deepStrictEqual(demoted.reasons, [BOUND_REASON]);
    assert.deepStrictEqual(demoted.referenced, planned.referenced);
    assert.strictEqual(boundPredicateTerms(planned, 3), planned);
    // a comparison between the bindings that is not an equality refines the join: the
    // server evaluates it once per candidate pair, so each one is a leaf
    const refined = planEntityQuery({ $for: { a: '$.Person[*]', b: '$.Pet[*]' },
      $where: { $and: [{ $eq: ['$a.id', '$b.ownerId'] }, { $gt: ['$a.age', 1] }, { $lt: ['$a.age', '$b.weight'] },
        { $ne: ['$a.age', '$b.weight'] }, { $ge: ['$a.age', '$b.weight'] }] },
      $return: '$a' }, entities, mapping);
    assert.strictEqual(refined.mode, 'native');
    assert.strictEqual(predicateTerms(refined.plan), 4, 'one filter and three refinements');
    assert.strictEqual(boundPredicateTerms(refined, 3).mode, 'set');
    assert.strictEqual(boundPredicateTerms(refined, 4), refined);
  });

  it('demotes a collection plan past the bound with the reason first; at the bound, unbounded, or already in the engine it is untouched', () => {
    const at = where({ $or: pairs(32) });
    assert.strictEqual(boundPredicateTerms(at, 64), at);
    assert.strictEqual(boundPredicateTerms(at, null), at, 'no bound is unbounded');
    const above = where({ $or: [...pairs(32), { $eq: ['$it.id', 'x'] }] });
    assert.strictEqual(predicateTerms(above.plan), 65);
    assert.strictEqual(boundPredicateTerms(above, null), above);
    const demoted = boundPredicateTerms(above, 64);
    assert.strictEqual(demoted.mode, 'set');
    assert.strictEqual(demoted.plan, null);
    assert.deepStrictEqual([demoted.rowReturn, demoted.udfs, demoted.prefilters, demoted.series], [null, [], [], null]);
    assert.deepStrictEqual(demoted.reasons, [BOUND_REASON, ...above.reasons]);
    assert.strictEqual(reasonId(demoted.reasons[0].reason), 'predicate.termBound');
    assert.strictEqual(demoted.analysis, above.analysis);
    // what the statement carries beside the plan — a profile's mandatory predicate — counts
    assert.strictEqual(boundPredicateTerms(at, 64, 1).mode, 'set');
    assert.strictEqual(boundPredicateTerms(at, 65, 1), at);
    // a per-row projection keeps its plan until the bound, then loses it with the rest
    const row = where({ $or: [...pairs(32), { $eq: ['$it.id', 'x'] }] }, { x: { $count: '$it.name' } });
    assert.strictEqual(row.mode, 'row');
    const rowDemoted = boundPredicateTerms(row, 64);
    assert.strictEqual(rowDemoted.mode, 'set');
    assert.strictEqual(rowDemoted.rowReturn, null);
    assert.deepStrictEqual(rowDemoted.reasons, [BOUND_REASON, ...row.reasons]);
    // a plan already in the engine has no statement to bound
    const set = where({ $eq: ['$it.name', { $const: { k: 1 } }] });
    assert.strictEqual(set.mode, 'set');
    assert.strictEqual(boundPredicateTerms(set, 64), set);
  });
});
