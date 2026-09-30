//@ts-check
/**
 * @file The relational engine bound to a Store (MODEL-FORMAT §5.3):
 * `store.relational`, `store.sync.relational`, `tx.relational` and
 * `tx.sync.relational` are the one engine `relational(connection)` is,
 * over the Store's admission. Root reads take the gate, prepared
 * read-only so a pool reader serves them; a root cursor is admitted per
 * pull; a root write is a top-level immediate transaction of its own. A
 * transaction's engine runs as that exact scope — a retained handle is
 * JD2070, a hold limit counts its calls — and its writes are savepoints
 * of the transaction. Writes follow the rules `tx.sql` follows: pending
 * tracked changes refuse, a store-only invariant refuses a write to its
 * entity's table and no other, journal capture refuses (it has no before
 * and after images for them) and session capture records them.
 *
 * Runs on node, node-worker and node-pool; under `bun test` on bun (the
 * synchronous twin included); on PostgreSQL behind `JAREN_PG_URL`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { sql } from '@jarenjs/db/relational';
import { tempDbPath } from './helpers.js';

const bun = process.versions.bun !== undefined;
const c = sql.column;
const b = sql.binary;

const MODEL = {
  $model: '0.1',
  entities: {
    A: {
      schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, amount: { type: 'integer' } } },
      invariants: [{ name: 'positive', on: ['insert', 'update'], enforcement: 'store', assert: { $gt: ['$.new.amount', 0] } }],
    },
    B: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, amount: { type: 'integer' } } } },
  },
};

/** The synchronous in-thread driver of the runtime running the tests. */
const inThread = async () => (bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver());
/** @type {[string, () => Promise<any>][]} */
const HOSTS = bun ? [['bun', inThread]] : [
  ['node', inThread],
  ['node-worker', async () => (await import('@jarenjs/db/node-worker')).nodeWorkerDriver()],
  ['node-pool', async () => (await import('@jarenjs/db/node-pool')).nodeWorkerPoolDriver({ readers: 2 })],
];

/**
 * A store on a fresh file over `driver`, with the raw connection kept so
 * the test can create the application table the store does not own.
 * @param {any} driver @param {any} [options]
 */
async function fixture(driver, options = {}) {
  const { dbPath, cleanup } = tempDbPath();
  /** @type {any} */
  let raw;
  const store = await openStore(MODEL, { driver: { ...driver, open: async (/** @type {any[]} */ ...args) => (raw = await driver.open(...args)) },
    path: dbPath, ...options });
  await raw.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT UNIQUE)');
  return { store, raw, close: async () => { await store.close(); cleanup(); } };
}

/** A promise plus its resolver. */
const defer = () => {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const count = { from: 'items', columns: { n: sql.call('count', []) } };
const coded = (/** @type {string} */ code) => (/** @type {any} */ error) => error?.code === code;

for (const [host, driverOf] of HOSTS) {
  describe(`store.relational on ${host}`, () => {
    it('reads, writes and classifies at the root and inside a transaction', async () => {
      const { store, close } = await fixture(await driverOf());
      try {
        const r = store.relational;
        assert.deepEqual(await r.execute({ op: 'insert', table: 'items', values: { label: 'a' } }), { affected: 1, lastInsertRowid: 1 });
        const ignored = await r.execute({ op: 'insert', table: 'items', values: { label: 'a' }, ignore: true });
        assert.deepEqual(ignored, { affected: 0 }, 'an insert that inserted nothing reports no rowid');
        await assert.rejects(r.execute({ op: 'insert', table: 'items', values: { id: 1, label: 'b' } }),
          (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint' && /UNIQUE/.test(error.message));
        assert.deepEqual((await r.all({ from: 'items', columns: { label: c('label') } })).map((row) => ({ ...row })), [{ label: 'a' }]);
        // a transaction's writes are its own: seen inside, gone with its rollback
        await assert.rejects(store.transaction(async (tx) => {
          await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'undone' } });
          assert.equal((await tx.relational.get(count)).n, 2, 'the transaction reads its own write');
          throw new Error('undo');
        }), /undo/);
        assert.equal((await r.get(count)).n, 1);
        const committed = await store.transaction(async (tx) => {
          const result = await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'kept' }, returning: { id: c('id') } });
          // a failed write inside is a savepoint: the transaction carries on
          await assert.rejects(tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'kept' } }), coded('JD2005'));
          return result;
        });
        assert.equal(committed.affected, 1);
        assert.deepEqual((await r.all({ from: 'items', columns: { label: c('label') }, orderBy: [{ by: c('id') }] })).map((row) => row.label), ['a', 'kept']);
        // refusals are rejections on the asynchronous surface, never throws
        const refused = r.all({ op: 'delete', table: 'items', where: 1 });
        assert.ok(refused instanceof Promise);
        await assert.rejects(refused, coded('JD0038'));
      }
      finally { await close(); }
    });

    it('a root cursor lets another root call complete between two pulls; a transaction cursor refuses JD2070 once settled', async () => {
      const { store, close } = await fixture(await driverOf());
      try {
        for (const label of ['a', 'b', 'c']) await store.relational.execute({ op: 'insert', table: 'items', values: { label } });
        const cursor = store.relational.iterate({ from: 'items', columns: { label: c('label') }, orderBy: [{ by: c('id') }] });
        assert.equal((await cursor.next()).value.label, 'a');
        // between two pulls the gate is free: a root write commits
        await store.relational.execute({ op: 'update', table: 'items', set: { label: 'C' }, where: b('=', c('label'), 'c') });
        await store.transaction(async (tx) => { await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'd' } }); });
        const rest = [];
        for await (const row of cursor) rest.push(row.label);
        assert.ok(rest.length >= 2 && rest[0] === 'b', `the cursor carried on after the other calls: ${rest}`);
        /** @type {any} */
        let escaped;
        await store.transaction(async (tx) => {
          escaped = tx.relational.iterate({ from: 'items' });
          await escaped.next();
        });
        await assert.rejects(escaped.next(), coded('JD2070'));
        /** @type {any} */
        let retained;
        await store.transaction(async (tx) => { retained = tx.relational; });
        await assert.rejects(retained.all({ from: 'items' }), coded('JD2070'));
        await assert.rejects(retained.execute({ op: 'delete', table: 'items', where: 1 }), coded('JD2070'));
        assert.equal((await store.relational.get(count)).n, 4, 'nothing ran through the retained handle');
      }
      finally { await close(); }
    });

    it('writes follow the SQL write rules: a store-only invariant guards its own table and no other; pending tracked changes refuse', async () => {
      const { store, close } = await fixture(await driverOf());
      try {
        await store.entity('A').create({ id: 'a1', amount: 1 });
        await store.entity('B').create({ id: 'b1', amount: 1 });
        const bump = (/** @type {string} */ table) => ({ op: 'update', table, set: { amount: 2 }, where: 1 });
        assert.equal((await store.relational.execute(bump('B'))).affected, 1, "B carries no store-only rule");
        for (const table of ['A', ...(host === 'node' || host === 'bun' ? ['a'] : [])]) {
          await assert.rejects(store.relational.execute(bump(table)),
            (/** @type {any} */ error) => error.code === 'JD2095' && /entity 'A'/.test(error.message), table);
        }
        await assert.rejects(store.transaction((tx) => tx.relational.execute(bump('A'))), coded('JD2095'));
        assert.equal((await store.entity('A').get('a1'))?.amount, 1, 'the guarded table was not written');
        // a pending tracked change would be saved over what the statement
        // wrote: its own refusal (JD2041), apart from JD2040's preconditions
        store.entity('B').add({ id: 'b2', amount: 3 });
        await assert.rejects(store.relational.execute(bump('B')), coded('JD2041'));
        store.entity('B').discard('b2');
        assert.equal((await store.relational.execute(bump('B'))).affected, 1);
        // and the write invalidates what the trackers held: the entity reads the new value
        assert.equal((await store.entity('B').get('b1'))?.amount, 2);
      }
      finally { await close(); }
    });

    it('a hold limit counts relational calls and fences the handle it rolled back', async () => {
      const { store, close } = await fixture(await driverOf());
      try {
        const late = defer();
        const running = store.transaction(async (tx) => {
          await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'held' } });
          await new Promise((resolve) => setTimeout(resolve, 150));
          late.resolve(tx.relational.all({ from: 'items' }).then(() => 'ran', (/** @type {any} */ error) => error.code));
        }, { holdTimeoutMs: 50 });
        await assert.rejects(running, coded('JD2098'));
        assert.equal(await late.promise, 'JD2098', 'the late call refused with the hold, not a stale scope');
        assert.equal((await store.relational.get(count)).n, 0, 'nothing of the held body remains');
      }
      finally { await close(); }
    });
  });
}

if (!bun) {
  describe('store.relational reader routing and strict contention', () => {
    it('on node-pool with two readers a root read runs on a reader; a transaction read stays on the writer', async () => {
      const { nodeWorkerPoolDriver } = await import('@jarenjs/db/node-pool');
      const { store, raw, close } = await fixture(nodeWorkerPoolDriver({ readers: 2 }));
      try {
        await store.relational.execute({ op: 'insert', table: 'items', values: { label: 'a' } });
        const readers = () => raw.metrics().workers.filter((/** @type {any} */ w) => w.readOnly)
          .reduce((/** @type {number} */ sum, /** @type {any} */ w) => sum + w.executions, 0);
        const before = readers();
        assert.equal((await store.relational.all({ from: 'items' })).length, 1);
        assert.ok(readers() > before, 'the reader lane served the root read');
        const pinned = readers();
        await store.transaction(async (tx) => { await tx.relational.all({ from: 'items' }); });
        assert.equal(readers(), pinned, 'an open transaction pins its reads to the writer');
      }
      finally { await close(); }
    });

    it("{ transactions: 'strict' } refuses a contended root read or write at once (JD0012); otherwise a root write waits its turn", async () => {
      const { nodeDriver } = await import('@jarenjs/db/node');
      for (const strict of [true, false]) {
        const { store, close } = await fixture(nodeDriver(), strict ? { transactions: 'strict' } : {});
        try {
          const gate = defer();
          const owner = store.transaction(async (tx) => {
            await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'owner' } });
            await gate.promise;
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (strict) {
            await assert.rejects(store.relational.all({ from: 'items' }), coded('JD0012'));
            await assert.rejects(store.relational.execute({ op: 'insert', table: 'items', values: { label: 'x' } }), coded('JD0012'));
            gate.resolve();
            await owner;
          }
          else {
            let wrote = false;
            const waiting = store.relational.execute({ op: 'insert', table: 'items', values: { label: 'after' } }).then((out) => { wrote = true; return out; });
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.equal(wrote, false, 'the root write queued behind the owner');
            gate.resolve();
            await owner;
            assert.equal((await waiting).affected, 1);
          }
        }
        finally { await close(); }
      }
    });
  });

  describe('store.relational and change capture', () => {
    it('session capture records a relational write on a store table; journal capture refuses it; physical entities still refuse capture', async () => {
      const { nodeDriver } = await import('@jarenjs/db/node');
      const { store, close } = await fixture(nodeDriver(), { capture: { mode: 'session' } });
      try {
        await store.entity('B').create({ id: 'b1', amount: 1 });
        /** @type {any[]} */
        const seen = [];
        store.observe((record) => seen.push(...record.patch));
        await store.relational.execute({ op: 'update', table: 'B', set: { amount: 5 }, where: 1 });
        await store.transaction(async (tx) => { await tx.relational.execute({ op: 'update', table: 'B', set: { amount: 6 }, where: 1 }); });
        await store.relational.execute({ op: 'insert', table: 'items', values: { label: 'not the store\'s' } });
        assert.deepEqual(seen, [
          { op: 'replace', path: '/B/b1/amount', value: 5 },
          { op: 'replace', path: '/B/b1/amount', value: 6 },
        ], 'the store table\'s changes reach the stream; the application table is not the store\'s');
      }
      finally { await close(); }
      const journal = await fixture(nodeDriver(), { capture: { mode: 'journal' } });
      try {
        await journal.store.entity('B').create({ id: 'b1', amount: 1 });
        await assert.rejects(journal.store.relational.execute({ op: 'update', table: 'B', set: { amount: 5 }, where: 1 }), coded('JD0051'));
        await assert.rejects(journal.store.transaction((tx) => tx.relational.execute({ op: 'update', table: 'items', set: { label: 'x' }, where: 1 })), coded('JD0051'));
        assert.equal((await journal.store.entity('B').get('b1'))?.amount, 1);
      }
      finally { await journal.close(); }
      const physical = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
        id: { type: 'integer', 'x-entity': { key: true } } } }, physical: { table: 'item', columns: { id: { name: 'id', codec: 'integer', null: 'reject' } } } } } };
      await assert.rejects(openStore(physical, { driver: nodeDriver(), capture: true }), coded('JD0051'));
    });
  });
}

describe('store.sync.relational', () => {
  it('answers values at the root and inside a synchronous transaction, and refuses to wait (JD0012)', async () => {
    const { store, close } = await fixture(await inThread());
    try {
      const sync = /** @type {any} */ (store.sync).relational;
      assert.deepEqual(sync.execute({ op: 'insert', table: 'items', values: { label: 'a' } }), { affected: 1, lastInsertRowid: 1 });
      assert.deepEqual([...sync.iterate({ from: 'items', columns: { label: c('label') } })].map((row) => row.label), ['a']);
      assert.equal(sync.get(count).n, 1);
      const inside = /** @type {any} */ (store.sync).transaction((/** @type {any} */ tx) => {
        tx.sync.relational.execute({ op: 'insert', table: 'items', values: { label: 'b' } });
        const labels = [...tx.sync.relational.iterate({ from: 'items', columns: { label: c('label') }, orderBy: [{ by: c('id') }] })]
          .map((row) => row.label);
        assert.deepEqual(labels, ['a', 'b'], "the transaction's synchronous cursor reads its own write");
        return tx.sync.relational.all({ from: 'items' }).length;
      });
      assert.equal(inside, 2);
      assert.throws(() => sync.execute({ op: 'insert', table: 'items', values: { id: 1, label: 'z' } }),
        (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
      const gate = defer();
      const owner = store.transaction(async () => { await gate.promise; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        assert.throws(() => sync.all({ from: 'items' }), coded('JD0012'));
        assert.throws(() => sync.execute({ op: 'delete', table: 'items', where: 1 }), coded('JD0012'));
      }
      finally {
        gate.resolve();
        await owner;
      }
      assert.equal(sync.get(count).n, 2);
    }
    finally { await close(); }
  });
});

const url = process.env.JAREN_PG_URL;
// a packed consumer inherits the variable but installs no PostgreSQL client
const pgClient = url ? await import('pg').then(() => true, () => false) : false;
describe('store.relational on PostgreSQL', { skip: (!url && 'JAREN_PG_URL is not set') || (!pgClient && 'the pg client is not installed') }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_relstore_${process.pid}`;
  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
  after(async () => {
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  it('the same engine over native cursors: root and transaction, the write rules, a cursor that pins the session', async () => {
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const driver = postgresDriver(pool, { schema });
    /** @type {any} */
    let raw;
    const store = await openStore(MODEL, { driver: { ...driver, open: async (/** @type {any[]} */ ...args) => (raw = await driver.open(...args)) } });
    try {
      await raw.exec('CREATE TABLE items(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, label text UNIQUE)');
      const r = store.relational;
      assert.deepEqual(await r.execute({ op: 'insert', table: 'items', values: { label: 'a' } }), { affected: 1 },
        'PostgreSQL reports no rowid');
      assert.deepEqual(await r.execute({ op: 'insert', table: 'items', values: { label: 'a' }, ignore: true }), { affected: 0 });
      await assert.rejects(r.execute({ op: 'insert', table: 'items', values: { id: 1, label: 'b' } }),
        (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
      await assert.rejects(store.transaction(async (tx) => {
        await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'undone' } });
        throw new Error('undo');
      }), /undo/);
      await store.transaction(async (tx) => {
        // a failed write is a savepoint: the transaction is not aborted (no 25P02)
        await assert.rejects(tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'a' } }), coded('JD2005'));
        await tx.relational.execute({ op: 'insert', table: 'items', values: { label: 'kept' } });
      });
      assert.deepEqual((await r.all({ from: 'items', columns: { label: c('label') }, orderBy: [{ by: c('id') }] })).map((row) => row.label), ['a', 'kept']);
      await store.entity('A').create({ id: 'a1', amount: 1 });
      await assert.rejects(r.execute({ op: 'update', table: 'A', set: { amount: 2 }, where: true }), coded('JD2095'));
      // a native cursor lives in a transaction: it holds the session until released
      const cursor = r.iterate({ from: 'items', columns: { label: c('label') } });
      assert.ok((await cursor.next()).value.label);
      let wrote = false;
      const pending = r.execute({ op: 'insert', table: 'items', values: { label: 'later' } }).then((out) => { wrote = true; return out; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(wrote, false, 'the write waits for the cursor');
      await cursor.return();
      assert.equal((await pending).affected, 1);
    }
    finally { await store.close(); await pool.end(); }
  });
});
