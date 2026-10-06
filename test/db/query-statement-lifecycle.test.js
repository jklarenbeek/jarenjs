//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openStore, createQueryState, createQueryEngine, createEntityQueryEngine, createLoadEngine,
  normalizeModel, normalizeEntities, explainMapping, planCollection,
} from '@jarenjs/db';
import { wasmDriver } from '@jarenjs/db/wasm';
import { compileJsonQuery } from '@jarenjs/json/query';

const rows = [
  { id: 'a', n: 1, series: 's', at: 1, value: 10, embedding: [1, 0, 0] },
  { id: 'b', n: 2, series: 's', at: 3, value: 20, embedding: [1, 0, 0, 0] },
];
const entityRows = [{ id: 1, n: 1 }, { id: 2, n: 2 }];
const entitySchema = { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' },
}, required: ['id', 'n'] };
const model = { $model: '0.1', collections: { notes: {
  key: '/id', schema: { type: 'object', properties: {
    id: { type: 'string' }, n: { type: 'integer' }, series: { type: 'string' },
    at: { type: 'integer' }, value: { type: 'number' },
    embedding: { type: 'array', items: { type: 'number' } },
  } }, indexes: [{ name: 'by_n', path: '$.n' },
    { name: 'by_series_at', path: ['$.series', '$.at'] },
    ...[3, 4].map((dims) => ({ name: `by_vector${dims}`, path: '$.embedding', derive: 'vector', dims }))],
} }, entities: { Thing: { schema: entitySchema }, Other: { schema: entitySchema } } };
const nativeQuery = { $for: { it: '$[*]' }, $where: { $eq: ['$it.n', '$probe'] }, $return: '$it' };
const entityQuery = { $for: { it: '$.Thing[*]' }, $return: '$it' };
const multiRoot = { things: ['$.Thing[*]'], others: ['$.Other[*]'] };
const nearest = { $asof: [{ $const: [{ at: 2, value: 0, series: 's' }] }, '$[*]',
  { by: '$.series', direction: 'nearest' }] };
const ranked = { $subsequence: [{ $for: { it: '$[*]' },
  $orderby: [{ $key: { $similarity: ['$it.embedding', '$probe'] }, $dir: 'desc', $empty: 'least' }, '$it.id'],
  $return: '$it.id' }, 0, 1] };
const sum = { $sum: { $for: { it: '$[*]' }, $return: '$it.n' } };
const oracle = (doc, input = rows, externals = {}) => compileJsonQuery(doc)(input, externals);
const atBoundary = (held, answer) => Promise.race([held.started.promise,
  Promise.resolve(answer).then(() => assert.fail(`the read completed before the held ${held.kind} boundary`))]);

/** A real SQL binding with observable lifetimes and controllable I/O boundaries. */
async function fixture(asynchronous = false) {
  const Native = process.versions.bun ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  const database = new Native(':memory:');
  const records = [];
  let armed = false, blocking = null, connection;
  const run = (kind, record, action) => {
    const perform = () => {
      assert.equal(record.finalized, 0, `${kind} used a finalized statement: ${record.sql}`);
      return action();
    };
    if (blocking?.kind === kind && blocking.matches(record.sql)) {
      const held = blocking;
      blocking = null;
      held.started.resolve(record);
      return held.release.promise.then(perform);
    }
    const value = perform();
    return asynchronous ? Promise.resolve(value) : value;
  };
  const raw = {
    exec: (sql) => database.exec(sql), close: () => database.close(),
    prepare(sql) {
      const native = database.prepare(sql);
      const record = { sql, finalized: 0 };
      if (armed) records.push(record);
      const statement = {
        run: (params = []) => run('run', record, () => native.run(...params)),
        get: (params = []) => run('get', record, () => native.get(...params) ?? undefined),
        all: (params = []) => run('all', record, () => native.all(...params)),
        iterate: (params = []) => run('iterate', record, () => native.iterate(...params)),
        finalize() {
          assert.equal(record.finalized, 0, 'one prepared handle is finalized once');
          record.finalized++;
          native.finalize?.();
        },
      };
      return run('prepare', record, () => statement);
    },
  };
  const base = wasmDriver({ synchronous: !asynchronous, open: () => raw });
  const store = await openStore(model, { statementCacheBound: 1, driver: { ...base,
    open: async (...args) => (connection = await base.open(...args)),
  } });
  for (const row of rows) await store.collection('notes').insert(row);
  for (const name of ['Thing', 'Other']) for (const row of entityRows) await store.entity(name).create(row);
  const state = createQueryState(1);
  const collection = normalizeModel(model).get('notes');
  const context = { connection, state, entities: normalizeEntities(model), mapping: explainMapping(model) };
  const notes = createQueryEngine({ connection, state, collection,
    physicalPlan: planCollection('notes', collection, connection.dialect) });
  const entities = createEntityQueryEngine(context);
  const load = createLoadEngine(context, 'Thing');
  armed = true;
  return {
    store, state, records, notes, entities, load,
    evict: () => notes.query({ $const: 'a replacement plan that opens no statement' }).return(),
    hold(kind, matches = () => true) {
      assert.equal(blocking, null);
      blocking = { kind, matches, started: Promise.withResolvers(), release: Promise.withResolvers() };
      return blocking;
    },
  };
}

const cases = [
  { name: 'collection main', count: 1, call: (f) => f.notes.execute(nativeQuery, { externals: { probe: 1 } }),
    expected: oracle(nativeQuery, rows, { probe: 1 }) },
  { name: 'collection main and diversion', count: 2, async call(f) {
    await f.notes.execute(nativeQuery, { externals: { probe: 1 } });
    return f.notes.execute(nativeQuery, { externals: { probe: null } });
  }, expected: oracle(nativeQuery, rows, { probe: null }) },
  { name: 'temporal main and both seeks', count: 3, call: (f) => f.notes.execute(nearest), expected: oracle(nearest) },
  { name: 'entity main', count: 1, call: (f) => f.entities.execute(entityQuery),
    expected: oracle(entityQuery, { Thing: entityRows }) },
  { name: 'entity root fetchers', count: 2, call: (f) => f.entities.execute(multiRoot, { pushdown: false }),
    expected: oracle(multiRoot, { Thing: entityRows, Other: entityRows }) },
  { name: 'graph load', count: 1, call: (f) => f.load.load({ orderBy: '$it.id' }), expected: entityRows },
];

for (const scenario of cases) for (const asynchronous of [false, true])
  it(`${scenario.name} releases its prepared children on eviction (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const f = await fixture(asynchronous);
    try {
      assert.deepEqual(await scenario.call(f), scenario.expected);
      assert.equal(f.records.length, scenario.count);
      assert.ok(f.records.every((record) => record.finalized === 0));
      await f.evict();
      assert.ok(f.records.every((record) => record.finalized === 1));
      assert.equal(f.state.counters.evictions, 1);
    }
    finally { await f.store.close(); }
  });

for (const asynchronous of [false, true])
  it(`vector alternatives retire together while the bounded identity fetch remains reusable (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const f = await fixture(asynchronous);
    try {
      for (const probe of [[1, 0, 0], [1, 0, 0, 0]])
        assert.deepEqual(await f.notes.execute(ranked, { externals: { probe } }), oracle(ranked, rows, { probe }));
      const alternatives = f.records.filter((r) => / AS "vec"/.test(r.sql));
      const identity = f.records.filter((r) => /\bIN\s*\(/.test(r.sql));
      assert.equal(alternatives.length, 2);
      assert.equal(identity.length, 1);
      await f.evict();
      assert.ok(alternatives.every((r) => r.finalized === 1));
      assert.equal(identity[0].finalized, 0);
      await f.notes.execute(ranked, { externals: { probe: [1, 0, 0] } });
      assert.equal(f.records.filter((r) => /\bIN\s*\(/.test(r.sql)).length, 1);
    }
    finally { await f.store.close(); }
  });

for (const [name, call, expected, kind] of [
  ['collection prepare', (f) => f.notes.execute(nativeQuery, { externals: { probe: 1 } }), rows[0], 'prepare'],
  ['collection all', (f) => f.notes.execute(nativeQuery, { externals: { probe: 1 } }), rows[0], 'all'],
  ['entity prepare', (f) => f.entities.execute(entityQuery), entityRows, 'prepare'],
  ['entity all', (f) => f.entities.execute(entityQuery), entityRows, 'all'],
  ['entity get', (f) => f.entities.execute({ $count: entityQuery }), 2, 'get'],
  ['load prepare', (f) => f.load.load({ orderBy: '$it.id' }), entityRows, 'prepare'],
  ['load all', (f) => f.load.load({ orderBy: '$it.id' }), entityRows, 'all'],
]) it(`eviction waits for admitted ${name}`, { timeout: 5000 }, async () => {
  const f = await fixture(true);
  try {
    const held = f.hold(kind);
    const answer = call(f);
    const record = await atBoundary(held, answer);
    await f.evict();
    assert.equal(record.finalized, 0);
    held.release.resolve();
    assert.deepEqual(await answer, expected);
    assert.equal(record.finalized, 1);
  }
  finally { await f.store.close(); }
});

for (const [name, document, options, kind, count, input] of [
  ['second temporal seek', nearest, undefined, 'get', 3, rows],
  ['second entity root', multiRoot, { pushdown: false }, 'all', 2, { Thing: entityRows, Other: entityRows }],
]) it(`${name} prepared after its plan retires is temporary`, { timeout: 5000 }, async () => {
  const f = await fixture(true);
  try {
    const held = f.hold(kind);
    const answer = name === 'second entity root' ? f.entities.execute(document, options) : f.notes.execute(document, options);
    await atBoundary(held, answer);
    const original = [...f.records];
    await f.evict();
    assert.ok(original.every((record) => record.finalized === 0));
    held.release.resolve();
    assert.deepEqual(await answer, oracle(document, input));
    assert.equal(f.records.length, count);
    assert.ok(f.records.every((record) => record.finalized === 1));
  }
  finally { await f.store.close(); }
});

it('an overflow diversion first prepared after eviction is released with the admitted call', { timeout: 5000 }, async () => {
  const f = await fixture(true);
  try {
    const held = f.hold('get');
    const answer = f.notes.execute(sum);
    const main = await atBoundary(held, answer);
    await f.evict();
    assert.equal(main.finalized, 0);
    held.release.reject(Object.assign(new Error('integer overflow'), { code: 'SQLITE_ERROR', errcode: 1 }));
    assert.equal(await answer, oracle(sum));
    assert.equal(f.records.length, 2);
    assert.ok(f.records.every((record) => record.finalized === 1));
  }
  finally { await f.store.close(); }
});

for (const asynchronous of [false, true])
  it(`a valid uncacheable document releases every transient preparation (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const f = await fixture(asynchronous);
    const value = () => 'opaque constant';
    const doc = { $for: { it: '$[*]' }, $return: { $const: value } };
    try {
      for (let i = 0; i < 3; i++) {
        const answer = f.notes.execute(doc);
        if (!asynchronous) assert.equal(answer?.then, undefined);
        assert.deepEqual(await answer, [value, value]);
      }
      assert.equal(f.state.cache.size(), 0);
      assert.deepEqual(f.state.counters, { hits: 0, misses: 3, evictions: 0 });
      assert.equal(f.records.length, 3);
      assert.ok(f.records.every((record) => record.finalized === 1));
    }
    finally { await f.store.close(); }
  });

it('a materializing cursor created before eviction prepares only when pulled and releases its temporary read', async () => {
  const f = await fixture(true);
  try {
    const cursor = f.notes.query(sum);
    assert.equal(f.records.length, 0);
    await f.evict();
    assert.deepEqual(await cursor.next(), { done: false, value: oracle(sum) });
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].finalized, 1);
    await cursor.return();
  }
  finally { await f.store.close(); }
});

it('cancellation during an evicted cursor read waits for its statement borrow to settle', { timeout: 5000 }, async () => {
  const f = await fixture(true);
  const controller = new AbortController();
  try {
    const held = f.hold('get');
    const cursor = f.notes.query(sum, { signal: controller.signal });
    const pulling = cursor.next();
    const record = await atBoundary(held, pulling);
    await f.evict();
    controller.abort('no longer needed');
    assert.equal(record.finalized, 0);
    held.release.resolve();
    await assert.rejects(pulling, { code: 'JD2072' });
    assert.equal(record.finalized, 1);
    await cursor.return();
  }
  finally { await f.store.close(); }
});

for (const asynchronous of [false, true]) for (const entity of [false, true])
  it(`${entity ? 'entity' : 'collection'} explanations release on success and scan refusal (${asynchronous ? 'promise' : 'sync'})`, async () => {
    const f = await fixture(asynchronous);
    const engine = entity ? f.entities : f.notes;
    const doc = entity ? entityQuery : '$[*]';
    try {
      for (let i = 0; i < 3; i++) {
        await engine.explain(doc);
        await assert.rejects(async () => engine.execute(doc, { profile: { refuseFullScan: true } }), { code: 'JD0011' });
      }
      const explained = f.records.filter((r) => /^EXPLAIN\b/.test(r.sql));
      assert.equal(explained.length, 6);
      assert.ok(explained.every((record) => record.finalized === 1));
    }
    finally { await f.store.close(); }
  });
