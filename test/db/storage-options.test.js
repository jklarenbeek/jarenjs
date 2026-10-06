import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, migrate, migrationStatus, planModelMigration, planRelational, sqliteDialect, sql } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver, POSTGRES_DEFAULTS } from '@jarenjs/db/postgres';
import { workerPoolDriver } from '../../packages/db/src/drivers/worker-pool.js';

const model = {
  $model: '0.1',
  collections: { docs: { key: '/id', schema: { type: 'object', properties: { n: { type: 'integer' } } } } },
  entities: {
    Item: {
      schema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'integer' } },
      },
    },
  },
};
const names = (options) => JSON.stringify(options);

describe('storage configuration refuses before acquisition', () => {
  it('explicit null does not silently substitute a default PostgreSQL bound', () => {
    for (const key of Object.keys(POSTGRES_DEFAULTS)) {
      assert.throws(() => postgresDriver({ connect() { assert.fail('must not acquire'); } }, { [key]: null }),
        { code: 'JD0003' }, key);
    }
  });
  const invalid = [
    { statementCacheBound: 0 }, { statementCacheBound: -1 }, { statementCacheBound: 'many' },
    { functions: 'x' }, { functions: { bad: 'x' } }, { extensions: 'x' }, { extensions: { bad: {} } },
    { expressions: 'x' }, { zoneProvider: 'x' }, { capture: { mode: 'jornal' } }, { capture: { bogus: 1 } },
    { capture: { log: { retenton: 2 } } }, { jobs: { bogus: 1 } }, { jobs: { maxAttempts: 'x' } },
    { live: { bogus: 1 } }, { live: { maxQueries: 'x' } }, { live: { maxMaintained: -1 } }, { reads: 'parallel' },
  ];
  for (const options of invalid) {
    it(names(options), async () => {
      let acquisitions = 0, store, error;
      const real = nodeDriver();
      try {
        store = await openStore(model, {
          ...options,
          driver: { ...real, open: (...args) => { acquisitions++; return real.open(...args); } },
        });
      }
      catch (caught) { error = caught; }
      finally { await store?.close(); }
      assert.equal(error?.code, 'JD0009');
      assert.equal(acquisitions, 0);
    });
  }

  it('replication identity is refused before acquisition', async () => {
    let acquisitions = 0, store, error;
    const real = nodeDriver();
    try {
      store = await openStore(model, {
        replication: {},
        driver: { ...real, open: (...args) => { acquisitions++; return real.open(...args); } },
      });
    }
    catch (caught) { error = caught; }
    finally { await store?.close(); }
    assert.equal(error?.code, 'JD0060');
    assert.equal(acquisitions, 0);
  });

  for (const options of [null, 42, [], { statementTimeoutMs: 'x' }, { prepared: 'both' }, { cursorMode: 'maybe' }]) {
    it(`Postgres ${names(options)}`, () => {
      assert.throws(() => postgresDriver({ connect() { assert.fail('must not connect'); } }, options), { code: 'JD0003' });
    });
  }
});

describe('finite read controls remain closed and typed', () => {
  for (const synchronous of [false, true]) {
    for (const [method, options] of [
      ['all', { signal: 'x' }], ['all', { deadline: 'soon' }], ['all', { strictStreaming: 'yes' }],
      ['page', { limt: 2 }], ['page', { lookahed: false }], ['page', { maxbytes: 1 }],
      ['page', { signal: 'x' }], ['page', { deadline: 'soon' }],
      ['relational', { signl: 1 }], ['relational', { signal: 5 }], ['relational', { externals: 'abc' }],
    ]) {
      it(`${synchronous ? 'sync' : 'async'} ${method} ${names(options)}`, async () => {
        const store = await openStore(model, { driver: nodeDriver() });
        try {
          const owner = synchronous ? store.sync : store;
          const run = () => method === 'all' ? owner.collection('docs').all(options)
            : method === 'page' ? owner.entity('Item').page({}, options)
            : owner.relational.all({ from: 'Item', columns: { id: sql.column('id') } }, options);
          await assert.rejects(async () => run(), { code: 'JD0013' });
        }
        finally { await store.close(); }
      });
    }
  }

  it('the pure planner accepts the declared signal without performing execution cancellation', () => {
    const document = { from: 'Item', columns: { id: sql.column('id') } };
    assert.deepEqual(planRelational(document, { signal: AbortSignal.abort() }), planRelational(document));
    assert.throws(() => planRelational(document, { signal: 'invalid' }), { code: 'JD0013' });
  });

  it('a graph page retains its declared cursor options while the set owns tracking', async () => {
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      await store.entity('Item').create({ id: 'a', value: 1 });
      store.entity('Item').discard('a');
      const options = { limit: 1, tracking: true, externals: {}, strict: true, pushdown: false, strictStreaming: true };
      const page = await store.entity('Item').page({}, options);
      assert.deepEqual(page.items, [{ id: 'a', value: 1 }]);
      assert.equal(store.stats().tracker.tracked, 1);
      assert.deepEqual((await store.sync.entity('Item').page({}, options)).items, page.items);
    }
    finally { await store.close(); }
  });
});

describe('migration control names refuse before a source is acquired', () => {
  for (const [method, options] of [['migrate', { baseline: model, atomc: true }], ['status', { modle: model }]]) {
    it(method, async () => {
      let acquisitions = 0;
      const real = nodeDriver();
      const target = { driver: { ...real, open: (...args) => { acquisitions++; return real.open(...args); } } };
      await assert.rejects(async () => method === 'migrate' ? migrate(target, [], options) : migrationStatus(target, [], options),
        { code: 'JD0013' });
      assert.equal(acquisitions, 0);
    });
  }

  it('a planner transform typo does not silently return a draft transform', () => {
    const from = {
      $model: '0.1',
      collections: { docs: { key: '/id', schema: { type: 'object', properties: { n: { type: 'integer' } } }, indexes: [] } },
    };
    const to = structuredClone(from);
    to.collections.docs.schema.properties.n.maximum = 5;
    assert.throws(() => planModelMigration(from, to, {
      dialect: sqliteDialect, id: 'narrow', transfrom: { kind: 'host', run: 'repair', version: '1' },
    }), { code: 'JD0013' });
  });
});

describe('parallel-read construction hints preserve observed capability checks', () => {
  it('the pool hint mirrors its read-only, memory and zero-reader choices without opening', () => {
    for (const readers of [0, 2]) {
      const driver = workerPoolDriver({ readers }, () => assert.fail('preflight opens no worker'));
      for (const path of [':memory:', '', 'data.sqlite']) {
        for (const readOnly of [false, true]) {
          assert.equal(driver.supportsSharedReads(path, { readOnly }), readOnly || (path === 'data.sqlite' && readers > 0));
        }
      }
    }
  });

  for (const hint of [undefined, () => true]) {
    it(`an injected ${hint ? 'optimistic' : 'unknown'} hint still verifies the opened connection`, async () => {
      const real = nodeDriver();
      let acquisitions = 0;
      const driver = {
        ...real, supportsSharedReads: hint,
        open: (...args) => { acquisitions++; return real.open(...args); },
      };
      await assert.rejects(openStore(model, { driver, reads: 'parallel' }), { code: 'JD0009' });
      assert.equal(acquisitions, 1);
    });
  }
});

describe('collection patches refuse values JSON cannot store before changing a row', () => {
  for (const synchronous of [false, true]) {
    it(synchronous ? 'sync' : 'async', async () => {
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        const docs = (synchronous ? store.sync : store).collection('docs');
        await docs.put({ id: 'a', n: 1 });
        const cycle = {};
        cycle.self = cycle;
        for (const value of [2n, cycle, undefined]) {
          await assert.rejects(async () => docs.patch('a', [{ op: 'replace', path: '/n', value }]), { code: 'JD2003' });
          assert.deepEqual(await docs.get('a'), { id: 'a', n: 1 });
        }
        assert.deepEqual(await docs.patch('a', [{ op: 'replace', path: '/n', value: 2 }]), { id: 'a', n: 2 });
      }
      finally { await store.close(); }
    });
  }
});
