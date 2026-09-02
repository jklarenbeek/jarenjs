//@ts-check
/**
 * @file `explain().series.counts` after every path — a row projection,
 * a native aggregate, a cursor — and `series.mode` derived from the plan
 * mode rather than from the index alone. Each of the three
 * reproductions that used to leave `counts` null and
 * `stats().series.queries` unchanged is a passing test: the counts are
 * the last actual run's, a cursor counts as it is drained and is final
 * when it settles (and says `partial` while it is not), and an
 * aggregate's `candidates` stays `null` rather than estimated.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    samples: {
      schema: { type: 'object', properties: {
        series: { type: 'string' }, at: { type: 'integer' }, value: { type: ['number', 'null'] } } },
      key: null,
      identity: 'integer',
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
  },
};

async function fresh() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const samples = store.collection('samples');
  for (let i = 0; i < 20; i++) {
    await samples.insert({ series: i % 2 === 0 ? 'a' : 'b', at: i * 1000, value: i });
  }
  return { store, samples };
}

const RANGE = {
  $for: { s: '$[*]' },
  $where: { $and: [{ $eq: ['$s.series', 'a'] }, { $ge: ['$s.at', 4000] }, { $lt: ['$s.at', 12000] }] },
  $return: '$s.value',
};

describe('explain().series.counts after every path', () => {
  it('a row run fills the counts and advances the store', async () => {
    const { store, samples } = await fresh();
    const before = await samples.explain(RANGE);
    assert.strictEqual(before.mode, 'native', 'the one-path projection is pushed');
    assert.strictEqual(before.series.mode, 'native', 'the selection seeks through the index');
    assert.strictEqual(before.series.counts, null);
    const answer = await Promise.resolve(samples.execute(RANGE));
    assert.deepStrictEqual(answer, [4, 6, 8, 10]);
    const after = await samples.explain(RANGE);
    assert.deepStrictEqual(after.series.counts, { statements: 1, candidates: 4, results: 4, partial: false });
    assert.strictEqual(samples.stats().series.queries, 1);
    await store.close();
  });

  it('an aggregate run counts its one result, and leaves candidates honestly null', async () => {
    const { store, samples } = await fresh();
    const counted = { $count: { $for: { s: '$[*]' }, $where: RANGE.$where, $return: '$s' } };
    assert.strictEqual((await samples.explain(counted)).series.counts, null);
    assert.strictEqual(await Promise.resolve(samples.execute(counted)), 4);
    const after = await samples.explain(counted);
    assert.deepStrictEqual(after.series.counts, { statements: 1, candidates: null, results: 1, partial: false });
    assert.deepStrictEqual(samples.stats().series, { queries: 1, statements: 1, candidates: 0, results: 1, diverted: 0 });
    await store.close();
  });

  it('a cursor run counts as it is drained, says so mid-iteration, and is final when it settles', async () => {
    const { store, samples } = await fresh();
    const partial = [];
    for await (const value of samples.query(RANGE)) {
      partial.push(value);
      if (partial.length === 2) {
        const midway = await samples.explain(RANGE);
        assert.deepStrictEqual(midway.series.counts, { statements: 1, candidates: 2, results: 2, partial: true });
        assert.strictEqual(samples.stats().series.queries, 0, 'not a run until it settles');
        break;
      }
    }
    const settled = await samples.explain(RANGE);
    assert.deepStrictEqual(settled.series.counts, { statements: 1, candidates: 2, results: 2, partial: false });
    assert.strictEqual(samples.stats().series.queries, 1);
    const all = [];
    for await (const value of samples.query(RANGE)) all.push(value);
    assert.deepStrictEqual(all, [4, 6, 8, 10]);
    assert.deepStrictEqual((await samples.explain(RANGE)).series.counts,
      { statements: 1, candidates: 4, results: 4, partial: false });
    assert.strictEqual(samples.stats().series.queries, 2);
    // a cursor never pulled is not a run
    await samples.query(RANGE).return();
    assert.strictEqual(samples.stats().series.queries, 2);
    await store.close();
  });
});

describe('series.mode follows the plan mode', () => {
  it('a selection the engine finishes is hybrid through the index and engine without it, never native', async () => {
    const { store, samples } = await fresh();
    // an ordering over a path that admits null is a named residual
    // (MODEL-FORMAT §10.6): the where still narrows, the engine answers
    const residual = { ...RANGE, $orderby: ['$s.value'] };
    const explained = await samples.explain(residual);
    assert.strictEqual(explained.mode, 'set');
    assert.strictEqual(explained.series.mode, 'hybrid', 'the index narrows the fetch; the engine answers');
    assert.strictEqual(explained.series.index, 'samples_by_series_at');
    const forced = await samples.explain(RANGE, { pushdown: false });
    assert.strictEqual(forced.mode, 'set');
    assert.strictEqual(forced.series.mode, 'engine', 'the harness switch reads the whole collection');
    assert.strictEqual(forced.series.index, null);
    const unindexed = { ...residual, $where: { $and: [{ $ge: ['$s.at', 4000] }, { $lt: ['$s.at', 12000] }] } };
    const nothing = await samples.explain(unindexed);
    assert.strictEqual(nothing.mode, 'set');
    assert.strictEqual(nothing.series.mode, 'engine', 'no index seeks: nothing narrowed');
    await store.close();
  });
});
