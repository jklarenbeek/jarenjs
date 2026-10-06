//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, sqliteDialect } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { wasmDriver } from '@jarenjs/db/wasm';

const model = { $model: '0.1', collections: { items: {
  key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } }, indexes: [],
} } };
const counterSql = sqliteDialect.introspect.dataVersion();
const hosts = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 11 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: 11 } })],
];
// This endpoint's public runtime contract is Node 24+.
if (!process.versions.bun) hosts.push(['process', () => nodeProcessDriver({ maxStatements: 11 })]);

async function poll(over) {
  const first = await over.dataVersion();
  assert.equal(typeof first, 'number');
  for (let i = 1; i < 100; i++) assert.equal(await over.dataVersion(), first, `poll ${i + 1}`);
}

for (const [host, driver] of hosts) for (const transaction of [false, true])
  it(`${host}: 100 ${transaction ? 'transaction' : 'root'} data-version polls fit one temporary slot`, async () => {
    // Ten fixed Store preparations leave exactly one slot on each host.
    const store = await openStore(model, { driver: driver(), statementCacheBound: 1 });
    try {
      if (transaction) await store.transaction(poll);
      else await poll(store);
    }
    finally { await store.close(); }
  });

it('the native synchronous binding keeps the public Promise contract for root and transaction polls', async () => {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const store = await openStore(model, { driver });
  try {
    assert.equal(store.sync.dataVersion, undefined);
    const value = store.dataVersion();
    assert.equal(typeof value.then, 'function');
    assert.equal(await value, 1);
    await poll(store);
    await store.transaction(async (tx) => {
      assert.equal(tx.sync.dataVersion, undefined);
      await poll(tx);
    });
  }
  finally { await store.close(); }
});

/** Inject only counter-read faults into a real synchronous SQLite handle. */
async function observedStore(asynchronous = false, finalization = true) {
  const Native = process.versions.bun ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  const database = new Native(':memory:');
  const control = { prepareError: null, readError: null, cleanupError: null, held: null,
    prepared: 0, finalized: 0, events: [] };
  const settle = (run) => asynchronous ? Promise.resolve().then(run) : run();
  const raw = {
    exec: (sql) => database.exec(sql),
    close: () => { control.events.push('close'); database.close(); },
    prepare(sql) {
      const make = () => {
        const native = database.prepare(sql);
        return {
          run: (params = []) => native.run(...params),
          get: (params = []) => native.get(...params) ?? undefined,
          all: (params = []) => native.all(...params),
          iterate: (params = []) => native.iterate(...params),
        };
      };
      if (sql !== counterSql) return make();
      control.prepared++;
      control.events.push('prepare');
      return settle(() => {
        if (control.prepareError !== null) throw control.prepareError;
        const statement = make();
        const get = statement.get;
        statement.get = (params) => {
          const read = () => {
            control.events.push('read');
            if (control.readError !== null) throw control.readError;
            return get(params);
          };
          if (control.held !== null) {
            control.held.started.resolve();
            return control.held.release.promise.then(read);
          }
          return settle(read);
        };
        if (finalization) statement.finalize = () => {
          control.finalized++;
          control.events.push('finalize');
          if (control.cleanupError !== null) return settle(() => { throw control.cleanupError; });
        };
        return statement;
      });
    },
  };
  const store = await openStore(model, { driver: wasmDriver({ synchronous: !asynchronous, open: () => raw }) });
  return { store, control };
}

for (const asynchronous of [false, true]) for (const finalization of [false, true])
  it(`injected ${asynchronous ? 'Promise' : 'sync'} counter reads preserve answers with finalize ${finalization ? 'present' : 'absent'}`, async () => {
    const { store, control } = await observedStore(asynchronous, finalization);
    try {
      const first = store.dataVersion();
      assert.equal(typeof first.then, 'function');
      if (!asynchronous) assert.deepEqual([...control.events], finalization ? ['prepare', 'read', 'finalize'] : ['prepare', 'read']);
      assert.equal(await first, 1);
      await poll(store);
      await store.transaction(poll);
      assert.equal(control.prepared, 201);
      assert.equal(control.finalized, finalization ? 201 : 0);
    }
    finally { await store.close(); }
  });

for (const asynchronous of [false, true])
  it(`a ${asynchronous ? 'Promise' : 'sync'} counter failure releases its handle and preserves the original error`, async () => {
    const { store, control } = await observedStore(asynchronous);
    const readError = Object.assign(new Error('counter unavailable'), { code: 'SQLITE_BUSY' });
    const cleanupError = new Error('cleanup refused');
    try {
      control.readError = readError;
      control.cleanupError = cleanupError;
      await assert.rejects(store.dataVersion(), (error) => error === readError);
      assert.equal(control.finalized, 1);
      control.readError = null;
      assert.equal(await store.dataVersion(), 1);
      assert.equal(control.finalized, 2);
      control.cleanupError = null;
      control.prepareError = readError;
      await assert.rejects(store.dataVersion(), (error) => error === readError);
      assert.equal(control.finalized, 2, 'a failed preparation supplied no handle');
      control.prepareError = null;
      assert.equal(await store.dataVersion(), 1);
      assert.equal(control.finalized, 3);
    }
    finally { await store.close(); }
  });

it('a pending counter read releases on settlement and close refuses later reads without preparation', async () => {
  const { store, control } = await observedStore(true);
  const held = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  control.held = held;
  try {
    const reading = store.dataVersion();
    await held.started.promise;
    assert.equal(control.finalized, 0);
    held.release.resolve();
    assert.equal(await reading, 1);
    assert.equal(control.finalized, 1);
    await store.close();
    assert.deepEqual(control.events, ['prepare', 'read', 'finalize', 'close']);
    await assert.rejects(store.dataVersion(), { code: 'JD2063' });
    assert.equal(control.prepared, 1);
    await store.close();
    assert.equal(control.events.filter((event) => event === 'close').length, 1);
  }
  finally { held.release.resolve(); await store.close(); }
});

it('an escaped or temporarily shadowed transaction cannot prepare another counter read', async () => {
  const { store, control } = await observedStore();
  let escaped;
  try {
    await store.transaction(async (tx) => {
      escaped = tx;
      assert.equal(await tx.dataVersion(), 1);
      await tx.transaction(async (inner) => {
        await assert.rejects(tx.dataVersion(), { code: 'JD2070' });
        assert.equal(await inner.dataVersion(), 1);
      });
      assert.equal(await tx.dataVersion(), 1);
    });
    await assert.rejects(escaped.dataVersion(), { code: 'JD2070' });
    assert.equal(control.prepared, 3);
    assert.equal(control.finalized, 3);
  }
  finally { await store.close(); }
});
