//@ts-check
/**
 * @file Sums and averages answer what the engine answers. The engine adds
 * left to right in doubles; SQLite's compensated SUM and PostgreSQL's exact
 * numeric sum do not, so a floating sum or average over a collection runs
 * in the engine under a named reason, as it does over an entity. An integer
 * one stays native while every partial sum is exact — the largest
 * magnitude times the number of terms within 2^53 - 1 — and past that
 * bound the call answers from the engine and names the runtime reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reasonId } from '@jarenjs/db';
import { compileJsonQuery } from '@jarenjs/json/query';
import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const BIG = 9007199254740991;
const DOCUMENTS = [
  { id: 'a', g: 'x', n: 1e16, i: BIG },
  { id: 'b', g: 'x', n: 1, i: 2 },
  { id: 'c', g: 'x', n: -1e16, i: -BIG },
  { id: 'd', g: 'z', n: 0.1, i: 5 },
  { id: 'e', g: 'z', n: 0.2, i: 7 },
  { id: 'f', g: 'z', n: 0.3, i: 11 },
];

/** @param {boolean} indexed */
const collectionModel = (indexed) => ({ $model: '0.1', collections: { rows: {
  key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, g: { type: 'string' }, n: { type: 'number' }, i: { type: 'integer' } } },
  indexes: indexed ? [{ name: 'by_g', path: '$.g' }, { name: 'by_n', path: '$.n' }, { name: 'by_i', path: '$.i' }] : [],
} } });

/** @param {string} fn @param {string} member */
const grouped = (fn, member) => ({ $for: { it: '$[*]' }, $groupby: { g: '$it.g' }, $return: { g: '$g', v: { [fn]: `$it.${member}` } } });
/** @param {string} fn @param {string} member @param {any} [where] */
const whole = (fn, member, where = undefined) =>
  ({ [fn]: { $for: { it: '$[*]' }, ...(where === undefined ? {} : { $where: where }), $return: `$it.${member}` } });

/** @param {any} store */
async function seeded(store) {
  const rows = store.collection('rows');
  for (const document of DOCUMENTS) await rows.insert(document);
  return rows;
}
/** @param {any} explained */
const ids = (explained) => (explained.residual?.reasons ?? []).map((/** @type {any} */ r) => reasonId(r.reason));

describe('a floating sum or average over a collection', () => {
  for (const indexed of [true, false]) {
    it(`answers the engine's left-to-right accumulation (${indexed ? 'indexed' : 'unindexed'})`, async () => {
      await onBothEngines(collectionModel(indexed), async (store, host) => {
        const rows = await seeded(store);
        const cases = [
          [grouped('$sum', 'n'), [{ g: 'x', v: 0 }, { g: 'z', v: 0.6000000000000001 }]],
          [grouped('$avg', 'n'), [{ g: 'x', v: 0 }, { g: 'z', v: 0.20000000000000004 }]],
          [whole('$sum', 'n'), 0.6000000000000001],
          [whole('$avg', 'n'), 0.10000000000000002],
          [whole('$sum', 'n', { $eq: ['$it.g', 'x'] }), 0],
        ];
        for (const [document, answer] of cases) {
          const label = `${host} ${JSON.stringify(document)}`;
          assert.deepEqual(compileJsonQuery(document)(structuredClone(DOCUMENTS)), answer, `engine: ${label}`);
          assert.deepEqual(await rows.execute(document), answer, label);
          const explained = await rows.explain(document);
          assert.equal(explained.mode, 'set', label);
          assert.equal(ids(explained)[0], 'plan.floatingAccumulation', label);
          await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })), { code: 'JD0010' }, label);
          const items = [];
          for await (const item of rows.query(document)) items.push(item);
          assert.deepEqual(items, Array.isArray(answer) ? answer : [answer], label);
        }
      });
    });
  }
});

describe('an integer sum or average over a collection', () => {
  for (const indexed of [true, false]) {
    it(`falls back to the engine past its exactness bound, and says so (${indexed ? 'indexed' : 'unindexed'})`, async () => {
      await onBothEngines(collectionModel(indexed), async (store, host) => {
        const rows = await seeded(store);
        const cases = [
          [grouped('$sum', 'i'), [{ g: 'x', v: 1 }, { g: 'z', v: 23 }]],
          [grouped('$avg', 'i'), [{ g: 'x', v: 0.3333333333333333 }, { g: 'z', v: 7.666666666666667 }]],
          [whole('$sum', 'i'), 24],
          [whole('$avg', 'i'), 4],
        ];
        for (const [document, answer] of cases) {
          const label = `${host} ${JSON.stringify(document)}`;
          assert.deepEqual(compileJsonQuery(document)(structuredClone(DOCUMENTS)), answer, `engine: ${label}`);
          assert.equal((await rows.explain(document)).mode, 'native', label);
          assert.deepEqual(await rows.execute(document), answer, label);
          const explained = await rows.explain(document);
          assert.equal(explained.mode, 'native', `the plan still pushes: ${label}`);
          assert.deepEqual(explained.fallback,
            { construct: 'accumulation', runs: 1, reason: 'integer accumulation exceeded its runtime exactness bound' }, label);
          assert.equal(reasonId(explained.fallback.reason), 'bind.accumulation', label);
          const items = [];
          for await (const item of rows.query(document)) items.push(item);
          assert.deepEqual(items, Array.isArray(answer) ? answer : [answer], label);
          await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })),
            { code: 'JD0010', message: /integer accumulation exceeded its runtime exactness bound/ }, label);
        }
        // inside the bound the answer is the database's, with no fallback
        const inside = whole('$sum', 'i', { $eq: ['$it.g', 'z'] });
        assert.equal(await rows.execute(inside), 23, host);
        assert.equal((await rows.explain(inside)).fallback, null, host);
        const groupsInside = { $for: { it: '$[*]' }, $where: { $eq: ['$it.g', 'z'] }, $groupby: { g: '$it.g' },
          $return: { g: '$g', v: { $avg: '$it.i' } } };
        // one group is one item, which the engine answers bare
        assert.deepEqual(await rows.execute(groupsInside), { g: 'z', v: 7.666666666666667 }, host);
        assert.equal((await rows.explain(groupsInside)).fallback, null, host);
      });
    });
  }
});

describe('an entity grouping past its integer exactness bound', () => {
  it('names the runtime reason in the closed vocabulary', async () => {
    const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, g: { type: 'string' }, i: { type: 'integer' } } } } } };
    await onBothEngines(model, async (store, host) => {
      const items = store.entity('Item');
      for (const { id, g, i } of DOCUMENTS) await items.create({ id, g, i });
      const document = { $for: { it: '$.Item[*]' }, $groupby: { g: '$it.g' }, $return: { g: '$g', t: { $sum: '$it.i' } } };
      assert.deepEqual(await store.execute(document), [{ g: 'x', t: 1 }, { g: 'z', t: 23 }], host);
      const explained = await store.explain(document);
      assert.equal(explained.mode, 'set', host);
      assert.ok(explained.residual.reasons.length > 0, host);
      assert.deepEqual(explained.residual.reasons.map((/** @type {any} */ r) => reasonId(r.reason)).filter((id) => id === null), [], host);
      if (host === 'sqlite') assert.equal(reasonId(explained.residual.reasons[0].reason), 'bind.accumulation');
    });
  });
});

describe('a floating sum or average under a profile', () => {
  it('fetches only the rows its pushed where selects, so a bounded profile answers it', async () => {
    await onBothEngines(collectionModel(true), async (store, host) => {
      const rows = store.collection('rows');
      for (let k = 0; k < 20; k++) await rows.insert({ id: `d${k}`, g: k < 2 ? 'x' : 'y', n: 0.5 + k, i: k });
      const where = { $eq: ['$it.g', 'x'] };
      for (const [document, answer] of [[whole('$sum', 'n', where), 2], [whole('$avg', 'n', where), 1]]) {
        const label = `${host} ${JSON.stringify(document)}`;
        for (const profile of [{ refuseFullScan: true }, { maxRows: 5 }]) {
          const bounded = `${label} ${JSON.stringify(profile)}`;
          assert.equal(await rows.execute(document, { profile }), answer, bounded);
          const items = [];
          for await (const item of rows.query(document, { profile })) items.push(item);
          assert.deepEqual(items, [answer], bounded);
        }
        const explained = await rows.explain(document);
        assert.equal(explained.mode, 'set', label);
        assert.equal(ids(explained)[0], 'plan.floatingAccumulation', label);
        assert.match(explained.sql, / WHERE /, label);
        assert.deepEqual(explained.indexes, ['rows_by_g'], label);
      }
    });
  });
});

/** One member typed `integer`, with or without an index over it.
 * @param {boolean} indexed */
const integerModel = (indexed) => ({ $model: '0.1', collections: { rows: {
  key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, g: { type: 'string' }, i: { type: 'integer' } } },
  indexes: indexed ? [{ name: 'by_i', path: '$.i' }] : [],
} } });
/** @param {number[]} values */
const integerRows = (values) => values.map((i, k) => ({ id: `r${k}`, g: 'x', i }));

describe('an integer sum or average folds as a double beside its guard', () => {
  // a total past 2^53, which Node's SQLite binding cannot hand over as an
  // integer; a group past int64, which SQLite's integer SUM refuses; and an
  // average inside the bound, which PostgreSQL's numeric AVG rounds twice
  const cases = [
    { name: 'a $sum past 2^53', values: [BIG, 2, 3], fn: '$sum', answer: 9007199254740996, fallback: 'accumulation' },
    { name: 'a $sum past int64', values: [2 ** 62, 2 ** 62], fn: '$sum', answer: 9223372036854776000, fallback: 'accumulation' },
    { name: 'an $avg inside the bound', values: [2, 1, 1, 1, 1, 1, 1, 1, 2], fn: '$avg', answer: 1.2222222222222223, fallback: null },
  ];
  for (const indexed of [true, false]) {
    for (const { name, values, fn, answer, fallback } of cases) {
      it(`${name} answers the engine, whole and grouped (${indexed ? 'indexed' : 'unindexed'})`, async () => {
        const documents = integerRows(values);
        await onBothEngines(integerModel(indexed), async (store, host) => {
          const rows = store.collection('rows');
          for (const document of documents) await rows.insert(document);
          for (const [document, expected] of [[whole(fn, 'i'), answer], [grouped(fn, 'i'), { g: 'x', v: answer }]]) {
            const label = `${host} ${JSON.stringify(document)}`;
            assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), expected, `engine: ${label}`);
            assert.deepEqual(await rows.execute(document), expected, label);
            const explained = await rows.explain(document);
            assert.equal(explained.mode, 'native', label);
            assert.equal(explained.fallback?.construct ?? null, fallback, label);
            const items = [];
            for await (const item of rows.query(document)) items.push(item);
            assert.deepEqual(items, [expected], label);
            if (fallback !== null) {
              await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })),
                { code: 'JD0010' }, label);
            }
          }
        });
      });
    }
  }

  it('answers the engine when the double accumulator itself overflows, on every engine', async () => {
    // unindexed: an indexed integer column is an int64 column on SQLite, so
    // a member this large never reaches it. PostgreSQL's double SUM raises
    // past the double range, and its double AVG from terms near that range's
    // square root (the sum of squares it keeps); either way the run is past
    // the exactness bound
    const overflowing = [
      { values: [2 ** 1023, 2 ** 1023], fn: '$sum', answer: Infinity },
      { values: [1e155, 2e155], fn: '$avg', answer: 1.5e155 },
    ];
    for (const { values, fn, answer } of overflowing) {
      const documents = integerRows(values);
      await onBothEngines(integerModel(false), async (store, host) => {
        const rows = store.collection('rows');
        for (const document of documents) await rows.insert(document);
        for (const [document, expected] of [[whole(fn, 'i'), answer], [grouped(fn, 'i'), { g: 'x', v: answer }]]) {
          const label = `${host} ${JSON.stringify(document)}`;
          assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), expected, `engine: ${label}`);
          assert.deepEqual(await rows.execute(document), expected, label);
          const items = [];
          for await (const item of rows.query(document)) items.push(item);
          assert.deepEqual(items, [expected], label);
          assert.deepEqual((await rows.explain(document)).fallback,
            { construct: 'accumulation', runs: 2, reason: 'integer accumulation exceeded its runtime exactness bound' }, label);
          await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })),
            { code: 'JD0010' }, label);
        }
      });
    }
  });
});

/** @param {AsyncIterable<any>} cursor */
async function drained(cursor) {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
}

describe('an integer sum or average past the double range inside a transaction', () => {
  // the statement folds only the terms its exactness guard can admit, so it
  // raises nothing: the engine answers the run and the transaction goes on
  // to commit the body's other writes. Strict mode refuses by code, and the
  // transaction stays usable after the refusal
  const overflowing = [
    { values: [2 ** 1023, 2 ** 1023], fn: '$sum', answer: Infinity },
    { values: [1e155, 2e155], fn: '$avg', answer: 1.5e155 },
  ];
  const model = integerModel(false);
  model.collections.log = { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } } };
  for (const sessions of [1, 2]) {
    it(`answers the engine and commits the body's writes (sessions: ${sessions})`, async () => {
      for (const { values, fn, answer } of overflowing) {
        const documents = integerRows(values);
        await onBothEngines(model, async (store, host) => {
          for (const document of documents) await store.collection('rows').insert(document);
          let written = 0;
          for (const [shape, document, expected] of [['whole', whole(fn, 'i'), answer], ['grouped', grouped(fn, 'i'), { g: 'x', v: answer }]]) {
            assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), expected, `engine: ${fn} ${shape}`);
            for (const read of ['execute', 'cursor']) {
              const label = `${host} sessions ${sessions} ${fn} ${shape} ${read}`;
              const id = `w${++written}`;
              const got = await store.transaction(async (/** @type {any} */ tx) => {
                const rows = tx.collection('rows');
                const value = read === 'execute' ? await rows.execute(document) : await drained(rows.query(document));
                await tx.collection('log').insert({ id });
                return value;
              });
              assert.deepEqual(got, read === 'execute' ? expected : [expected], label);
              assert.deepEqual(await store.collection('log').get(id), { id }, `the write committed: ${label}`);

              const refusedId = `w${++written}`;
              /** @type {any} */
              let refused = null;
              await store.transaction(async (/** @type {any} */ tx) => {
                const rows = tx.collection('rows');
                try {
                  if (read === 'execute') await rows.execute(document, { strict: true });
                  else await drained(rows.query(document, { strict: true }));
                }
                catch (error) {
                  refused = error;
                }
                await tx.collection('log').insert({ id: refusedId });
              });
              assert.equal(refused?.code, 'JD0010', `strict: ${label}`);
              assert.deepEqual(await store.collection('log').get(refusedId), { id: refusedId }, `the write committed: strict ${label}`);
            }
          }
        }, { sessions });
      }
    });
  }
});

describe('an integer sum or average past its bound under a profile', () => {
  const model = { $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, g: { type: 'string' }, i: { type: 'integer' } } },
    indexes: [{ name: 'by_g', path: '$.g' }],
  } } };
  /** Twenty rows, two of them selected, whose sum passes 2^53. */
  const documents = Array.from({ length: 20 }, (_, k) => ({ id: `d${k}`, g: k < 2 ? 'x' : 'y', i: k === 0 ? BIG : 2 + k }));
  const where = { $eq: ['$it.g', 'x'] };

  it('answers from the rows its pushed where selects, so a bounded profile answers it', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      const groupedWhere = { $for: { it: '$[*]' }, $where: where, $groupby: { g: '$it.g' },
        $return: { g: '$g', v: { $sum: '$it.i' } } };
      for (const [document, answer] of [[whole('$sum', 'i', where), 9007199254740994],
        [whole('$avg', 'i', where), 4503599627370497], [groupedWhere, { g: 'x', v: 9007199254740994 }]]) {
        const label = `${host} ${JSON.stringify(document)}`;
        assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), answer, `engine: ${label}`);
        for (const profile of [{ refuseFullScan: true }, { maxRows: 5 }]) {
          const bounded = `${label} ${JSON.stringify(profile)}`;
          assert.deepEqual(await rows.execute(document, { profile }), answer, bounded);
          assert.deepEqual(await drained(rows.query(document, { profile })), [answer], bounded);
          const explained = await rows.explain(document, { profile });
          assert.equal(explained.mode, 'native', bounded);
          assert.equal(explained.fallback?.construct, 'accumulation', bounded);
        }
      }
      // a profile still bounds the rows the selection keeps
      const wide = whole('$sum', 'i', { $ne: ['$it.g', 'z'] });
      await assert.rejects(Promise.resolve().then(() => rows.execute(wide, { profile: { maxRows: 5 } })), { code: 'JD2007' }, host);
    });
  });

  it('declines a cursor under strictStreaming before any statement runs, as its floating twin does', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const fn of ['$sum', '$avg']) {
        const document = whole(fn, 'i', where);
        const label = `${host} ${fn}`;
        assert.throws(() => rows.query(document, { strictStreaming: true }), { code: 'JD0037' }, label);
        const explained = await rows.explain(document);
        assert.equal(explained.mode, 'native', label);
        assert.equal(explained.streaming, 'buffered', label);
        assert.equal(explained.barrier?.construct, fn, label);
        assert.equal(reasonId(explained.barrier.reason), 'bind.accumulationWhole', label);
        const cursor = rows.query(document);
        assert.equal(cursor.streaming, 'buffered', label);
        assert.deepEqual(await drained(cursor), [compileJsonQuery(document)(structuredClone(documents))], label);
      }
      // an extreme or a count never falls back: it streams as it did
      const extreme = whole('$max', 'i', where);
      assert.deepEqual(await drained(rows.query(extreme, { strictStreaming: true })), [BIG], host);
    });
  });
});

describe('an integer sum or average in a native temporal bucket', () => {
  const model = { $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: {
      id: { type: 'string' }, series: { type: 'string' }, on: { type: 'integer' }, reading: { type: 'integer' } } },
    indexes: [{ name: 'by_series_on', path: ['$.series', '$.on'] }],
  } } };
  /** @param {string} series @param {string} fn */
  const bucketed = (series, fn) => ({ $for: { r: '$[*]' },
    $where: { $and: [{ $eq: ['$r.series', series] }, { $ge: ['$r.on', 0] }] },
    $groupby: { b: { '$time-bucket': ['$r.on', 1000, 0] } }, $orderby: ['$b'],
    $return: { at: '$b', total: { [fn]: '$r.reading' } } });
  // past int64, which SQLite's integer SUM refuses; past 2^53, which Node's
  // binding cannot hand over as an integer; an average PostgreSQL's numeric
  // AVG rounds twice; and a sum inside the bound
  const cases = [
    { series: 'int64', values: [2 ** 62, 2 ** 62], fn: '$sum', fallback: 'accumulation' },
    { series: 'past', values: [BIG, 2, 3], fn: '$sum', fallback: 'accumulation' },
    { series: 'mean', values: [2, 1, 1, 1, 1, 1, 1, 1, 2], fn: '$avg', fallback: null },
    { series: 'small', values: [5, 7, 11], fn: '$sum', fallback: null },
  ];
  const documents = cases.flatMap(({ series, values }) =>
    values.map((reading, k) => ({ id: `${series}${k}`, series, on: k, reading })));

  it('answers the engine past its exactness bound, and natively inside it', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const { series, fn, fallback } of cases) {
        const document = bucketed(series, fn);
        const label = `${host} ${series} ${fn}`;
        const answer = compileJsonQuery(document)(structuredClone(documents));
        assert.equal((await rows.explain(document)).mode, 'native', label);
        assert.deepEqual(await rows.execute(document), answer, label);
        assert.deepEqual(await drained(rows.query(document)), Array.isArray(answer) ? answer : [answer], label);
        assert.equal((await rows.explain(document)).fallback?.construct ?? null, fallback, label);
        if (fallback !== null) {
          await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })), { code: 'JD0010' }, label);
        }
      }
    });
  });
});

describe('a floating sum or average in a temporal bucket', () => {
  const model = { $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: {
      id: { type: 'string' }, series: { type: 'string' }, at: { type: 'integer' }, value: { type: 'number' } } },
    indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
  } } };
  // one 1000 ms bucket per series: terms that cancel, terms with no exact
  // binary sum, a total past 2^53 (a JD2003 on Node's SQLite binding) and one
  // past int64 (a JD2005 there)
  const cases = [
    { series: 'cancelling', values: [1e16, 1, -1e16], sum: 0, mean: 0 },
    { series: 'dyadic', values: [0.1, 0.2, 0.3], sum: 0.6000000000000001, mean: 0.20000000000000004 },
    { series: 'past53', values: [BIG, 2], sum: 9007199254740992, mean: 4503599627370496 },
    { series: 'pastInt64', values: [2 ** 62, 2 ** 62], sum: 9223372036854776000, mean: 4611686018427388000 },
  ];
  const documents = cases.flatMap(({ series, values }) =>
    values.map((value, at) => ({ id: `${series}${at}`, series, at, value })));
  /** @param {string} series */
  const source = (series) => ({ $for: { s: '$[*]' },
    $where: { $and: [{ $eq: ['$s.series', series] }, { $ge: ['$s.at', 0] }] } });
  /** @param {string} series @param {string} fn */
  const grouped = (series, fn) => ({ ...source(series),
    $groupby: { b: { '$time-bucket': ['$s.at', 1000, 0] } }, $orderby: ['$b'],
    $return: { at: '$b', v: { [fn]: '$s.value' } } });
  /** @param {string} series @param {string} aggregate */
  const resampled = (series, aggregate) => ({ $resample: [{ ...source(series), $return: '$s' },
    { every: 1000, origin: 0, aggregate }] });

  for (const { series, values, sum, mean } of cases) {
    it(`answers the engine's left-to-right accumulation over ${series} readings, and the fetch still seeks the series index`, async () => {
      const own = documents.filter((document) => document.series === series);
      await onBothEngines(model, async (store, host) => {
        const rows = store.collection('rows');
        for (const document of own) await rows.insert(document);
        for (const [document, answer] of [
          [grouped(series, '$sum'), { at: 0, v: sum }],
          [grouped(series, '$avg'), { at: 0, v: mean }],
          [resampled(series, 'sum'), { at: 0, value: sum, count: values.length }],
          [resampled(series, 'mean'), { at: 0, value: mean, count: values.length }],
        ]) {
          const label = `${host} ${JSON.stringify(document)}`;
          assert.deepEqual(compileJsonQuery(document)(structuredClone(own)), answer, `engine: ${label}`);
          assert.deepEqual(await rows.execute(document), answer, label);
          assert.deepEqual(await drained(rows.query(document)), [answer], label);
          const explained = await rows.explain(document);
          assert.equal(explained.mode, 'set', label);
          assert.equal(ids(explained)[0], 'series.floating-accumulation', label);
          assert.equal(explained.series.reasons[0].code, 'floating-accumulation', label);
          await assert.rejects(Promise.resolve().then(() => rows.execute(document, { strict: true })),
            { code: 'JD0010', message: /floating-accumulation/ }, label);
          // the series equality still bounds the fetch: the index is sought, not scanned
          assert.equal(explained.series.mode, 'hybrid', label);
          assert.equal(explained.series.refinement, 'resampleSeries', label);
          assert.equal(explained.series.index, 'rows_by_series_at', label);
          assert.deepEqual(explained.series.prefix, ['gx_series'], label);
          if (host === 'sqlite') {
            assert.match(explained.scanNarrative, /SEARCH rows USING INDEX rows_by_series_at/, label);
          }
        }
      });
    });
  }

  it('keeps the extremes and the counts native over the same readings', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      // the dyadic and the 2^53 series: the extremes of the others are
      // integer-valued doubles past 2^53, which Node's SQLite binding
      // cannot hand over whatever plan reads them
      for (const [series, min, max, count] of [['dyadic', 0.1, 0.3, 3], ['past53', 2, BIG, 2]]) {
        for (const [document, answer] of [
          [grouped(series, '$min'), { at: 0, v: min }],
          [grouped(series, '$max'), { at: 0, v: max }],
          [resampled(series, 'min'), { at: 0, value: min, count }],
          [resampled(series, 'max'), { at: 0, value: max, count }],
        ]) {
          const label = `${host} ${series} ${JSON.stringify(document)}`;
          assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), answer, `engine: ${label}`);
          assert.deepEqual(await rows.execute(document), answer, label);
          assert.equal((await rows.explain(document)).mode, 'native', label);
        }
      }
      const counted = resampled('dyadic', 'count');
      assert.deepEqual(await rows.execute(counted), { at: 0, value: 3, count: 3 }, host);
      assert.equal((await rows.explain(counted)).mode, 'native', host);
    });
  });
});

describe('a null reading in a temporal bucket', () => {
  // readings 2, null, 4 in one bucket. The engine refuses the null in a
  // grouped aggregate and the temporal kernel skips it
  /** @param {string[]} type */
  const model = (type) => ({ $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: {
      id: { type: 'string' }, series: { type: 'string' }, at: { type: 'integer' }, value: { type } } },
    indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
  } } });
  const documents = [2, null, 4].map((value, at) => ({ id: `r${at}`, series: 's', at, value }));
  const source = { $for: { s: '$[*]' },
    $where: { $and: [{ $eq: ['$s.series', 's'] }, { $ge: ['$s.at', 0] }] } };
  /** @param {string} fn */
  const grouped = (fn) => ({ ...source, $groupby: { b: { '$time-bucket': ['$s.at', 1000, 0] } },
    $orderby: ['$b'], $return: { at: '$b', v: { [fn]: '$s.value' } } });
  /** @param {string} aggregate */
  const resampled = (aggregate) => ({ $resample: [{ ...source, $return: '$s' },
    { every: 1000, origin: 0, aggregate }] });

  it("is the engine's refusal for a floating $sum or $avg, and the kernel's skip for a $resample", async () => {
    await onBothEngines(model(['number', 'null']), async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const fn of ['$sum', '$avg']) {
        const document = grouped(fn);
        const label = `${host} ${fn}`;
        assert.throws(() => compileJsonQuery(document)(structuredClone(documents)), { code: 'JQ2001' }, `engine: ${label}`);
        await assert.rejects(Promise.resolve().then(() => rows.execute(document)), { code: 'JQ2001' }, label);
        assert.equal((await rows.explain(document)).mode, 'set', label);
      }
      for (const [aggregate, value] of [['sum', 6], ['mean', 3]]) {
        const document = resampled(aggregate);
        const label = `${host} ${aggregate}`;
        assert.deepEqual(compileJsonQuery(document)(structuredClone(documents)), { at: 0, value, count: 3 }, `engine: ${label}`);
        assert.deepEqual(await rows.execute(document), { at: 0, value, count: 3 }, label);
        assert.equal((await rows.explain(document)).mode, 'set', label);
      }
    });
  });

  it('is still skipped by a pushed extreme, and by an integer sum or average', async () => {
    for (const [type, fns] of [[['number', 'null'], { $min: 2, $max: 4 }],
      [['integer', 'null'], { $min: 2, $max: 4, $sum: 6, $avg: 3 }]]) {
      await onBothEngines(model(type), async (store, host) => {
        const rows = store.collection('rows');
        for (const document of documents) await rows.insert(document);
        for (const [fn, value] of Object.entries(fns)) {
          const document = grouped(fn);
          const label = `${host} ${type} ${fn}`;
          assert.throws(() => compileJsonQuery(document)(structuredClone(documents)), { code: 'JQ2001' }, `engine: ${label}`);
          assert.equal((await rows.explain(document)).mode, 'native', label);
          assert.deepEqual(await rows.execute(document), { at: 0, v: value }, label);
        }
      });
    }
  });
});

/** What a call answers, or the code it refuses with. @param {() => any} run */
const outcome = async (run) => {
  try {
    return { value: await run() };
  }
  catch (error) {
    return { code: /** @type {any} */ (error).code };
  }
};
/** The items a cursor yields for a result. @param {any} value */
const asItems = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

describe('an aggregate over a member of more than one type', () => {
  // the engine refuses a sequence that mixes numbers and strings (JQ2001),
  // while SQL reads such a member as its FIRST declared type, so the
  // aggregate is the engine's on every engine
  const model = { $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, g: { type: 'string' }, series: { type: 'string' },
      on: { type: 'integer' }, u: { type: ['integer', 'string'] }, z: { type: ['string', 'integer'] },
      w: { type: ['number', 'string'] } } },
    indexes: [{ name: 'by_series_on', path: ['$.series', '$.on'] }],
  } } };
  // both groups hold a number and a string
  const documents = [3, 'x', 12, 'A', 2].map((u, k) => ({ id: `r${k}`, g: 'xxyyx'[k], series: 's', on: k, u, z: u,
    w: typeof u === 'number' ? u + 0.5 : u }));
  /** @param {string} fn @param {string} member */
  const bucketed = (fn, member) => ({ $for: { r: '$[*]' },
    $where: { $and: [{ $eq: ['$r.series', 's'] }, { $ge: ['$r.on', 0] }] },
    $groupby: { b: { '$time-bucket': ['$r.on', 10, 0] } }, $return: { at: '$b', v: { [fn]: `$r.${member}` } } });

  it('stays in the engine over a collection, whole, grouped and bucketed, on every engine', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const member of ['u', 'z', 'w']) {
        for (const fn of ['$sum', '$avg', '$max', '$min']) {
          for (const document of [whole(fn, member), grouped(fn, member), bucketed(fn, member)]) {
            const label = `${host} ${JSON.stringify(document)}`;
            assert.throws(() => compileJsonQuery(document)(structuredClone(documents)), { code: 'JQ2001' }, `engine: ${label}`);
            await assert.rejects(Promise.resolve().then(() => rows.execute(document)), { code: 'JQ2001' }, label);
            await assert.rejects(Promise.resolve().then(() => drained(rows.query(document))), { code: 'JQ2001' },
              `cursor: ${label}`);
            assert.equal((await rows.explain(document)).mode, 'set', label);
          }
        }
      }
    });
  });

  it("stays in the engine over a physical entity's column, whole and grouped, on every engine", async () => {
    /** @param {string | null} schema */
    const modelFor = (schema) => ({ $model: '0.1', entities: { Line: {
      schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' },
        u: { type: ['integer', 'string'] } } },
      physical: { ...(schema === null ? {} : { schema }), table: 'line', columns: {
        id: { name: 'id', codec: 'integer', null: 'reject' }, g: { name: 'g', codec: 'text', null: 'reject' },
        u: { name: 'u', codec: 'text', null: 'reject' } } },
    } } });
    // a text column holds the member's strings, which SQL read as its first type
    const lines = [[1, 'x', 'b'], [2, 'x', 'x'], [3, 'y', 'c'], [4, 'y', 'A']].map(([id, g, u]) => ({ id, g, u }));
    await onBothEnginesPhysical(modelFor,
      (prefix) => `CREATE TABLE ${prefix}line(id INTEGER PRIMARY KEY, g TEXT NOT NULL, u TEXT NOT NULL)`,
      async (store, host) => {
        const set = store.entity('Line');
        for (const line of lines) await set.create(line);
        for (const fn of ['$sum', '$avg', '$max', '$min']) {
          for (const document of [{ [fn]: { $for: { it: '$.Line[*]' }, $return: '$it.u' } },
            { $for: { it: '$.Line[*]' }, $groupby: { g: '$it.g' }, $return: { g: '$g', v: { [fn]: '$it.u' } } }]) {
            const label = `${host} ${JSON.stringify(document)}`;
            const engine = await outcome(() => compileJsonQuery(document)({ Line: structuredClone(lines) }));
            assert.deepEqual(await outcome(() => set.execute(document)), engine, label);
            assert.deepEqual(await outcome(() => drained(set.cursor(document))),
              'code' in engine ? engine : { value: asItems(engine.value) }, `cursor: ${label}`);
            assert.equal((await set.explain(document)).mode, 'set', label);
          }
        }
      });
  });
});

describe('a whole aggregate over a member that admits null', () => {
  // the engine's sequence holds an item for a stored null, which it refuses
  // (`JQ2001`), and none for an absent member; SQL skips both, so such an
  // aggregate is the engine's on every engine
  const model = { $model: '0.1', collections: { rows: {
    key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: ['integer', 'null'] }, s: { type: ['string', 'null'] } } },
  } } };
  const documents = [{ id: 'a', n: 1, s: 'p' }, { id: 'b', n: null, s: null }, { id: 'c', n: 3 }];

  it('stays in the engine, and raises what the engine raises', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const [fn, member] of [['$sum', 'n'], ['$avg', 'n'], ['$min', 'n'], ['$max', 'n'], ['$min', 's'], ['$max', 's']]) {
        const document = whole(fn, member);
        const label = `${host} ${JSON.stringify(document)}`;
        const engine = await outcome(() => compileJsonQuery(document)(structuredClone(documents)));
        assert.deepEqual(engine, { code: 'JQ2001' }, `engine: ${label}`);
        assert.deepEqual(await outcome(() => rows.execute(document)), engine, label);
        assert.equal((await rows.explain(document)).mode, 'set', label);
      }
    });
  });
});

describe("a physical entity's whole integer sum or average", () => {
  it('declines a cursor under strictStreaming before any statement runs, as the collection does', async () => {
    /** @param {string | null} schema */
    const modelFor = (schema) => ({ $model: '0.1', entities: { Line: {
      schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, g: { type: 'string' },
        qty: { type: 'integer' } } },
      physical: { ...(schema === null ? {} : { schema }), table: 'line', columns: {
        id: { name: 'id', codec: 'integer', null: 'reject' }, g: { name: 'g', codec: 'text', null: 'reject' },
        qty: { name: 'qty', codec: 'integer', null: 'reject' } } },
    } } });
    const lines = [BIG, 2, 5, 7].map((qty, k) => ({ id: k + 1, g: 'x', qty }));
    await onBothEnginesPhysical(modelFor,
      (prefix) => `CREATE TABLE ${prefix}line(id INTEGER PRIMARY KEY, g TEXT NOT NULL, qty BIGINT NOT NULL)`,
      async (store, host) => {
        const set = store.entity('Line');
        for (const line of lines) await set.create(line);
        for (const fn of ['$sum', '$avg']) {
          const document = { [fn]: { $for: { it: '$.Line[*]' }, $return: '$it.qty' } };
          const label = `${host} ${fn}`;
          assert.throws(() => set.cursor(document, { strictStreaming: true }), { code: 'JD0037' }, label);
          const explained = await set.explain(document);
          assert.equal(explained.mode, 'native', label);
          assert.equal(explained.streaming, 'buffered', label);
          assert.equal(explained.barrier?.construct, fn, label);
          assert.equal(reasonId(explained.barrier.reason), 'bind.accumulationWhole', label);
          assert.deepEqual(await drained(set.cursor(document)),
            [compileJsonQuery(document)({ Line: structuredClone(lines) })], label);
        }
        // an extreme never falls back, and streams as before
        const extreme = { $max: { $for: { it: '$.Line[*]' }, $return: '$it.qty' } };
        assert.deepEqual(await drained(set.cursor(extreme, { strictStreaming: true })), [BIG], host);
      });
  });
});
