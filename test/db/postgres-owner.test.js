//@ts-check
/**
 * @file The owner lock on PostgreSQL (MODEL-FORMAT §5.1, HOSTS.md): a
 * Store opened with `owner` holds a session-level advisory lock of its own
 * class, keyed by its schema, for as long as it holds its session — no
 * table, so an adopted store takes it too. A second owner is refused
 * `JD2061`; `close()` unlocks before the session goes back to its pool (a
 * pooled session outlives the Store, and a session lock with it), and so
 * does an open that fails after taking the lock; a session that ends
 * releases it on the server.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { POSTGRES_LOCK_CLASSES } from '../../packages/db/src/dialects/postgres-locks.js';

const url = process.env.JAREN_PG_URL;
const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

describe('PostgreSQL: the owner session lock', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_owner_${process.pid}`;
  /** @type {any[]} */
  const pools = [];

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
  after(async () => {
    for (const pool of pools.splice(0)) await pool.end().catch(() => {});
    if (admin) {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });

  const pool = () => {
    const made = new pg.Pool({ connectionString: url, max: 1 });
    pools.push(made);
    return made;
  };
  /** Sessions holding the owner lock on this schema: its second key
   * is the schema's OID, shifted into int4 (pg_locks shows it unsigned). */
  const holdingSessions = async () => (await admin.query("SELECT l.pid FROM pg_catalog.pg_locks l "
    + "WHERE l.locktype = 'advisory' AND l.granted AND l.classid = $1::oid "
    + 'AND l.objid = (((SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $2)::int8 - 2147483648) '
    + '& 4294967295)::oid', [POSTGRES_LOCK_CLASSES.owner, schema])).rows;
  const holders = async () => (await holdingSessions()).length;
  /** @param {any} source @param {Record<string, any>} [more] */
  const openOwner = (source, more = {}) => openStore(MODEL,
    { driver: postgresDriver(source, { schema }), owner: { id: 'service' }, ...more });
  const refused = (/** @type {any} */ error) => error.code === 'JD2061' && error.class === 'busy'
    && error.retryable === true && error.message.includes(schema);

  it('one owner per schema: a second is refused JD2061, close() releases at once, the pooled session keeps no lock', async () => {
    const shared = pool();
    const first = await openOwner(shared);
    try {
      assert.equal(first.capabilities.owner, 'session');
      assert.equal(await holders(), 1);
      await assert.rejects(openOwner(pool()), refused);
      // a store without owner neither takes nor checks the lock
      const plain = await openStore(MODEL, { driver: postgresDriver(pool(), { schema }) });
      assert.equal(plain.capabilities.owner, 'none');
      await plain.close();
    }
    finally { await first.close(); }
    assert.equal(await holders(), 0, 'unlocked before the session went back to the pool');
    // the same pooled session, borrowed by a raw caller, holds nothing
    const { rows } = await shared.query("SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()");
    assert.equal(rows[0].n, 0);
    const second = await openOwner(pool());
    assert.equal(await holders(), 1);
    await second.close();
    assert.equal(await holders(), 0);
  });

  it('an adopted store takes the session lock too — no table is needed', async () => {
    await (await openStore(MODEL, { driver: postgresDriver(pool(), { schema }) })).close();
    const adopted = await openOwner(pool(), { adopt: true });
    try {
      assert.equal(adopted.capabilities.owner, 'session');
      assert.equal(await holders(), 1);
      await assert.rejects(openOwner(pool(), { adopt: true }), refused);
      const tables = await admin.query('SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename LIKE $2',
        [schema, '%owner%']);
      assert.equal(tables.rows[0].n, 0);
    }
    finally { await adopted.close(); }
    assert.equal(await holders(), 0);
  });

  it('an open that fails after taking the lock releases it', async () => {
    const shared = pool();
    // a model whose collection disagrees with the table already there
    const drifted = { ...MODEL, collections: { docs: { ...MODEL.collections.docs,
      indexes: [{ name: 'by_n', path: '$.n' }] } } };
    await assert.rejects(openStore(drifted, { driver: postgresDriver(shared, { schema }), owner: { id: 'drifted' }, adopt: true }),
      (/** @type {any} */ error) => typeof error.code === 'string' && error.code !== 'JD2061');
    assert.equal(await holders(), 0);
    const { rows } = await shared.query("SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()");
    assert.equal(rows[0].n, 0);
  });

  it('a session whose lock release could not run is destroyed, never pooled, and the next owner opens', async () => {
    const shared = pool();
    const first = await openOwner(shared, { queueTimeout: 300 });
    // a body that never settles holds the gate, so the release outwaits it
    first.transaction(() => new Promise(() => {})).catch(() => {});
    await delay(20);
    const removed = once(shared, 'remove');
    await first.close();
    assert.equal(shared.totalCount, 0, 'the session was destroyed, not returned to its pool');
    // pg.Pool's release(error) returns void: removal from its reusable
    // clients precedes physical socket shutdown. Observe that shutdown,
    // not a race between two connections reaching the server.
    await removed;
    assert.equal(await holders(), 0, 'the server released the destroyed session\'s lock');
    const second = await openOwner(pool());
    await second.close();
  });

  it('two schemas whose names share a hashtext never contend for the owner lock or the writer lock', async () => {
    // two of this run's own schema names whose 32-bit name hashes collide
    const { rows } = await admin.query("SELECT array_agg(name ORDER BY name) AS names FROM (SELECT 'jaren_hc_' || $1::text "
      + "|| '_' || g AS name FROM generate_series(1, 300000) g) AS t GROUP BY pg_catalog.hashtext(name) "
      + 'HAVING count(*) > 1 LIMIT 1', [String(process.pid)]);
    const [left, right] = rows[0].names;
    await admin.query(`CREATE SCHEMA "${left}"; CREATE SCHEMA "${right}"`);
    /** @type {any[]} */
    const stores = [];
    try {
      const own = async (/** @type {string} */ name) => {
        const store = await openStore(MODEL, { driver: postgresDriver(pool(), { schema: name }), owner: { id: name } });
        stores.push(store);
        return store;
      };
      const a = await own(left);
      const b = await own(right);
      assert.equal(b.capabilities.owner, 'session');
      // an immediate transaction held open in one schema does not hold up the other's
      /** @type {() => void} */
      let settle = () => {};
      const held = a.transaction(async (/** @type {any} */ tx) => {
        await tx.collection('docs').put({ id: 'a', n: 1 }, 'a');
        await new Promise((resolve) => { settle = () => resolve(undefined); });
      }, { mode: 'immediate' });
      await delay(50);
      await b.transaction(async (/** @type {any} */ tx) => { await tx.collection('docs').put({ id: 'b', n: 1 }, 'b'); },
        { mode: 'immediate' });
      settle();
      await held;
    }
    finally {
      for (const store of stores) await store.close().catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS "${left}" CASCADE; DROP SCHEMA IF EXISTS "${right}" CASCADE`);
    }
  });

  it('a session that ends releases the lock on the server', async () => {
    const first = await openOwner(pool());
    try {
      const rows = await holdingSessions();
      assert.equal(rows.length, 1);
      await admin.query('SELECT pg_catalog.pg_terminate_backend($1)', [rows[0].pid]);
      for (let i = 0; i < 200 && await holders() > 0; i++) await delay(10);
      assert.equal(await holders(), 0);
      const second = await openOwner(pool());
      await second.close();
    }
    finally { await first.close().catch(() => {}); }
  });
});
