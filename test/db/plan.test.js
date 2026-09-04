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
    'predicate.joinTerritory': [collection, F({ $where: { $eq: ['$it.n', '$it.f'] } })],
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
    // a constructor yields ONE item per row, so a count over a
    // projection tree is a COUNT(*); the refusal is for a projection
    // whose item count the rows cannot decide
    'plan.countProjection': [collection,
      { $count: { $for: { it: '$[*]' }, $return: { x: { $count: '$it.n' } } } }],
    'operators.registered': [collection,
      { $for: { it: '$[*]' }, $return: { a: { $abs: '$it.f' } } }],
    'plan.aggregatePath': [collection,
      { $sum: { $for: { it: '$[*]' }, $return: '$it.s' } }],
    // a window over the GROUPS: the grouping is recognized, and cutting
    // the groups in SQL would cut a different set
    'plan.windowedGroup': [collection, { $subsequence: [
      { $for: { it: '$[*]' }, $groupby: { g: '$it.s' }, $return: { g: '$g' } }, 0, 2] }],
    'plan.groupedAggregate': [collection, { $count: {
      $for: { it: '$[*]' }, $groupby: { g: '$it.s' }, $return: { g: '$g' } } }],
    'entity.notFlwor': [entity, { $count: '$.Person[*]' }],
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
    // a shape of member paths projects; an OPERATOR over one does not,
    // and neither does a bare member path (the entity answers documents)
    'entity.projection': [entity,
      { $for: { p: '$.Person[*]' }, $return: { n: { $count: '$p.name' } } }],
    'entity.order': [entity, E({ $orderby: ['$p.ok'] })],
    'interval.operands': [collection, F({ $where: { $overlaps: ['$it.o', '$it.o'] } })],
    'interval.probe': [collection,
      F({ $where: { $overlaps: ['$it.o', { $const: { start: 2, end: 1 } }] } })],
    // `o` is an object the schema does not type as a half-open span
    'interval.notInterval': [collection,
      F({ $where: { $overlaps: ['$it.o', { $const: { start: 1, end: 2 } }] } })],
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
    'bind.overflow': 'an int64 overflow at run time (the aggregate suites)',
    'bind.path': 'a member name the dialect cannot spell (the hostile suite)',
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
