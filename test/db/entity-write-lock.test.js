//@ts-check
/**
 * @file The entity writes that read before they write wait out another
 * connection's write lock on SQLite for `busyTimeout`, as every other
 * write does. A ruled update or delete reads the row its rule judges, a
 * probed insert reads the row its `$exists-row` names, a physical update
 * reads the row it assigns, a database rule's update reads the row it
 * replaces, and a delete a cascade reaches reads its closure (a create
 * with memberships is one transaction around its probed insert): a deferred
 * transaction upgraded from read to write while another connection holds
 * the write lock meets the `SQLITE_BUSY` no busy handler is asked to wait
 * out, which would refuse `JD2005` at once however long `busyTimeout` is,
 * so the write's own transaction — the entity's, `saveChanges()`'s, a
 * judged cascade delete's, a create with memberships' — takes the write lock with its first
 * statement. The other connection is a worker thread holding `BEGIN
 * IMMEDIATE` and an uncommitted write: it releases on a timer of its own
 * while this thread's synchronous driver waits, and the shared flag it
 * sets says whether this thread's call returned before or after that
 * release.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { compileEntityModel, openStore } from '@jarenjs/db';
import { entityCore } from '@jarenjs/db/entity';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const key = { type: 'string', 'x-entity': { key: true } };
const kept = (/** @type {string[]} */ on) => [{ name: 'kept', on, enforcement: 'store', assert: { $gt: ['$.old.n', -1] } }];
const intKey = { type: 'integer', 'x-entity': { key: true } };
const physicalColumns = { id: { name: 'id', codec: 'integer', null: 'reject' }, n: { name: 'n', codec: 'number', null: 'reject' } };
const model = { $model: '0.1', entities: {
  // a store rule judges the row an update or delete replaces
  Ruled: { schema: { type: 'object', required: ['id'], properties: { id: key, n: { type: 'number' } } }, invariants: kept(['update', 'delete']) },
  Plain: { schema: { type: 'object', required: ['id'], properties: { id: key, n: { type: 'number' } } } },
  // a database rule: its trigger judges, the update reads the row it replaces
  Triggered: { schema: { type: 'object', required: ['id'], properties: { id: key, n: { type: 'number' } } },
    invariants: [{ name: 'triggered', on: ['update'], enforcement: 'database', assert: { $gt: ['$.old.n', -1] } }] },
  // a store rule probes the row an insert names; its memberships are written with it
  Probed: { schema: { type: 'object', required: ['id'], properties: { id: key, ref: { type: 'string' },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } },
    invariants: [{ name: 'named', on: ['insert'], enforcement: 'store', assert: { '$exists-row': { entity: 'Plain', match: { id: '$.new.ref' } } } }] },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: key } } },
  // a physical row: an update reads the row it assigns
  Row: { schema: { type: 'object', properties: { id: intKey, n: { type: 'number' } } },
    physical: { table: 'row_t', columns: physicalColumns }, invariants: kept(['update']) },
  // a cascade a store rule judges: a delete of the parent reads its closure
  Parent: { schema: { type: 'object', required: ['id'], properties: { id: key,
    kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
  Kid: { schema: { type: 'object', required: ['id'], properties: { id: key, parentId: { type: ['string', 'null'] } } },
    invariants: [{ name: 'kid', on: ['delete'], enforcement: 'store', assert: { $ne: ['$.old.id', ''] } }] },
} };

/** The other connection: it takes the write lock, says so, and releases it
 * `release` ms after this thread starts its call, or when told to. */
const HOLDER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
const flags = workerData.flags;
db.exec('BEGIN IMMEDIATE');
db.exec('INSERT INTO holder_t VALUES (1)');
let open = true;
const release = () => {
  if (!open) return;
  open = false;
  // set before the COMMIT: the other thread cannot take the lock before it is set
  Atomics.store(flags, 1, 1);
  db.exec('COMMIT');
  db.close();
  parentPort.postMessage('released');
};
parentPort.on('message', release);
parentPort.postMessage('locked');
Atomics.wait(flags, 0, 0);
if (workerData.release !== null) setTimeout(release, workerData.release);
`;

/**
 * A store file holding one row of each entity ('a', the physical row 1, a
 * parent 'p' with its kid 'k'), a second store on it with those rows read
 * into its tracker, and the other connection holding the write lock;
 * `call` runs once the lock is held.
 * @param {{ busyTimeout: number, release: number | null }} lock
 * @param {(store: any, tracked: Record<string, any>) => any} call
 */
async function underWriteLock(lock, call) {
  const file = tempDbPath();
  const raw = new DatabaseSync(file.dbPath);
  raw.exec('CREATE TABLE row_t(id INTEGER PRIMARY KEY, n REAL NOT NULL); CREATE TABLE holder_t(x)');
  raw.close();
  const seed = await openStore(model, { driver: nodeDriver(), path: file.dbPath });
  try {
    for (const name of ['Ruled', 'Plain', 'Triggered']) await seed.entity(name).create({ id: 'a', n: 1 });
    await seed.entity('Row').create({ id: 1, n: 1 });
    await seed.entity('Tag').create({ id: 't' });
    await seed.entity('Parent').create({ id: 'p' });
    await seed.entity('Kid').create({ id: 'k', parentId: 'p' });
  }
  finally {
    await seed.close();
  }
  const store = await openStore(model, { driver: nodeDriver(), path: file.dbPath, busyTimeout: lock.busyTimeout });
  /** @type {Record<string, any>} */
  const tracked = { Ruled: await store.entity('Ruled').get('a'), Row: await store.entity('Row').get(1),
    Parent: await store.entity('Parent').get('p') };
  const flags = new Int32Array(new SharedArrayBuffer(8));
  const holder = new Worker(HOLDER, { eval: true, workerData: { file: file.dbPath, flags, release: lock.release } });
  const released = once(holder, 'exit');
  try {
    const [first] = await once(holder, 'message');
    assert.equal(first, 'locked');
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
    /** @type {{ value?: any, error?: any }} */
    let outcome;
    try {
      outcome = { value: await call(store, tracked) };
    }
    catch (error) {
      outcome = { error };
    }
    const releasedFirst = Atomics.load(flags, 1) === 1;
    holder.postMessage('release');
    if (Atomics.load(flags, 1) === 0) await once(holder, 'message');
    return { ...outcome, releasedFirst };
  }
  finally {
    await holder.terminate();
    await released;
    await store.close();
    file.cleanup();
  }
}

/** Generous against the holder's release, which comes first by far. */
const WAITS = { busyTimeout: 30_000, release: 100 };

/** A save's counts. @param {any} report */
const counts = (report) => ({ inserted: report.inserted, updated: report.updated, deleted: report.deleted });

/** Each write that reads first, with what it answers once the lock is released. */
const WRITES = [
  { name: 'a ruled update()', call: (/** @type {any} */ store) => store.entity('Ruled').update('a', { n: 2 }),
    expected: { id: 'a', n: 2 } },
  { name: 'a ruled delete()', call: (/** @type {any} */ store) => store.entity('Ruled').delete('a'), expected: true },
  { name: 'a database rule\'s update()', call: (/** @type {any} */ store) => store.entity('Triggered').update('a', { n: 2 }),
    expected: { id: 'a', n: 2 } },
  { name: 'a probed create()', call: (/** @type {any} */ store) => store.entity('Probed').create({ id: 'q', ref: 'a' }),
    expected: { id: 'q', ref: 'a' } },
  { name: 'a probed create() with memberships', call: (/** @type {any} */ store) => store.entity('Probed').create({ id: 'm', ref: 'a', tags: ['t'] }),
    expected: { id: 'm', ref: 'a', tags: ['t'] } },
  { name: 'a physical update()', call: (/** @type {any} */ store) => store.entity('Row').update(1, { n: 2 }),
    expected: { id: 1, n: 2 } },
  { name: 'a judged cascade delete()', call: (/** @type {any} */ store) => store.entity('Parent').delete('p'), expected: true },
  { name: 'saveChanges() of a ruled delete', call: (/** @type {any} */ store, /** @type {any} */ tracked) => {
    store.entity('Ruled').remove(tracked.Ruled);
    return chainCounts(store.saveChanges());
  }, expected: { inserted: 0, updated: 0, deleted: 1 } },
  { name: 'saveChanges() of a ruled physical update', call: (/** @type {any} */ store, /** @type {any} */ tracked) => {
    store.entity('Row').put({ ...tracked.Row, n: 5 });
    return chainCounts(store.saveChanges());
  }, expected: { inserted: 0, updated: 1, deleted: 0 } },
  { name: 'saveChanges() of a probed insert', call: (/** @type {any} */ store) => {
    store.entity('Probed').add({ id: 'q', ref: 'a' });
    return chainCounts(store.saveChanges());
  }, expected: { inserted: 1, updated: 0, deleted: 0 } },
  { name: 'saveChanges() of a judged cascade delete', call: (/** @type {any} */ store, /** @type {any} */ tracked) => {
    store.entity('Parent').remove(tracked.Parent);
    return chainCounts(store.saveChanges());
  }, expected: { inserted: 0, updated: 0, deleted: 1 } },
];

/** @param {Promise<any>} saved */
async function chainCounts(saved) {
  return counts(await saved);
}

describe('entity writes that read before they write wait out another connection\'s write lock on SQLite', () => {
  for (const write of WRITES) {
    it(`${write.name} waits for the lock and then writes`, async () => {
      const out = await underWriteLock(WAITS, write.call);
      assert.equal(out.error, undefined);
      assert.equal(out.releasedFirst, true);
      assert.deepEqual(out.value, write.expected);
    });
  }

  it('the cascade delete removed the kid its closure read', async () => {
    const out = await underWriteLock(WAITS, async (store) => {
      await store.entity('Parent').delete('p');
      return store.entity('Kid').get('k');
    });
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, true);
    assert.equal(out.value, undefined);
  });

  it('a lock held past busyTimeout is the store\'s busy failure, naming the entity the write was for', async () => {
    const named = (/** @type {string} */ name) => /** @type {(typeof WRITES)[number]} */ (WRITES.find((write) => write.name === name));
    for (const [write, expected] of /** @type {const} */ ([
      [named('a ruled update()'), { docPath: '/entities/Ruled', collection: 'Ruled', key: 'a' }],
      [named('a probed create() with memberships'), { docPath: '/entities/Probed', collection: 'Probed', key: 'm' }],
      [named('a judged cascade delete()'), { docPath: '/entities/Parent', collection: 'Parent', key: 'p' }],
      [named('saveChanges() of a ruled delete'), { docPath: '/entities/Ruled', collection: 'Ruled', key: undefined }],
    ])) {
      const out = await underWriteLock({ busyTimeout: 20, release: null }, write.call);
      assert.equal(out.releasedFirst, false, write.name);
      assert.equal(out.error?.code, 'JD2005', write.name);
      assert.equal(out.error.class, 'busy', write.name);
      assert.equal(out.error.retryable, true, write.name);
      assert.deepEqual({ docPath: out.error.docPath, collection: out.error.collection, key: out.error.key }, expected, write.name);
    }
  });

  it('inside an open transaction the write is its savepoint: a root begun with mode \'immediate\' waits', async () => {
    const out = await underWriteLock(WAITS, (store) => store.transaction((/** @type {any} */ tx) => tx.entity('Ruled').delete('a'),
      { mode: 'immediate' }));
    assert.equal(out.error, undefined);
    assert.equal(out.releasedFirst, true);
    assert.equal(out.value, true);
  });
});

describe('an entity core over a driver\'s own connection', () => {
  // its `transaction(fn, signal, mode)` reads a second argument as a signal:
  // a bracketed write queued behind the connection's open transaction waits
  // for it and then writes (PostgreSQL: the driver's connection queues)
  it('a physical create() queued behind the connection\'s transaction waits, then writes', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}".row_t(id integer PRIMARY KEY, n double precision NOT NULL)`);
      const { entities, mapping } = compileEntityModel({ $model: '0.1', entities: {
        Row: { schema: { type: 'object', properties: { id: intKey, n: { type: 'number' } } }, physical: { table: 'row_t', schema, columns: physicalColumns } } } });
      const connection = await driver().open();
      try {
        const core = entityCore(connection, entities.get('Row'), mapping.entities.Row, null);
        let settled = false;
        const held = connection.transaction(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          settled = true;
        });
        const created = await core.create({ id: 1, n: 1 });
        await held;
        assert.equal(settled, true);
        assert.deepEqual(created, { id: 1, n: 1 });
        assert.deepEqual(await core.update(1, { n: 2 }), { id: 1, n: 2 });
      }
      finally {
        await connection.close();
      }
    });
  });
});
