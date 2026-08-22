//@ts-check
/**
 * @file The equivalence proof: every promoted construct runs the SAME
 * document through the pushdown path and the in-memory engine over the
 * same rows and must produce the same answer — including the traps the
 * truth table exists for (missing members, stored nulls, cross-type
 * comparisons, unknown-typed paths, NOT over absence). Then the
 * operational assertions: the named index verified against the
 * database's own plan output, strict-mode `JD0010`, cache counters,
 * bind-time diversion, streaming with early close and a bounded live
 * set, and the absent `estimatedRows`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          age: { type: 'integer' }, active: { type: 'boolean' },
          score: { type: 'number' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }, { name: 'by_name', path: '$.name' }],
    },
  },
};

// missing members, a stored null (under an UNTYPED member), booleans,
// and unicode order bait (astral versus BMP) — the trap corpus
const DATA = [
  { id: 'a', name: 'ada', age: 36, active: true, score: 9.5 },
  { id: 'b', name: 'kid', age: 8, active: false },
  { id: 'c', name: 'lin', age: 64 },
  { id: 'd', name: 'nil', nick: null },
  { id: 'e' },
  { id: 'f', name: '\u{10000}', age: 21 },
  { id: 'g', name: '￿', age: 21 },
];

async function freshStore() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const users = store.collection('users');
  for (const row of DATA) await users.insert(row);
  return { store, users };
}

/** [title, document, externals?] — expected is ALWAYS the engine. */
const CORPUS = /** @type {[string, any, any?][]} */ ([
  ['eq number', { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 21] }, $return: '$it' }],
  ['gt over the index', { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 20] }, $return: '$it' }],
  ['le missing members', { $for: { it: '$[*]' }, $where: { $le: ['$it.age', 100] }, $return: '$it' }],
  ['ne present and missing', { $for: { it: '$[*]' }, $where: { $ne: ['$it.age', 36] }, $return: '$it' }],
  ['not over absence', { $for: { it: '$[*]' }, $where: { $not: { $eq: ['$it.age', 36] } }, $return: '$it' }],
  ['not(not(...))', { $for: { it: '$[*]' }, $where: { $not: { $not: { $exists: '$it.age' } } }, $return: '$it' }],
  ['cross-type eq is false', { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 'x'] }, $return: '$it' }],
  ['cross-type ne is true for present', { $for: { it: '$[*]' }, $where: { $ne: ['$it.name', 7] }, $return: '$it' }],
  ['cross-type ordering is false', { $for: { it: '$[*]' }, $where: { $lt: ['$it.name', 5] }, $return: '$it' }],
  ['eq null on an untyped member', { $for: { it: '$[*]' }, $where: { $eq: ['$it.nick', null] }, $return: '$it' }],
  ['ne null', { $for: { it: '$[*]' }, $where: { $ne: ['$it.nick', null] }, $return: '$it' }],
  ['eq true / eq false', { $for: { it: '$[*]' }, $where: { $or: [{ $eq: ['$it.active', true] }, { $eq: ['$it.active', false] }] }, $return: '$it' }],
  ['ne boolean', { $for: { it: '$[*]' }, $where: { $ne: ['$it.active', true] }, $return: '$it' }],
  ['ordering vs boolean literal (constant false)', { $for: { it: '$[*]' }, $where: { $lt: ['$it.active', true] }, $return: '$it' }],
  ['exists / empty', { $for: { it: '$[*]' }, $where: { $and: [{ $exists: '$it.name' }, { $empty: '$it.score' }] }, $return: '$it' }],
  ['exists over stored null', { $for: { it: '$[*]' }, $where: { $exists: '$it.nick' }, $return: '$it' }],
  ['string eq on an unknown path', { $for: { it: '$[*]' }, $where: { $eq: ['$it.nick', 'x'] }, $return: '$it' }],
  ['flipped literal comparison', { $for: { it: '$[*]' }, $where: { $lt: [21, '$it.age'] }, $return: '$it' }],
  ['string ordering (codepoint = BINARY)', { $for: { it: '$[*]' }, $where: { $gt: ['$it.name', '￿'] }, $return: '$it' }],
  ['starts-with', { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.name', 'a'] }, $return: '$it' }],
  ['contains', { $for: { it: '$[*]' }, $where: { $contains: ['$it.name', 'i'] }, $return: '$it' }],
  ['ends-with', { $for: { it: '$[*]' }, $where: { '$ends-with': ['$it.name', 'n'] }, $return: '$it' }],
  ['or across kinds', { $for: { it: '$[*]' }, $where: { $or: [{ $eq: ['$it.name', 'ada'] }, { $empty: '$it.name' }] }, $return: '$it' }],
  ['orderby asc with empties least', { $for: { it: '$[*]' }, $orderby: ['$it.age'], $return: '$it.id' }],
  ['orderby desc with empties greatest', { $for: { it: '$[*]' }, $orderby: [{ $key: '$it.age', $dir: 'desc', $empty: 'greatest' }], $return: '$it.id' }],
  ['orderby string keys', { $for: { it: '$[*]' }, $orderby: ['$it.name'], $return: '$it.id' }],
  ['multi-key orderby', { $for: { it: '$[*]' }, $orderby: ['$it.age', { $key: '$it.name', $dir: 'desc' }], $return: '$it.id' }],
  ['window skip/take', { $subsequence: [{ $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, 2] }, 0, 3] }],
  ['window to a single item', { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, 6, 1] }],
  ['window past the end', { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, 40, 5] }],
  ['count', { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 20] }, $return: '$it' } }],
  ['count empty', { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 1000] }, $return: '$it' } }],
  ['sum with holes', { $sum: { $for: { it: '$[*]' }, $return: '$it.age' } }],
  ['sum over empty', { $sum: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 1000] }, $return: '$it.age' } }],
  ['avg', { $avg: { $for: { it: '$[*]' }, $return: '$it.age' } }],
  ['avg over empty', { $avg: { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 1000] }, $return: '$it.age' } }],
  ['min number / max string', { $min: { $for: { it: '$[*]' }, $return: '$it.age' } }],
  ['max string (codepoint order)', { $max: { $for: { it: '$[*]' }, $return: '$it.name' } }],
  ['real-typed sum', { $sum: { $for: { it: '$[*]' }, $return: '$it.score' } }],
  ['externals', { $for: { it: '$[*]' }, $where: { $ge: ['$it.age', '$min'] }, $return: '$it.id' }, { min: 21 }],
  ['external string', { $for: { it: '$[*]' }, $where: { $eq: ['$it.name', '$who'] }, $return: '$it.id' }, { who: 'ada' }],
  ['external cross-type at bind', { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', '$who'] }, $return: '$it.id' }, { who: 'ada' }],
  ['row residual: projection', { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 20] }, $orderby: ['$it.id'], $return: { who: '$it.name', at: '$it.age' } }],
  ['row residual: multi-item return', { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'a'] }, $return: ['$it.id', '$it.name'] }],
  ['row residual under a window', { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' }, 1, 3] }],
  ['set residual: $let', { $for: { it: '$[*]' }, $let: { d: { $default: ['$it.age', 0] } }, $where: { $gt: ['$d', 20] }, $return: '$it.id' }],
  ['set residual with narrowing', { $for: { it: '$[*]' }, $where: { $and: [{ $gt: ['$it.age', 20] }, { $match: ['$it.name', '^a'] }] }, $return: '$it.id' }],
  ['single result unwraps', { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'a'] }, $return: '$it.id' }],
  ['empty result is undefined', { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'zz'] }, $return: '$it' }],
]);

describe('the differential equivalence matrix', () => {
  for (const [title, document, externals] of CORPUS) {
    it(title, async () => {
      const { store, users } = await freshStore();
      let expected;
      let expectedError = null;
      try {
        expected = compileJsonQuery(document)(structuredClone(DATA), externals);
      }
      catch (error) {
        expectedError = error;
      }
      if (expectedError !== null) {
        await assert.rejects(
          async () => users.execute(document, { externals }),
          (actualError) => actualError.code === expectedError.code);
      }
      else {
        const actual = await Promise.resolve(users.execute(document, { externals }));
        assert.deepStrictEqual(actual, expected);
      }
      await store.close();
    });
  }
});

describe('operational assertions', () => {
  it('an indexed predicate uses its index — named by explain() and confirmed by the database', async () => {
    const { store, users } = await freshStore();
    const explanation = await users.explain(
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 21] }, $return: '$it' });
    assert.deepStrictEqual(explanation.indexes, ['users_by_age']);
    assert.match(explanation.scanNarrative, /USING INDEX users_by_age/,
      'the database plan output, not a timing guess');
    assert.strictEqual('estimatedRows' in explanation, false,
      'no fabricated numbers: the capability slot is empty on SQLite');
    assert.strictEqual(explanation.residual, null);
    assert.deepStrictEqual(explanation.barriers, []);
    assert.deepStrictEqual(explanation.params, [{ literal: 21 }]);
    await store.close();
  });

  it('a residual is always reported with its reasons; set mode is a barrier', async () => {
    const { store, users } = await freshStore();
    const row = await users.explain(
      { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 20] }, $return: { n: '$it.name' } });
    assert.strictEqual(row.residual.mode, 'row');
    assert.match(row.residual.reasons[0].reason, /row residual/);
    assert.deepStrictEqual(row.barriers, [], 'the row residual streams');

    const set = await users.explain(
      { $for: { it: '$[*]' }, $let: { d: 1 }, $where: { $gt: ['$it.age', 20] }, $return: '$it' });
    assert.strictEqual(set.residual.mode, 'set');
    assert.strictEqual(set.barriers.length > 0, true, 'the set residual is a barrier');
    await store.close();
  });

  it('strict: true is JD0010 naming the forcing construct', async () => {
    const { store, users } = await freshStore();
    await assert.rejects(
      async () => users.execute(
        { $for: { it: '$[*]' }, $return: { n: '$it.name' } }, { strict: true }),
      (error) => {
        assert.strictEqual(error.code, 'JD0010');
        assert.match(error.message, /\$return/);
        return true;
      });
    // the same document without strict runs fine
    const relaxed = await Promise.resolve(users.execute(
      { $for: { it: '$[*]' }, $return: { n: '$it.name' } }));
    assert.strictEqual(Array.isArray(relaxed), true);
    await store.close();
  });

  it('the statement cache counts hits, misses and evictions', async () => {
    const store = await openStore(MODEL,
      { driver: nodeDriver(), statementCacheBound: 2 });
    const users = store.collection('users');
    await users.insert({ id: 'a', name: 'ada', age: 36 });
    const q1 = { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 1] }, $return: '$it' };
    const q2 = { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 2] }, $return: '$it' };
    const q3 = { $for: { it: '$[*]' }, $where: { $eq: ['$it.age', 3] }, $return: '$it' };
    await users.execute(q1);
    await users.execute(q1);
    assert.deepStrictEqual(store.stats().statementCache, { hits: 1, misses: 1, evictions: 0 });
    await users.execute(q2);
    await users.execute(q3); // bound 2: q1 evicts
    assert.deepStrictEqual(store.stats().statementCache, { hits: 1, misses: 3, evictions: 1 });
    await users.execute(q1); // rebuilt
    assert.strictEqual(store.stats().statementCache.misses, 4);
    await store.close();
  });

  it('bind-time diversion: boolean, null and missing externals answer through the engine', async () => {
    const { store, users } = await freshStore();
    const document = { $for: { it: '$[*]' }, $where: { $eq: ['$it.active', '$flag'] }, $return: '$it.id' };
    const viaDb = await Promise.resolve(users.execute(document, { externals: { flag: true } }));
    const viaEngine = compileJsonQuery(document)(structuredClone(DATA), { flag: true });
    assert.deepStrictEqual(viaDb, viaEngine);

    // a MISSING external raises the engine's own error, not a driver's
    let engineCode = null;
    try {
      compileJsonQuery(document)(structuredClone(DATA), {});
    }
    catch (error) {
      engineCode = error.code;
    }
    assert.notStrictEqual(engineCode, null);
    await assert.rejects(async () => users.execute(document, {}),
      (error) => error.code === engineCode);
    await store.close();
  });

  it('the cursor streams, closes early, and agrees with execute', async () => {
    const { store, users } = await freshStore();
    const document = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };
    const streamed = [];
    for await (const item of users.query(document)) streamed.push(item);
    assert.deepStrictEqual(streamed, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    const firstTwo = [];
    for await (const item of users.query(document)) {
      firstTwo.push(item);
      if (firstTwo.length === 2) break; // early close through return()
    }
    assert.deepStrictEqual(firstTwo, ['a', 'b']);

    // row-residual streaming and set-mode (barrier) cursors agree too
    const rowResidual = [];
    for await (const item of users.query(
      { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: { i: '$it.id' } })) {
      rowResidual.push(item);
    }
    assert.strictEqual(rowResidual.length, 7);
    const barrier = [];
    for await (const item of users.query(
      { $for: { it: '$[*]' }, $let: { x: 1 }, $where: { $exists: '$it.name' }, $return: '$it.id' })) {
      barrier.push(item);
    }
    assert.deepStrictEqual(barrier, ['a', 'b', 'c', 'd', 'f', 'g']);

    // an aggregate cursor yields its one item
    const counted = [];
    for await (const item of users.query(
      { $count: { $for: { it: '$[*]' }, $return: '$it' } })) {
      counted.push(item);
    }
    assert.deepStrictEqual(counted, [7]);
    await store.close();
  });

  it('streaming holds the live set flat over a large collection (forced GC, subprocess)', () => {
    const script = `
      import { openStore } from '@jarenjs/db';
      import { nodeDriver } from '@jarenjs/db/node';
      const model = { $model: '0.1', collections: {
        rows: { schema: { type: 'object', properties: { n: { type: 'integer' } } },
          key: null, identity: 'integer' } } };
      const store = await openStore(model, { driver: nodeDriver() });
      const rows = store.sync.collection('rows');
      for (let i = 0; i < 20000; i++) rows.insert({ n: i, pad: 'x'.repeat(128) });
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      let count = 0;
      for await (const item of store.collection('rows').query(
        { $for: { it: '$[*]' }, $where: { $ge: ['$it.n', 0] }, $return: '$it' })) {
        if (item.n >= 0) count++;
      }
      globalThis.gc();
      const after = process.memoryUsage().heapUsed;
      console.log(JSON.stringify({ count, growthMb: (after - before) / 1048576 }));
      await store.close();
    `;
    const out = execFileSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: process.cwd() });
    const { count, growthMb } = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(count, 20000, 'every row streamed through');
    assert.strictEqual(growthMb < 8, true,
      `live set grew ${growthMb.toFixed(2)} MB — the cursor must not materialize`);
  });
});

/**
 * Rewrite a query document's collection binding to `name`: the `$for`
 * key and every path string rooted at the old variable. Externals
 * (`$who`) and absolute paths (`$.x`) are untouched — only a path whose
 * root variable is the binding moves.
 * @param {any} node
 * @param {string} from
 * @param {string} to
 * @returns {any}
 */
function rebind(node, from, to) {
  if (typeof node === 'string') {
    if (node === `$${from}`) return `$${to}`;
    return node.startsWith(`$${from}.`) || node.startsWith(`$${from}[`)
      ? `$${to}${node.slice(from.length + 1)}`
      : node;
  }
  if (Array.isArray(node)) return node.map((n) => rebind(n, from, to));
  if (node === null || typeof node !== 'object') return node;
  /** @type {any} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$for' && Object.prototype.hasOwnProperty.call(value, from)) {
      out.$for = { [to]: rebind(/** @type {any} */ (value)[from], from, to) };
      continue;
    }
    out[key] = rebind(value, from, to);
  }
  return out;
}

// The binding name is the document's choice, not the engine's and not
// this package's. Every shape above is re-run under names the suite's
// own examples never use, because that is exactly how a hard-coded
// wrapper survives: `@jarenjs/linq` always emits `it`, and so does every
// README, test and format-document example.
describe('the collection binding name is the document\'s to choose', () => {
  for (const name of ['p', 'row', 'user']) {
    for (const [title, document, externals] of CORPUS) {
      it(`${title} — bound as '${name}'`, async () => {
        const rebound = rebind(document, 'it', name);
        assert.notDeepStrictEqual(rebound, document, 'the rewrite must change the document');
        const { store, users } = await freshStore();
        let expected;
        let expectedError = null;
        try {
          expected = compileJsonQuery(rebound)(structuredClone(DATA), externals);
        }
        catch (error) {
          expectedError = error;
        }
        if (expectedError !== null) {
          await assert.rejects(
            async () => users.execute(rebound, { externals }),
            (actualError) => actualError.code === expectedError.code);
        }
        else {
          const actual = await Promise.resolve(users.execute(rebound, { externals }));
          assert.deepStrictEqual(actual, expected);
        }
        await store.close();
      });
    }
  }
});
