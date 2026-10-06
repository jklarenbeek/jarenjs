//@ts-check
/** Replication temporaries own complete calls and drains at finite host capacity. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { createLogicalRows } from '../../packages/db/src/logical-rows.js';
import { tempDbPath } from './helpers.js';

const MODEL = { $model: '0.1', collections: { notes: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } },
} } } };
/** @type {[string, () => any][]} */
const HOSTS = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 64, windowRows: 1 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 1, worker: { maxStatements: 64, windowRows: 1 } })],
];
if (!process.versions.bun) HOSTS.push(['process', () => nodeProcessDriver({ maxStatements: 64, windowRows: 1 })]);

/** @param {any} driver @param {(store: any) => Promise<void>} run @param {any} [config] */
async function withReplica(driver, run, config = {}) {
  const { dbPath, cleanup } = tempDbPath();
  let store;
  try {
    store = await openStore(MODEL, { driver, path: dbPath, capture: { mode: 'journal' },
      replication: { replica: 'local', ...config } });
    await run(store);
  }
  finally {
    try { await store?.close(); }
    finally { cleanup(); }
  }
}

for (const [host, driver] of HOSTS) {
  it(`${host}: 100 replicated writes release temporary statements and retain exact envelopes`, async () => {
    await withReplica(driver(), async (store) => {
      for (let n = 0; n < 100; n++) await store.collection('notes').put({ id: 'one', n });
      assert.deepEqual(await store.collection('notes').get('one'), { id: 'one', n: 99 });
      const page = await store.replication.page();
      assert.deepEqual(page.items.map((item) => [item.seq, item.operations[0].after.n]),
        Array.from({ length: 100 }, (_, n) => [n + 1, n]));
      await store.collection('notes').put({ id: 'one', n: 99 });
      assert.deepEqual(await store.replication.frontier(), { local: 100 });
    });
  });

  it(`${host}: 100 empty replication pages keep their statement capacity and exact bounds`, async () => {
    await withReplica(driver(), async (store) => {
      for (let n = 0; n < 100; n++) assert.deepEqual(await store.replication.page(), {
        items: [], earliestAvailable: null, highWatermark: 0, next: 0,
        bytes: 0, resetRequired: false, hasMore: false,
      });
    });
  });

  it(`${host}: 100 replication snapshots drain and release both temporary readers`, async () => {
    await withReplica(driver(), async (store) => {
      const expected = await store.replication.snapshot();
      assert.deepEqual(expected.rows, []);
      assert.deepEqual(expected.receipts, []);
      assert.deepEqual(expected.frontier, {});
      for (let n = 0; n < 100; n++) assert.deepEqual(await store.replication.snapshot(), expected);
    });
  });

  it(`${host}: 100 applied envelopes and duplicate replays stay bounded without echoes`, async () => {
    await withReplica(driver(), async (store) => {
      const model = (await store.replication.snapshot()).model;
      for (let n = 0; n < 100; n++) {
        const frontier = { upstream: n + 1 };
        const envelope = { $replication: '0.1', replica: 'upstream', seq: n + 1,
          frontier: n === 0 ? {} : { upstream: n }, model, operations: [{ table: 'notes', key: 'one',
            before: n === 0 ? null : { id: 'one', n: n - 1 }, after: { id: 'one', n } }] };
        assert.deepEqual(await store.replication.apply(envelope), { status: 'applied', frontier, conflicts: [] });
        assert.deepEqual(await store.replication.apply(envelope), { status: 'duplicate', frontier, conflicts: [] });
      }
      assert.deepEqual(await store.collection('notes').get('one'), { id: 'one', n: 99 });
      assert.deepEqual(await store.replication.frontier(), { upstream: 100 });
      assert.deepEqual((await store.replication.page()).items, []);
    });
  });
}

const SHAPES = new Map([['Members', {
  kind: 'join', columns: [{ name: 'a' }, { name: 'b' }], keyIndexes: [0, 1],
}]]);
const RETURN_FAILURE = new Error('owned iterator return failed');

it('200 replicated entity membership create/delete cycles fit worker capacity 64', async () => {
  const key = { type: 'string', 'x-entity': { key: true } };
  const model = { $model: '0.1', entities: {
    Item: { schema: { type: 'object', required: ['id'], properties: {
      id: key, tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
    } } },
    Tag: { schema: { type: 'object', required: ['id'], properties: { id: key } } },
  } };
  const store = await openStore(model, { driver: nodeWorkerDriver({ maxStatements: 64 }),
    capture: { mode: 'journal' }, replication: { replica: 'local' } });
  try {
    await store.entity('Tag').create({ id: 't' });
    for (let n = 0; n < 200; n++) {
      await store.entity('Item').create({ id: String(n), tags: ['t'] });
      await store.entity('Item').delete(String(n));
    }
    assert.deepEqual(await store.entity('Item').load({}), []);
    assert.deepEqual(await store.entity('Tag').get('t'), { id: 't' });
    assert.deepEqual(await store.replication.frontier(), { local: 401 });
  }
  finally { await store.close(); }
});

it('logical membership reads and writes reuse one remote statement slot through 100 cycles', async () => {
  const connection = await nodeWorkerDriver({ maxStatements: 1 }).open();
  const captured = [];
  try {
    await connection.exec('CREATE TABLE Members (a TEXT, b TEXT, PRIMARY KEY(a,b))');
    const rows = createLogicalRows({ connection, shapes: SHAPES,
      capture: { mode: 'journal', record: (...args) => captured.push(args) } });
    for (let n = 0; n < 100; n++) {
      const key = JSON.stringify(['a', String(n)]);
      const value = { a: 'a', b: String(n) };
      await rows.write({ table: 'Members', key, before: null, after: value });
      assert.deepEqual(await rows.read('Members', key), value);
      assert.equal(await rows.position('Members', key), 1);
      assert.equal(await rows.empty(), false);
      await rows.write({ table: 'Members', key, before: value, after: null });
      assert.equal(await rows.read('Members', key), undefined);
      assert.equal(await rows.empty(), true);
    }
    assert.equal(captured.length, 200);
    assert.deepEqual(captured[0], ['Members', ['a', '0'], null, { a: 'a', b: '0' }]);
    assert.deepEqual(captured[199], ['Members', ['a', '99'], { a: 'a', b: '99' }, null]);
  }
  finally { await connection.close(); }
});

it('replicated synchronous writes and logical row helpers remain synchronous', async () => {
  await withReplica(nodeDriver(), async (store) => {
    for (let n = 0; n < 100; n++) {
      const result = store.sync.collection('notes').put({ id: 'one', n });
      assert.equal(result instanceof Promise, false);
    }
    assert.deepEqual(store.sync.collection('notes').get('one'), { id: 'one', n: 99 });
    assert.deepEqual(await store.replication.frontier(), { local: 100 });
  });
  const connection = await nodeDriver().open(':memory:');
  try {
    connection.exec('CREATE TABLE Members (a TEXT, b TEXT, PRIMARY KEY(a,b))');
    const rows = createLogicalRows({ connection, shapes: SHAPES, capture: { mode: 'journal', record() {} } });
    assert.equal(rows.empty(), true);
    assert.equal(rows.write({ table: 'Members', key: '["a","b"]', before: null, after: { a: 'a', b: 'b' } }), undefined);
    assert.deepEqual(rows.read('Members', '["a","b"]'), { a: 'a', b: 'b' });
    assert.equal(rows.position('Members', '["a","b"]'), 1);
  }
  finally { connection.close(); }
});

/** Observe real SQLite statements without changing the public Store contract.
 * @param {boolean} asynchronous
 */
function observedDriver(asynchronous) {
  const base = nodeDriver();
  const records = [];
  /** @type {{ fault: string | null, abort: (() => void) | null, afterGet: ((sql: string) => void) | null }} */
  const state = { fault: null, abort: null, afterGet: null };
  const answer = (value) => asynchronous ? Promise.resolve(value) : value;
  const observe = (connection) => {
    const wrappedConnection = { ...connection, synchronous: !asynchronous, prepare(sql) {
      const statement = connection.prepare(sql);
      if (!sql.includes('_jaren_replica')) return statement;
      const record = { sql, finalized: 0, active: 0 };
      records.push(record);
      const live = () => assert.equal(record.finalized, 0, 'the operation still owns its statement');
      const wrapped = { ...statement, finalize() {
        assert.equal(record.active, 0, 'iterator cleanup precedes statement release');
        record.finalized++;
        return answer(statement.finalize?.());
      } };
      for (const method of ['run', 'get', 'all']) wrapped[method] = (...params) => {
        live();
        const result = statement[method](...params);
        if (method === 'get') state.afterGet?.(sql);
        return answer(result);
      };
      wrapped.iterate = (params) => {
        live();
        const iterator = statement.iterate(params);
        record.active++;
        let done = false;
        const finish = () => { if (!done) { done = true; record.active--; } };
        return answer({ next() {
          live();
          const step = iterator.next();
          if (step.done) finish();
          if (!step.done && sql.includes('_jaren_replica_outbox')) {
            state.abort?.();
            if (state.fault === 'map') step.value = { ...step.value, payload: '{' };
          }
          return answer(step);
        }, return() {
          live(); finish();
          const result = iterator.return?.() ?? { done: true };
          if (state.fault === 'return') {
            if (asynchronous) return Promise.reject(RETURN_FAILURE);
            throw RETURN_FAILURE;
          }
          return answer(result);
        } });
      };
      return answer(wrapped);
    } };
    for (const member of ['transaction', 'exclusively', 'shared']) {
      if (typeof connection[member] === 'function') wrappedConnection[member] = (fn, ...args) =>
        connection[member]((scope) => fn(observe(scope ?? connection)), ...args);
    }
    return wrappedConnection;
  };
  return { records, state, driver: { ...base, open: async (...args) => observe(await base.open(...args)) } };
}

for (const asynchronous of [false, true]) {
  it(`replication drains release after byte refusal, mapping failure and cancellation (${asynchronous ? 'async' : 'sync'} prepare)`, async () => {
    const observed = observedDriver(asynchronous);
    await withReplica(observed.driver, async (store) => {
      await store.collection('notes').put({ id: 'one', n: 1 });
      await store.collection('notes').put({ id: 'one', n: 2 });
      const envelopes = (await store.replication.page()).items;
      for (let n = 0; n < 3; n++) {
        await assert.rejects(store.replication.page({ maxBytes: 1 }), { code: 'JD2074' });
        observed.state.fault = 'map';
        try { await assert.rejects(store.replication.page(), SyntaxError); }
        finally { observed.state.fault = null; }
        const controller = new AbortController();
        observed.state.abort = () => controller.abort();
        try { await assert.rejects(store.replication.page({ signal: controller.signal }), { code: 'JD2072' }); }
        finally { observed.state.abort = null; }
        observed.state.fault = 'return';
        try { await assert.rejects(store.replication.page({ limit: 1 }), (error) => error === RETURN_FAILURE); }
        finally { observed.state.fault = null; }
        assert.deepEqual((await store.replication.page()).items, envelopes);
      }
      assert.ok(observed.records.some((record) => record.sql.includes('SELECT payload FROM _jaren_replica_outbox')));
      for (const record of observed.records) {
        assert.equal(record.active, 0, record.sql);
        assert.equal(record.finalized, 1, record.sql);
      }
    });
  });

  it(`snapshot shared row credits release statements on refusal (${asynchronous ? 'async' : 'sync'} prepare)`, async () => {
    const observed = observedDriver(asynchronous);
    await withReplica(observed.driver, async (store) => {
      await store.collection('notes').put({ id: 'one', n: 1 });
      await store.collection('notes').put({ id: 'one', n: 2 });
      for (let n = 0; n < 3; n++) await assert.rejects(store.replication.snapshot(), { code: 'JD2106' });
      assert.deepEqual(await store.replication.frontier(), { local: 2 });
      for (const record of observed.records) {
        assert.equal(record.active, 0, record.sql);
        assert.equal(record.finalized, 1, record.sql);
      }
    }, { maxOperations: 2 });
  });

  it(`cancellation between metadata and cursor acquisition prepares no drain statement (${asynchronous ? 'async' : 'sync'} prepare)`, async () => {
    const observed = observedDriver(asynchronous);
    await withReplica(observed.driver, async (store) => {
      for (const operation of ['page', 'snapshot']) {
        const controller = new AbortController();
        const start = observed.records.length;
        observed.state.afterGet = (sql) => {
          if (operation === 'snapshot' || sql.startsWith('SELECT min(seq)')) controller.abort();
        };
        try { await assert.rejects(store.replication[operation]({ signal: controller.signal }), { code: 'JD2072' }); }
        finally { observed.state.afterGet = null; }
        assert.equal(observed.records.slice(start).some((record) =>
          record.sql.startsWith('SELECT payload') || record.sql.startsWith('SELECT name, key')), false);
      }
    });
  });
}
