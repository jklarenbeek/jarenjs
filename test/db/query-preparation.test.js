//@ts-check
/** Failed preparation releases every cached read family for a caller's retry. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { wasmDriver } from '@jarenjs/db/wasm';
import { compileJsonQuery } from '@jarenjs/json/query';

const rows = [
  { id: 'a', n: 1, series: 's', at: 1, value: 10, embedding: [1, 0, 0] },
  { id: 'b', n: 2, series: 's', at: 2, value: 20, embedding: [0, 1, 0] },
];
const entities = [{ id: 1, n: 1 }, { id: 2, n: 2 }];
const model = { $model: '0.1', collections: { notes: {
  key: '/id', schema: { type: 'object', properties: {
    id: { type: 'string' }, n: { type: 'integer' }, series: { type: 'string' },
    at: { type: 'integer' }, value: { type: 'number' },
    embedding: { type: 'array', items: { type: 'number' } },
  } }, indexes: [{ name: 'by_n', path: '$.n' },
    { name: 'by_series_at', path: ['$.series', '$.at'] },
    { name: 'by_vector', path: '$.embedding', derive: 'vector', dims: 3 }],
} }, entities: { Thing: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' },
}, required: ['id', 'n'] } } } };
const collectionQuery = [{ $for: { it: '$[*]' }, $return: '$it.n' }];
const divertedQuery = [{ $for: { it: '$[*]' }, $where: { $eq: ['$it.n', '$probe'] }, $return: '$it.n' }];
const entityQuery = [{ $for: { it: '$.Thing[*]' }, $return: '$it.n' }];
const ranked = { $subsequence: [{ $for: { it: '$[*]' },
  $orderby: [{ $key: { $similarity: ['$it.embedding', '$probe'] }, $dir: 'desc', $empty: 'least' }, '$it.id'],
  $return: '$it.id' }, 0, 1] };
const asof = { $asof: [{ $const: [{ at: 1, value: 0, series: 's' }] }, '$[*]', { by: '$.series' }] };
const collectionRead = (text) => /^SELECT\b/.test(text) && text.includes('"notes"');
const entityRead = (text) => /^SELECT\b/.test(text) && text.includes('"Thing"');
const oracle = (document, input, externals) => compileJsonQuery(document)(input, externals);
const cases = [
  { name: 'collection native', matches: collectionRead, expected: [1, 2],
    call: (over) => over.collection('notes').execute(collectionQuery) },
  { name: 'collection full-scan diversion', matches: collectionRead,
    expected: oracle(divertedQuery, rows, { probe: true }),
    call: (over) => over.collection('notes').execute(divertedQuery, { externals: { probe: true } }) },
  { name: 'vector-width alternative', matches: (text) => collectionRead(text) && text.includes('gx_embedding_v3'),
    expected: oracle(ranked, rows, { probe: [1, 0, 0] }),
    call: (over) => over.collection('notes').execute(ranked, { externals: { probe: [1, 0, 0] } }) },
  { name: 'ranked identity fetch', matches: (text) => collectionRead(text) && /\bIN\s*\(/.test(text),
    expected: oracle(ranked, rows, { probe: [1, 0, 0] }),
    call: (over) => over.collection('notes').execute(ranked, { externals: { probe: [1, 0, 0] } }) },
  { name: 'temporal seek anchor', matches: (text) => collectionRead(text) && /\b(?:MIN|MAX)\(/.test(text),
    expected: oracle(asof, rows), call: (over) => over.collection('notes').execute(asof) },
  { name: 'entity native', matches: entityRead, expected: [1, 2],
    call: (over) => over.execute(entityQuery) },
  { name: 'entity residual fetch', matches: entityRead, expected: [1, 2],
    call: (over) => over.execute(entityQuery, { pushdown: false }) },
  { name: 'entity count cursor', matches: entityRead, expected: [2], cursor: true,
    call: (over) => over.entity('Thing').cursor({ $count: '$.Thing[*]' }) },
  { name: 'graph load', matches: entityRead, expected: entities,
    call: (over) => over.entity('Thing').load({ orderBy: '$it.id' }) },
];

async function fixture(asynchronous, matches) {
  const native = process.versions.bun ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  const database = new native(':memory:');
  const failure = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errcode: 5 });
  let armed = false;
  let prepares = 0;
  const raw = {
    exec: (text) => database.exec(text), close: () => database.close(),
    prepare(text) {
      if (armed && matches(text) && ++prepares === 1) {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      }
      const statement = database.prepare(text);
      const wrapped = {
        run: (params = []) => statement.run(...params),
        get: (params = []) => statement.get(...params) ?? undefined,
        all: (params = []) => statement.all(...params),
        iterate: (params = []) => statement.iterate(...params),
      };
      return asynchronous ? Promise.resolve(wrapped) : wrapped;
    },
  };
  const store = await openStore(model, { driver: wasmDriver({ synchronous: !asynchronous, open: () => raw }) });
  for (const row of rows) await store.collection('notes').insert(row);
  for (const row of entities) await store.entity('Thing').create(row);
  armed = true;
  return { store, failure, prepares: () => prepares };
}

const collect = async (cursor) => {
  const values = [];
  for await (const value of cursor) values.push(value);
  return values;
};

for (const scenario of cases) for (const asynchronous of [false, true])
  it(`${scenario.name} retries refused preparation and reuses success (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const { store, failure, prepares } = await fixture(asynchronous, scenario.matches);
    const invoke = () => {
      const result = scenario.call(asynchronous ? store : store.sync);
      return scenario.cursor ? asynchronous ? collect(result) : [...result] : result;
    };
    try {
      const classified = (error) => error.code === 'JD2005' && error.class === 'busy' && error.cause === failure;
      if (asynchronous) await assert.rejects(invoke(), classified);
      else assert.throws(invoke, classified);
      assert.equal(prepares(), 1, 'no automatic retry occurs');
      const recovered = invoke();
      if (!asynchronous) assert.equal(recovered?.then, undefined, 'synchronous reads stay synchronous');
      assert.deepEqual(await recovered, scenario.expected);
      assert.equal(prepares(), 2, 'the refused preparation is replaced');
      assert.deepEqual(await invoke(), scenario.expected);
      assert.equal(prepares(), 2, 'the recovered statement is reused');
    }
    finally { await store.close(); }
  });
