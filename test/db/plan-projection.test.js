//@ts-check
/**
 * @file Single-path projection pushdown: a FLWOR whose `$return` is ONE
 * member path over the binding projects that path into the statement —
 * its value beside its JSON type — and `$count` over it emits a
 * `COUNT(*)` with the member's presence in the WHERE. The answers equal
 * the engine's for every value kind (present, null, absent, boolean,
 * number, string, object, array, nested), and — the assertion that
 * matters most — a query whose residual still needs another member is
 * NOT projected and answers correctly. The oracle corpus and its
 * forced-residual mode are the regression net (`oracle.test.js`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, n: { type: ['number', 'null'] }, s: { type: 'string' },
        b: { type: 'boolean' }, o: { type: 'object', properties: { k: { type: 'integer' } } },
        tags: { type: 'array', items: { type: 'string' } } } },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};
const DATA = [
  { id: 'a', n: 1, s: 'one', b: true, o: { k: 1 }, tags: ['x', 'y'] },
  { id: 'b', n: null, s: 'two', b: false, o: { k: 2 }, tags: [] },
  { id: 'c', s: 'three', o: {} },
  { id: 'd', n: 4, s: 'four', b: true, o: { k: 4 }, tags: ['z'] },
  { id: 'e', n: 5.5, s: 'five' },
];

async function fresh() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const rows = store.collection('rows');
  for (const row of DATA) await rows.insert(row);
  return { store, rows };
}

const engine = (document, externals = {}) => compileJsonQuery(document)(structuredClone(DATA), externals);
const ordered = (ret, extra = {}) => ({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: ret, ...extra });

describe('a single member path projects into the statement', () => {
  it('the statement selects the path and its type, never the whole document, and answers what the engine answers', async () => {
    const { store, rows } = await fresh();
    for (const path of ['$it.n', '$it.s', '$it.b', '$it.o', '$it.tags', '$it.o.k', '$it.missing']) {
      const document = ordered(path);
      const explained = await rows.explain(document);
      assert.strictEqual(explained.mode, 'native', path);
      assert.deepStrictEqual(explained.projection, { path: path.slice(4).split('.') }, path);
      assert.match(explained.sql, /END AS "v", json_type\("doc", '\$\..*'\) AS "t"/);
      assert.doesNotMatch(explained.sql, /AS "doc"/, `${path}: the whole document is not read`);
      const answer = await Promise.resolve(rows.execute(document));
      assert.deepStrictEqual(answer, engine(document), path);
      const streamed = [];
      for await (const item of rows.query(document)) streamed.push(item);
      const expected = engine(document);
      assert.deepStrictEqual(streamed, expected === undefined ? [] : Array.isArray(expected) ? expected : [expected], `${path} via the cursor`);
    }
    // a present null, an absent member and the booleans are told apart
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.n'))), [1, null, 4, 5.5]);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.b'))), [true, false, true]);
    // a window over the projection, and the chain's element window
    const windowed = { $subsequence: [ordered('$it.s'), 1, 2] };
    assert.deepStrictEqual(await Promise.resolve(rows.execute(windowed)), engine(windowed));
    assert.strictEqual((await rows.explain(windowed)).mode, 'native');
    assert.deepStrictEqual(await Promise.resolve(rows.execute([ordered('$it.n')])), [1, null, 4, 5.5],
      'the element window answers its items as one array');
    // strict mode no longer meets a residual here
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.s'), { strict: true })), engine(ordered('$it.s')));
    await store.close();
  });

  it('$count over a projected path is a COUNT(*) over the rows where the member is present', async () => {
    const { store, rows } = await fresh();
    const counted = { $count: { $for: { it: '$[*]' }, $return: '$it.n' } };
    const explained = await rows.explain(counted);
    assert.strictEqual(explained.mode, 'native');
    assert.match(explained.sql, /SELECT COUNT\(\*\) AS "value" FROM "rows" WHERE json_type\("doc", '\$\."n"'\) IS NOT NULL/);
    assert.strictEqual(await Promise.resolve(rows.execute(counted)), 4, 'a present null counts, an absent member does not');
    assert.strictEqual(await Promise.resolve(rows.execute(counted)), engine(counted));
    const filtered = { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 1] }, $return: '$it.s' } };
    assert.strictEqual(await Promise.resolve(rows.execute(filtered)), engine(filtered));
    assert.match((await rows.explain(filtered)).sql, /COUNT\(\*\)/);
    await store.close();
  });
});

describe('a projection never drops a member a residual needs', () => {
  it('a query whose residual conjunct needs another member is not projected, and answers correctly', async () => {
    const { store, rows } = await fresh();
    // a `$let` the planner does not translate makes the whole selection
    // residual: the engine needs `n` to decide, so the whole document
    // is read and `s` is projected by the engine, never by the statement
    const needsN = { $for: { it: '$[*]' }, $let: { k: 1 }, $where: { $gt: ['$it.n', '$k'] }, $orderby: ['$it.id'], $return: '$it.s' };
    const explained = await rows.explain(needsN);
    assert.strictEqual(explained.mode, 'set');
    assert.strictEqual(explained.projection, null);
    assert.match(explained.sql, /AS "doc"/, 'the whole document is read');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(needsN)), engine(needsN));
    assert.deepStrictEqual(await Promise.resolve(rows.execute(needsN)), ['four', 'five']);
    // a conjunct the UDF hatch could have pushed stays with the whole
    // document under a profile (no registration under a profile), and
    // still answers what the engine answers
    const computed = { $for: { it: '$[*]' }, $where: { $eq: [{ $upper: '$it.s' }, 'FOUR'] }, $orderby: ['$it.id'], $return: '$it.s' };
    const profiled = await rows.explain(computed, { profile: { maxRows: 100 } });
    assert.notStrictEqual(profiled.mode, 'native');
    assert.strictEqual(profiled.projection, null);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(computed, { profile: { maxRows: 100 } })), engine(computed));
    assert.deepStrictEqual(await Promise.resolve(rows.execute(computed, { profile: { maxRows: 100 } })), 'four');
    // an object projection is never pushed: it runs per row over the whole document
    const object = ordered({ who: '$it.id', num: '$it.n' });
    assert.strictEqual((await rows.explain(object)).mode, 'row');
    assert.strictEqual((await rows.explain(object)).projection, null);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(object)), engine(object));
    await store.close();
  });

  it('the forced-residual mode agrees with the pushed mode on every projected case', async () => {
    const { store, rows } = await fresh();
    for (const document of [
      ordered('$it.n'), ordered('$it.o.k'), ordered('$it.tags'), ordered('$it.b'),
      { $count: { $for: { it: '$[*]' }, $return: '$it.n' } },
      { $subsequence: [ordered('$it.s'), 1, 2] },
      ordered('$it.n', { $where: { $exists: '$it.b' } }),
    ]) {
      const pushed = await Promise.resolve(rows.execute(document));
      const forced = await Promise.resolve(rows.execute(document, { pushdown: false }));
      assert.deepStrictEqual(pushed, forced, JSON.stringify(document));
      assert.deepStrictEqual(pushed, engine(document), JSON.stringify(document));
    }
    await store.close();
  });
});
