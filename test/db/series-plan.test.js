//@ts-check
/**
 * @file The temporal planner: which documents a declared `(series, at)`
 * index answers, the SQL each one becomes, and the reason for every
 * refusal.
 *
 * Three shapes are recognized and they are closed — an indexed range,
 * an indexed as-of lookup, and a fixed-width bucket in both spellings
 * the language has for it. This file pins the PLANS (algebra values,
 * no database) and the emitted statements, so a shape that stopped
 * seeking, a ladder that lost its origin or a refusal that changed its
 * word fails here rather than in a benchmark.
 *
 * The reason table is asserted COMPLETE in both directions: every code
 * `series.js` publishes is reachable from a document written here, and
 * every code a document produces is one the table publishes. A reason
 * nobody can reach is a reason nobody can trust.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  planQuery, normalizeModel, planCollection, sqliteDialect, assertNoSqlText, PLAN_VERSION, reasonId,
} from '@jarenjs/db';
import { emitPlan } from '../../packages/db/src/emit.js';
import { predicateTerms } from '../../packages/db/src/plan.js';
import { SERIES_REASONS, filterFacts, singularSelector } from '../../packages/db/src/series.js';

const ORIGIN = 1767225600000;

/** One collection with the composite index the temporal plan needs, and two decoys. */
const MODEL = {
  $model: '0.1',
  collections: {
    sample: {
      schema: {
        type: 'object',
        properties: {
          series: { type: 'string' },
          at: { type: 'integer' },
          on: { type: 'number' },
          value: { type: 'number' },
          gauge: { type: ['number', 'null'] },
          hits: { type: 'integer' },
          mixed: { type: ['number', 'string'] },
          note: { type: 'string' },
        },
      },
      key: null,
      identity: 'integer',
      indexes: [
        { name: 'by_series_at', path: ['$.series', '$.at'] },
        // a real epoch the schema types as a REAL: bucket arithmetic in
        // SQL is integer arithmetic, and this is the column that says so
        { name: 'by_series_on', path: ['$.series', '$.on'] },
        // a singular index over an ordinary member: a range over THIS
        // is not a temporal question, and nothing may pretend it is
        { name: 'by_note', path: '$.note' },
      ],
    },
  },
};

const collection = normalizeModel(MODEL).get('sample');
const physicalPlan = planCollection('sample', collection, sqliteDialect);
const SHAPE = {
  collection: 'sample',
  schema: collection.schema,
  columnByCanonical: physicalPlan.columnByCanonical,
  virtualByStem: new Map(),
  indexes: physicalPlan.expected.indexes,
};
const PHYSICAL = {
  table: physicalPlan.table,
  keyColumn: physicalPlan.keyColumn,
  docColumn: physicalPlan.docColumn,
};

/** A shape whose model declares nothing at all. */
const BARE = { ...SHAPE, columnByCanonical: new Map(), indexes: [] };

const plan = (document, shape = SHAPE) => planQuery(document, shape);
const sqlOf = (planned) => emitPlan(planned.plan, sqliteDialect, PHYSICAL);
/** Every reason code one document names, in the order it named them. */
const codes = (planned) => (planned.series?.reasons ?? []).map((r) => r.code);

/** The narrowed operand every series operator reads: one series' rows. */
const NARROWED = {
  $for: { s: '$[*]' },
  $where: { $eq: ['$s.series', 'a'] },
  $return: '$s',
};

const RANGE = {
  $for: { s: '$[*]' },
  $where: { $and: [
    { $eq: ['$s.series', 'a'] },
    { $ge: ['$s.at', ORIGIN] },
    { $lt: ['$s.at', ORIGIN + 3600000] },
  ] },
  $orderby: [{ $key: '$s.at' }],
  $return: '$s',
};

const ASOF = { $subsequence: [{
  $for: { s: '$[*]' },
  $where: { $and: [{ $eq: ['$s.series', 'a'] }, { $le: ['$s.at', ORIGIN + 500] }] },
  $orderby: [{ $key: '$s.at', $dir: 'desc' }],
  $return: '$s',
}, 0, 1] };

const BUCKET = {
  $for: { s: '$[*]' },
  $where: { $and: [
    { $eq: ['$s.series', 'a'] },
    { $ge: ['$s.at', ORIGIN] },
    { $lt: ['$s.at', ORIGIN + 3600000] },
  ] },
  $groupby: { b: { '$time-bucket': ['$s.at', 60000, ORIGIN] } },
  $orderby: ['$b'],
  $return: { at: '$b', value: { $max: '$s.value' }, count: { $count: '$s' } },
};

describe('the three closed shapes seek the composite index', () => {
  it('a half-open range under a series equality is a native range', () => {
    const planned = plan(RANGE);
    assert.strictEqual(planned.mode, 'native');
    assertNoSqlText(planned.plan);
    assert.deepStrictEqual(planned.series, {
      mode: 'native',
      operation: 'range',
      index: 'sample_by_series_at',
      prefix: ['gx_series'],
      range: { column: 'gx_at', from: ORIGIN, fromOp: 'ge', to: ORIGIN + 3600000, toOp: 'lt' },
      seeks: [],
      ladder: null,
      aggregates: [],
      refinement: null,
      reasons: [],
    });
  });

  it('one bound, ordered and cut to a finite window, is a native as-of', () => {
    const planned = plan(ASOF);
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.series.operation, 'asof');
    assert.strictEqual(planned.series.index, 'sample_by_series_at');
    assert.deepStrictEqual(planned.series.range,
      { column: 'gx_at', from: null, fromOp: null, to: ORIGIN + 500, toOp: 'le' });
    assert.match(sqlOf(planned).sql, /DESC NULLS LAST.*LIMIT 1$/);
  });

  it('one bound WITHOUT a window is a range, not an as-of: nothing cuts it', () => {
    const planned = plan({ ...ASOF.$subsequence[0] });
    assert.strictEqual(planned.series.operation, 'range');
  });

  it('a $time-bucket grouping with the exact aggregates is a native bucket', () => {
    const planned = plan(BUCKET);
    assert.strictEqual(planned.mode, 'native');
    assert.deepStrictEqual(planned.plan.bucket, {
      ref: { segments: [{ name: 'at' }], type: 'integer', column: 'gx_at' },
      every: 60000,
      origin: ORIGIN,
      as: 'at',
      order: 'asc',
      aggregates: [
        { fn: 'max', as: 'value', empty: 'omit',
          ref: { segments: [{ name: 'value' }], type: 'number', column: null } },
        { fn: 'rows', ref: null, as: 'count', empty: 'null' },
      ],
    });
    assertNoSqlText(planned.plan);
    assert.strictEqual(planned.series.operation, 'bucket');
    assert.deepStrictEqual(planned.series.ladder,
      { every: 60000, origin: ORIGIN, calendar: false });
  });

  it('a $resample whose spec asks for nothing a GROUP BY cannot do is native too', () => {
    const planned = plan({ $resample: [NARROWED, { every: 60000, origin: ORIGIN, aggregate: 'max' }] });
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.series.operation, 'resample');
    assert.strictEqual(planned.series.index, 'sample_by_series_at');
    assert.deepStrictEqual(planned.plan.bucket.aggregates.map((a) => [a.fn, a.as, a.empty]),
      [['max', 'value', 'null'], ['rows', 'count', 'null']]);
  });

  it("aggregate: 'count' answers the row count as the value AND as the count", () => {
    const planned = plan({ $resample: [NARROWED, { every: 60000, aggregate: 'count' }] });
    assert.deepStrictEqual(planned.plan.bucket.aggregates.map((a) => [a.fn, a.ref]),
      [['rows', null], ['rows', null]]);
  });

  it('an ordinary range over an ordinary indexed member is not a temporal question', () => {
    const planned = plan({ $for: { s: '$[*]' },
      $where: { '$starts-with': ['$s.note', 'x'] }, $return: '$s' });
    assert.strictEqual(planned.series, null,
      'a singular index cannot make a query temporal — only the composite shape can');
  });
});

describe('the emitted statements: one ladder, written once', () => {
  it('the bucket ladder is integer arithmetic with the origin and width bound', () => {
    const emitted = sqlOf(plan(BUCKET));
    assert.match(emitted.sql,
      /SELECT \("gx_at" - \(\(\("gx_at" - \?\) % \? \+ \?\) % \?\)\) AS "at"/);
    assert.match(emitted.sql, /CAST\(MAX\(jsonb_extract\("doc", '\$\."value"'\)\) AS REAL\) AS "value"/);
    assert.match(emitted.sql, /COUNT\(\*\) AS "count"/);
    assert.match(emitted.sql, /GROUP BY "at" ORDER BY "at" ASC$/);
    // the ladder's parameters come FIRST and in text order: the origin
    // once, the width three times, and only then the filter's own
    assert.deepStrictEqual(emitted.slots.slice(0, 4).map((s) => s.literal),
      [ORIGIN, 60000, 60000, 60000]);
    assert.deepStrictEqual(emitted.slots.slice(4).map((s) => s.literal),
      ['a', ORIGIN, ORIGIN + 3600000]);
  });

  it('with no $orderby the groups come out in first-appearance order', () => {
    const unordered = { ...BUCKET };
    delete unordered.$orderby;
    const planned = plan(unordered);
    assert.strictEqual(planned.plan.bucket.order, 'first-seen');
    assert.match(sqlOf(planned).sql, /GROUP BY "at" ORDER BY MIN\("rowid"\)$/);
  });

  it('a descending $orderby on the key reverses the groups', () => {
    const planned = plan({ ...BUCKET, $orderby: [{ $key: '$b', $dir: 'desc' }] });
    assert.strictEqual(planned.plan.bucket.order, 'desc');
    assert.match(sqlOf(planned).sql, /ORDER BY "at" DESC$/);
  });

  it('the range seeks with both bounds and the identity tiebreaker', () => {
    const emitted = sqlOf(plan(RANGE));
    assert.match(emitted.sql, /"gx_at" >= \?/);
    assert.match(emitted.sql, /"gx_at" < \?/);
    // the order reads the double the engine orders by, so it sorts the range the index seeks
    assert.match(emitted.sql, /ORDER BY CAST\("gx_at" AS REAL\) ASC NULLS FIRST, "rowid"$/);
  });
});

describe('the ladder folds what it can and refuses what it cannot', () => {
  const bucketWith = (args) => plan({ ...BUCKET, $groupby: { b: { '$time-bucket': args } } });

  it("an ISO width is the same ladder as its milliseconds", () => {
    assert.strictEqual(bucketWith(['$s.at', 'PT1H', ORIGIN]).plan.bucket.every, 3600000);
    assert.strictEqual(bucketWith(['$s.at', 3600000, ORIGIN]).plan.bucket.every, 3600000);
  });

  it("an absent origin is the kernel's own anchor, not a second guess at it", () => {
    assert.strictEqual(bucketWith(['$s.at', 'PT1H']).plan.bucket.origin, 0);
    assert.strictEqual(bucketWith(['$s.at', 'PT1H', null]).plan.bucket.origin, 0);
  });

  it('an { offset } context folds into the anchor, because it is arithmetic', () => {
    const planned = bucketWith(['$s.at', 'PT1H', null, { offset: 30 }]);
    assert.strictEqual(planned.plan.bucket.origin, -1800000,
      'thirty minutes east moves local midnight off UTC\'s');
  });

  it('a named zone is never native: its clock is host code', () => {
    const planned = bucketWith(['$s.at', 'PT1H', null, { zone: 'Europe/Amsterdam' }]);
    assert.deepStrictEqual(codes(planned), ['named-zone']);
    assert.strictEqual(planned.mode, 'set');
  });

  it('a calendar width walks a wall clock, so it is a refinement', () => {
    assert.deepStrictEqual(codes(bucketWith(['$s.at', 'P1M', ORIGIN])), ['calendar-width']);
  });

  it("a width or an origin that is an EXPRESSION cannot be a grouping key", () => {
    assert.deepStrictEqual(codes(bucketWith(['$s.at', '$s.at', ORIGIN])), ['nonliteral-spec']);
    assert.deepStrictEqual(codes(bucketWith(['$s.at', 60000, '$s.at'])), ['nonliteral-spec']);
  });

  it('a REAL instant column is not a whole epoch, and says so', () => {
    assert.deepStrictEqual(codes(bucketWith(['$s.on', 60000, ORIGIN])), ['instant-not-integer']);
  });

  it('a $resample count still needs a numeric reading: the kernel reads it off every row', () => {
    const counted = (/** @type {any} */ value) => plan({ $resample: [NARROWED,
      { every: 60000, aggregate: 'count', ...(value === undefined ? {} : { value }) }] });
    assert.strictEqual(counted().plan.bucket.aggregates[0].fn, 'rows');
    assert.deepStrictEqual(codes(counted('$.note')), ['value-not-numeric']);
    assert.deepStrictEqual(codes(counted('$.mixed')), ['value-not-numeric']);
    assert.notStrictEqual(counted('$.note').mode, 'native');
  });
});

describe('every refinement names one reason, and the table is complete', () => {
  /** One document per reason code, so the table is reachable. */
  const REACHED = {
    'fill-policy': { $resample: [NARROWED, { every: 60000, fill: 'null' }] },
    'unsupported-aggregate': { $resample: [NARROWED, { every: 60000, aggregate: 'first' }] },
    'calendar-width': { $resample: [NARROWED, { every: 'P1M' }] },
    'named-zone': { $resample: [NARROWED, { every: 'PT1H', zone: 'Europe/Amsterdam' }] },
    'rolling-refinement': { $rolling: [NARROWED, { width: 60000 }] },
    'asof-refinement': { $asof: [{ $const: [{ at: 0, value: 1 }] }, '$[*]', {}] },
    'row-selector': { $resample: [NARROWED, { every: 60000, at: '$.a.b' }] },
    'instant-not-integer': { $resample: [NARROWED, { every: 60000, at: '$.on' }] },
    'value-not-numeric': { $resample: [NARROWED, { every: 60000, value: '$.note' }] },
    'floating-accumulation': { $resample: [NARROWED, { every: 60000 }] },
    'nullable-reading': { ...BUCKET, $return: { at: '$b', v: { $max: '$s.gauge' } } },
    'nonliteral-spec': { ...BUCKET, $groupby: { b: { '$time-bucket': ['$s.at', '$s.at'] } } },
    'nonnative-grouping': { ...BUCKET, $return: { at: '$b', n: { $count: '$s.value' } } },
    'missing-series-prefix': { $resample: ['$[*]', { every: 60000, aggregate: 'max' }] },
    'invalid-spec': { $resample: [NARROWED, { every: 60000, start: 'not-an-instant' }] },
  };

  it('every reason the table publishes is one a document can reach', () => {
    // a reason nobody can reach is a reason nobody can trust, and a
    // table that grew a row no test exercises is how that happens
    assert.deepStrictEqual(Object.keys(REACHED).sort(), Object.keys(SERIES_REASONS).sort());
  });

  for (const [code, document] of Object.entries(REACHED)) {
    it(`${code} is reachable, and it is the FIRST reason`, () => {
      const planned = plan(document);
      assert.ok(codes(planned).includes(code),
        `${code} unreached: ${JSON.stringify(codes(planned))}`);
      assert.strictEqual(codes(planned)[0], code);
    });
  }

  it('every reason a document reaches is one the table publishes', () => {
    for (const document of Object.values(REACHED)) {
      for (const code of codes(plan(document)))
        assert.ok(code in SERIES_REASONS, `'${code}' is not in the published table`);
    }
  });

  it('the code is the first word of the sentence the plan carries', () => {
    const planned = plan(REACHED['fill-policy']);
    assert.strictEqual(planned.series.reasons[0].reason,
      `fill-policy: ${SERIES_REASONS['fill-policy']}`);
    assert.ok(planned.reasons.some((r) => r.reason.startsWith('fill-policy:')),
      'the plan carries the same sentence strict mode will name');
  });

  it('a spec the KERNEL refuses is never planned native — the engine raises it', () => {
    // `analyzeQuery` does not compile an operator, so a spec whose
    // window names no instant reaches the planner before the engine has
    // had its say. A plan that answered where the engine raises is the
    // one thing a pushdown may never do
    const planned = plan({ $resample: [NARROWED, { every: 60000, start: 'not-an-instant' }] });
    assert.strictEqual(planned.mode, 'set');
    assert.deepStrictEqual(codes(planned), ['invalid-spec']);
  });

  it('a model that declares no index at all reads every row, and says so', () => {
    const planned = plan({ $resample: [NARROWED, { every: 60000 }] }, BARE);
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.series.index, null);
    assert.deepStrictEqual(codes(planned), ['missing-series-prefix']);
  });

  it('a bucket over the WHOLE collection is still native, and still names the scan', () => {
    // the database answers it — a scan is a plan, not a residual — and
    // the reason is what tells a reader the index earned nothing here
    const planned = plan({ $resample: ['$[*]', { every: 60000, aggregate: 'max' }] });
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.series.mode, 'native');
    assert.deepStrictEqual(codes(planned), ['missing-series-prefix']);
  });
});

describe('a fill window the kernel refuses is not a pushdown', () => {
  it('names invalid-spec for a fill over more buckets than one call may emit', () => {
    const wide = (/** @type {string} */ fill) => plan({ $resample: [NARROWED,
      { every: 1, fill, start: ORIGIN, end: ORIGIN + 1e12 }] });
    assert.deepStrictEqual(codes(wide('null')), ['invalid-spec']);
    assert.notStrictEqual(wide('null').mode, 'native');
    // the same window without a fill is the kernel's to walk, occupied buckets only
    assert.ok(!codes(plan({ $resample: [NARROWED,
      { every: 1, start: ORIGIN, end: ORIGIN + 1e12 }] })).includes('invalid-spec'));
  });
});

describe('a narrowing is implied, never decided', () => {
  it("a $resample's own window bounds the fetch and stays the kernel's to apply", () => {
    const planned = plan({ $resample: [NARROWED,
      { every: 60000, fill: 'null', start: ORIGIN, end: ORIGIN + 600000 }] });
    assert.strictEqual(planned.series.mode, 'hybrid');
    assert.deepStrictEqual(planned.series.range,
      { column: 'gx_at', from: ORIGIN, fromOp: 'ge', to: ORIGIN + 600000, toOp: 'lt' });
    assert.deepStrictEqual(planned.prefilters,
      [{ construct: '$resample', via: 'columns', columns: ['gx_at'], exact: false }]);
    assert.strictEqual(planned.series.refinement, 'resampleSeries');
  });

  it('an as-of join bounds the fetch by the probes it was given, and by their keys', () => {
    const probes = [{ at: 1000, value: 1, series: 'a' }, { at: 5000, value: 2, series: 'b' }];
    const planned = plan({ $asof: [{ $const: probes }, '$[*]', { by: '$.series' }] });
    assert.strictEqual(planned.series.mode, 'hybrid');
    assert.deepStrictEqual(planned.series.range,
      { column: 'gx_at', from: null, fromOp: null, to: 5000, toOp: 'le' });
    // one membership list however many keys the probes name, so the filter is one leaf
    assert.match(sqlOf(planned).sql, /"gx_series" IN \(SELECT value FROM json_each\(\?\)/);
    assert.deepStrictEqual(planned.plan.filter.items.find((item) => item.p === 'in'),
      { p: 'in', ref: { segments: [{ name: 'series' }], type: 'string', column: 'gx_series' },
        operand: { list: ['a', 'b'] } });
    assert.strictEqual(planned.series.index, 'sample_by_series_at',
      'a membership test over the leading column still seeks');
  });

  it('a single key stays one equality, and many keys stay one leaf', () => {
    const asof = (/** @type {number} */ count) => plan({ $asof: [{ $const: Array.from({ length: count }, (_, k) =>
      ({ at: 1000 + k, value: k, series: `s${k}` })) }, '$[*]', { by: '$.series' }] });
    // the probes' last instant, the data's own anchor, and the keys
    for (const count of [1, 2, 3, 500]) assert.strictEqual(predicateTerms(asof(count).plan), 3, `${count} keys`);
    assert.strictEqual(asof(1).plan.filter.items.at(-1).p, 'colCmp');
    assert.strictEqual(asof(3).plan.filter.items.at(-1).p, 'in');
  });

  it('a tolerance bounds BOTH sides, which is the smallest fetch there is', () => {
    const probes = [{ at: 1000, value: 1 }, { at: 5000, value: 2 }];
    const planned = plan({ $asof: [{ $const: probes }, '$[*]',
      { direction: 'nearest', tolerance: 250 }] });
    assert.deepStrictEqual(planned.series.range,
      { column: 'gx_at', from: 750, fromOp: 'ge', to: 5250, toOp: 'le' });
  });

  it('nearest without a tolerance has no ARITHMETIC bound, and seeks both anchors', () => {
    const probes = [{ at: 1000, value: 1 }];
    const planned = plan({ $asof: [{ $const: probes }, '$[*]', { direction: 'nearest' }] });
    // no range: neither side is a number the probes imply. The bounds
    // it does carry are the data's own, one statement each
    assert.strictEqual(planned.series.range, null);
    assert.strictEqual(planned.series.mode, 'hybrid');
    assert.deepStrictEqual(planned.series.seeks, [
      { side: 'lower', column: 'gx_at', probe: 1000, op: 'ge' },
      { side: 'upper', column: 'gx_at', probe: 1000, op: 'le' },
    ]);
    const emitted = sqlOf(planned);
    assert.strictEqual(emitted.seeks.length, 2);
    assert.match(emitted.seeks[0].sql, /SELECT MAX\("gx_at"\).*WHERE.*<= \?/s);
    assert.match(emitted.seeks[1].sql, /SELECT MIN\("gx_at"\).*WHERE.*>= \?/s);
  });

  it('a tolerance answers both sides by arithmetic, so it asks for no anchor', () => {
    const probes = [{ at: 1000, value: 1 }];
    const planned = plan({ $asof: [{ $const: probes }, '$[*]',
      { direction: 'nearest', tolerance: 250 }] });
    assert.deepStrictEqual(planned.series.seeks, []);
    assert.strictEqual(sqlOf(planned).seeks.length, 0);
  });

  it('a keyed anchor folds the groups: the LEAST of their own last instants', () => {
    const probes = [{ at: 1000, value: 1, series: 'a' }, { at: 5000, value: 2, series: 'b' }];
    const planned = plan({ $asof: [{ $const: probes }, '$[*]', { by: '$.series' }] });
    assert.deepStrictEqual(planned.series.seeks,
      [{ side: 'lower', column: 'gx_at', probe: 1000, op: 'ge' }]);
    const seek = sqlOf(planned).seeks[0];
    // a single global MAX would be unsound — it can come from one group
    // and drop another's only candidate — so the fold is per group
    assert.match(seek.sql, /SELECT MIN\("a"\) AS "anchor" FROM \(SELECT MAX\("gx_at"\)/);
    assert.match(seek.sql, /GROUP BY "gx_series"\)$/);
  });

  it('the collection on the LEFT is never narrowed: every left row is answered', () => {
    const probes = [{ at: 1000, value: 1 }];
    const planned = plan({ $asof: ['$[*]', { $const: probes }, {}] });
    assert.strictEqual(planned.series.mode, 'engine');
    assert.strictEqual(planned.plan.filter, null);
  });
});

describe("a floating sum or average in a bucket is the engine's, and the fetch still seeks", () => {
  /** The grouping spelling, aggregating `member` with `fn`. */
  const grouped = (fn, member = 'value') => ({ ...BUCKET,
    $return: { at: '$b', value: { [fn]: `$s.${member}` }, count: { $count: '$s' } } });
  /** The ladder spelling, reading `member` through `aggregate`. */
  const resampled = (aggregate, member = 'value') => ({ $resample: [NARROWED,
    { every: 60000, origin: ORIGIN, aggregate, value: `$.${member}` }] });

  it('a $sum or $avg over a number reading names the code in the grouping spelling', () => {
    for (const fn of ['$sum', '$avg']) {
      const planned = plan(grouped(fn));
      assert.strictEqual(planned.mode, 'set', fn);
      assert.strictEqual(planned.plan.bucket, null, fn);
      assert.deepStrictEqual(codes(planned), ['floating-accumulation'], fn);
      assert.strictEqual(planned.reasons[0].construct, '$groupby', fn);
      assert.strictEqual(reasonId(planned.reasons[0].reason), 'series.floating-accumulation', fn);
      // the residual keeps the narrowing: the series index and its prefix
      assert.strictEqual(planned.series.mode, 'hybrid', fn);
      assert.strictEqual(planned.series.operation, 'bucket', fn);
      assert.strictEqual(planned.series.refinement, 'resampleSeries', fn);
      assert.strictEqual(planned.series.index, 'sample_by_series_at', fn);
      assert.deepStrictEqual(planned.series.prefix, ['gx_series'], fn);
      assert.match(sqlOf(planned).sql, /"gx_series" = \?/, fn);
      assert.doesNotMatch(sqlOf(planned).sql, /GROUP BY/, fn);
    }
  });

  it('a $resample sum or mean — the default included — names it too', () => {
    for (const aggregate of ['sum', 'mean']) {
      const planned = plan(resampled(aggregate));
      assert.strictEqual(planned.mode, 'set', aggregate);
      assert.strictEqual(planned.plan.bucket, null, aggregate);
      assert.deepStrictEqual(codes(planned), ['floating-accumulation'], aggregate);
      assert.strictEqual(planned.reasons[0].construct, '$resample', aggregate);
      assert.strictEqual(reasonId(planned.reasons[0].reason), 'series.floating-accumulation', aggregate);
      assert.strictEqual(planned.series.mode, 'hybrid', aggregate);
      assert.strictEqual(planned.series.operation, 'resample', aggregate);
      assert.strictEqual(planned.series.refinement, 'resampleSeries', aggregate);
      assert.strictEqual(planned.series.index, 'sample_by_series_at', aggregate);
      assert.deepStrictEqual(planned.series.prefix, ['gx_series'], aggregate);
    }
    // the spec's default aggregate is the mean
    assert.deepStrictEqual(codes(plan({ $resample: [NARROWED, { every: 60000 }] })),
      ['floating-accumulation']);
  });

  it('extremes, counts and integer readings stay native, the integer sums beside their guard', () => {
    for (const document of [grouped('$min'), grouped('$max'), resampled('min'),
      resampled('max'), resampled('count')]) {
      const planned = plan(document);
      assert.strictEqual(planned.mode, 'native');
      assert.deepStrictEqual(planned.reasons, []);
      assert.doesNotMatch(sqlOf(planned).sql, /_safe/);
    }
    for (const document of [grouped('$sum', 'hits'), grouped('$avg', 'hits'),
      resampled('sum', 'hits'), resampled('mean', 'hits')]) {
      const planned = plan(document);
      assert.strictEqual(planned.mode, 'native');
      assert.deepStrictEqual(planned.reasons, []);
      assert.match(sqlOf(planned).sql, /AS "_safe0"/);
    }
  });

  it('a reading of two types still names value-not-numeric first', () => {
    for (const document of [grouped('$sum', 'mixed'), grouped('$avg', 'mixed'),
      resampled('sum', 'mixed'), resampled('mean', 'mixed')])
      assert.deepStrictEqual(codes(plan(document)), ['value-not-numeric']);
  });
});

describe('strict mode refuses every hybrid and engine plan before execution', () => {
  const strictShape = { ...SHAPE };
  for (const [label, document] of Object.entries({
    'a fill policy': { $resample: [NARROWED, { every: 60000, fill: 'locf' }] },
    'a floating mean': { $resample: [NARROWED, { every: 60000 }] },
    'a floating sum in a grouping': { ...BUCKET,
      $return: { at: '$b', value: { $sum: '$s.value' }, count: { $count: '$s' } } },
    'a calendar width': { $resample: [NARROWED, { every: 'P1M' }] },
    'a rolling window': { $rolling: [NARROWED, { width: 60000 }] },
    'an as-of join': { $asof: [{ $const: [{ at: 0, value: 1 }] }, '$[*]', {}] },
  })) {
    it(`${label} is not native, so strict mode has a reason to name`, () => {
      const planned = plan(document, strictShape);
      assert.notStrictEqual(planned.mode, 'native');
      assert.ok(planned.reasons.length > 0);
      assert.ok(planned.reasons[0].reason.includes(':'),
        'the first reason is the temporal one, which is what JD0010 prints');
    });
  }

  it('the three native shapes carry no reason at all', () => {
    for (const document of [RANGE, ASOF, BUCKET,
      { $resample: [NARROWED, { every: 60000, aggregate: 'max' }] }]) {
      const planned = plan(document);
      assert.strictEqual(planned.mode, 'native');
      assert.deepStrictEqual(planned.reasons, []);
    }
  });
});

describe('the row selector reads the two spellings a member has', () => {
  it('a dotted name, a quoted name, and nothing else', () => {
    assert.strictEqual(singularSelector('$.on'), 'on');
    assert.strictEqual(singularSelector("$['recorded at']"), 'recorded at');
    assert.strictEqual(singularSelector('$["recorded at"]'), 'recorded at');
    assert.strictEqual(singularSelector('$.rows[*].on'), null);
    assert.strictEqual(singularSelector('$.a.b'), null);
    assert.strictEqual(singularSelector('$'), null);
    assert.strictEqual(singularSelector(42), null);
  });

  it('a selector that names a member names its column', () => {
    const planned = plan({ $resample: [NARROWED,
      { every: 60000, at: '$.at', value: '$.value', aggregate: 'max' }] });
    assert.strictEqual(planned.mode, 'native');
    assert.strictEqual(planned.plan.bucket.ref.column, 'gx_at');
  });
});

describe('a peeled window composes over a temporal plan', () => {
  it('a native bucket takes the window as a LIMIT over its ascending groups', () => {
    const planned = plan({ $subsequence: [
      { $resample: [NARROWED, { every: 60000, origin: ORIGIN, aggregate: 'max' }] }, 1, 2] });
    assert.strictEqual(planned.mode, 'native');
    assert.deepStrictEqual(planned.plan.window, { offset: 1, limit: 2 });
    assert.match(sqlOf(planned).sql, /GROUP BY "at" ORDER BY "at" ASC LIMIT 2 OFFSET 1$/);
  });

  it('a refinement keeps none of it — the residual applies the window itself', () => {
    const planned = plan({ $subsequence: [
      { $rolling: [NARROWED, { width: 30000 }] }, 0, 3] });
    assert.strictEqual(planned.mode, 'set');
    assert.strictEqual(planned.plan.window, null);
    assert.strictEqual(planned.series.operation, 'rolling');
  });
});

describe('the plan stamp and the tripwire', () => {
  it('a bucket plan is a plan: versioned, SQL-free, and carrying no rank', () => {
    const planned = plan(BUCKET);
    assert.strictEqual(planned.plan.planVersion, PLAN_VERSION);
    assert.strictEqual(planned.plan.rank, null);
    assert.strictEqual(planned.plan.aggregate, null);
    assertNoSqlText(planned.plan);
  });
});

describe('what a pushed filter pins for a seek', () => {
  const PIN_MODEL = { $model: '0.1', collections: { rows: {
    schema: { type: 'object', properties: { id: { type: 'string' }, series: { type: 'string' }, at: { type: 'integer' } } },
    key: '/id', indexes: [{ name: 'by_series', path: '$.series' }, { name: 'by_at', path: '$.at' }] } } };
  const rows = normalizeModel(PIN_MODEL).get('rows');
  const PIN_SHAPE = { collection: 'rows', schema: rows.schema,
    columnByCanonical: planCollection('rows', rows, sqliteDialect).columnByCanonical };
  const series = (/** @type {any} */ value) => ({ $eq: ['$it.series', value] });
  const pinnedBy = (/** @type {any} */ predicate) => {
    const planned = planQuery({ $for: { it: '$[*]' }, $where: predicate, $return: '$it' }, PIN_SHAPE);
    assert.strictEqual(planned.mode, 'native');
    return [...filterFacts(planned.plan.filter).pinned];
  };

  it('a membership list pins its column exactly as the equalities it stands for did', () => {
    // literal and external equalities of one member: the literals regroup
    // into one list beside the external's comparison, and the column is
    // still the one every item reads
    assert.deepStrictEqual(pinnedBy({ $or: [series('a'), series('b'), series('$x')] }), ['gx_series']);
    assert.deepStrictEqual(pinnedBy({ $or: [series('a'), series('b')] }), ['gx_series']);
    assert.deepStrictEqual(pinnedBy({ $eq: ['$it.series', { $seq: ['a', 'b'] }] }), ['gx_series']);
    assert.deepStrictEqual(pinnedBy({ $eq: ['$it.series', '$ids[*]'] }), ['gx_series']);
    assert.deepStrictEqual(pinnedBy({ $and: [series('a'), { $gt: ['$it.at', 5] }] }), ['gx_series']);
    // two columns, or a ray, decide no seek
    assert.deepStrictEqual(pinnedBy({ $or: [series('a'), { $eq: ['$it.at', 5] }] }), []);
    assert.deepStrictEqual(pinnedBy({ $or: [series('a'), series('b'), { $gt: ['$it.at', 5] }] }), []);
  });
});

describe('the range an explain reports is the tightest bound the filter holds', () => {
  const rangeOf = (/** @type {any[]} */ items, extra = {}) => plan({
    $for: { s: '$[*]' },
    $where: { $and: [{ $eq: ['$s.series', 'a'] }, ...items] },
    $orderby: [{ $key: '$s.at' }],
    $return: '$s',
    ...extra,
  }).series.range;
  const at = (/** @type {string} */ op, /** @type {any} */ value) => ({ [op]: ['$s.at', value] });

  it('two lower bounds, in either order, report the larger; two upper bounds the smaller', () => {
    assert.deepStrictEqual(rangeOf([at('$ge', 100), at('$ge', 50), at('$lt', 200)]),
      { column: 'gx_at', from: 100, fromOp: 'ge', to: 200, toOp: 'lt' });
    assert.deepStrictEqual(rangeOf([at('$ge', 50), at('$ge', 100), at('$lt', 200)]),
      { column: 'gx_at', from: 100, fromOp: 'ge', to: 200, toOp: 'lt' });
    assert.deepStrictEqual(rangeOf([at('$ge', 100), at('$lt', 300), at('$lt', 200)]),
      { column: 'gx_at', from: 100, fromOp: 'ge', to: 200, toOp: 'lt' });
    assert.deepStrictEqual(rangeOf([at('$ge', 100), at('$lt', 200), at('$le', 900)]),
      { column: 'gx_at', from: 100, fromOp: 'ge', to: 200, toOp: 'lt' });
  });

  it('a bound that is not a literal never displaces one that is', () => {
    const expected = { column: 'gx_at', from: 100, fromOp: 'ge', to: 200, toOp: 'lt' };
    assert.deepStrictEqual(rangeOf([at('$ge', 100), at('$ge', '$x'), at('$lt', 200), at('$lt', '$y')]), expected);
    assert.deepStrictEqual(rangeOf([at('$ge', '$x'), at('$ge', 100), at('$lt', '$y'), at('$lt', 200)]), expected);
  });

  it('at an equal value the strict comparison is the tighter one, whichever came first', () => {
    assert.deepStrictEqual(rangeOf([at('$ge', 100), at('$gt', 100), at('$le', 200), at('$lt', 200)]),
      { column: 'gx_at', from: 100, fromOp: 'gt', to: 200, toOp: 'lt' });
    assert.deepStrictEqual(rangeOf([at('$gt', 100), at('$ge', 100), at('$lt', 200), at('$le', 200)]),
      { column: 'gx_at', from: 100, fromOp: 'gt', to: 200, toOp: 'lt' });
  });

  it("a $resample window beside the operand's own bound reports the tighter of the two", () => {
    const resample = (/** @type {any} */ spec, /** @type {any} */ where) => plan({ $resample: [{
      $for: { s: '$[*]' },
      $where: { $and: [{ $eq: ['$s.series', 'a'] }, ...where] },
      $return: '$s',
    }, { every: 60000, aggregate: 'max', ...spec }] });
    const loose = resample({ start: 50, end: 900 }, [at('$ge', 100), at('$lt', 400)]);
    assert.strictEqual(loose.mode, 'native');
    assert.deepStrictEqual(loose.series.range,
      { column: 'gx_at', from: 100, fromOp: 'ge', to: 400, toOp: 'lt' });
    const tight = resample({ start: 150, end: 300 }, [at('$ge', 100), at('$lt', 400)]);
    assert.deepStrictEqual(tight.series.range,
      { column: 'gx_at', from: 150, fromOp: 'ge', to: 300, toOp: 'lt' });
  });
});
