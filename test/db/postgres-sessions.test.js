//@ts-check
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { asyncLive } from '@jarenjs/db/async-live';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const model = { $model: '0.1', collections: {
  notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } } },
}, entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, title: { type: 'string' },
} } } } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stream = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.id' };

describe('a store on several sessions refuses before it opens', () => {
  it('refuses a driver that runs one connection, a malformed count, one past maxConnections and replication', async () => {
    await assert.rejects(openStore(model, { driver: nodeDriver(), sessions: 2 }), (error) => {
      assert.equal(/** @type {any} */ (error).code, 'JD0009');
      assert.match(String(/** @type {any} */ (error).message), /driver 'node-sqlite' runs one connection/);
      return true;
    });
    await assert.rejects(openStore(model, { driver: nodeDriver(), sessions: 1 }), { code: 'JD0009' });
    let connects = 0;
    const source = { connect: async () => { connects++; throw new Error('never reached'); } };
    for (const sessions of [0, 1.5, '2', -1])
      await assert.rejects(openStore(model, { driver: postgresDriver(source), sessions }), { code: 'JD0009' });
    await assert.rejects(openStore(model, { driver: postgresDriver(source, { maxConnections: 3 }), sessions: 4 }),
      { code: 'JD0009', message: /maxConnections \(3\)/ });
    await assert.rejects(openStore(model, { driver: postgresDriver(source), sessions: 2, replication: {} }),
      { code: 'JD0009', message: /replication/ });
    assert.equal(connects, 0, 'nothing opened');
  });
});

const url = process.env.JAREN_PG_URL;
describe('PostgreSQL store on several sessions', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, sequence = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn) {
    const schema = `jaren_sessions_${process.pid}_${sequence++}`;
    const pool = new pg.Pool({ connectionString: url, max: 12 }), stores = [];
    const open = async (options = {}) => {
      const store = await openStore(model, { driver: postgresDriver(pool, { schema }), sessions: 4, queueTimeout: 2000, ...options });
      stores.push(store);
      return store;
    };
    try { await pool.query(`CREATE SCHEMA "${schema}"`); await fn({ pool, open }); }
    finally {
      try { for (const store of stores) await store.close(); }
      finally { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    }
  }
  /** The server's clock and session, read inside a transaction. @param {any} tx */
  const where = async (tx) => /** @type {any} */ (await tx.sql.prepare(
    'SELECT extract(epoch FROM clock_timestamp())::float8 AS at, pg_backend_pid() AS pid', { access: 'read' }).get([]));
  /** @param {any} tx @param {number} seconds */
  const sleep = (tx, seconds) => tx.sql.prepare(`SELECT pg_sleep(${seconds})`, { access: 'read' }).get([]);

  it('runs four independent write transactions at the same time, each on a session of its own', async () => {
    await fixture(async ({ open }) => {
      const store = await open();
      assert.equal(store.capabilities.connections, 4);
      const spans = await Promise.all([1, 2, 3, 4].map((i) => store.transaction(async (tx) => {
        const start = await where(tx);
        await tx.collection('notes').put({ id: `n${i}`, n: i });
        await sleep(tx, 0.15);
        return { start: start.at, end: (await where(tx)).at, pid: start.pid };
      })));
      assert.ok(Math.max(...spans.map((s) => s.start)) < Math.min(...spans.map((s) => s.end)),
        `every transaction was open while every other was: ${JSON.stringify(spans)}`);
      assert.equal(new Set(spans.map((s) => s.pid)).size, 4, 'four server sessions');
      assert.deepEqual((await store.collection('notes').all()).map((note) => /** @type {any} */ (note).n).sort(), [1, 2, 3, 4]);
      // a call made on a body's synchronous extent joins that transaction, as on one session
      await assert.rejects(store.transaction(async () => {
        await store.collection('notes').put({ id: 'joined', n: 9 });
        throw new Error('undo');
      }), /undo/);
      assert.equal(await store.collection('notes').get('joined'), undefined);
    });
  });

  it('leaves conflicts to the database: a serialization failure is a busy refusal retry absorbs, immediate ones take the writer lock in turn', async () => {
    await fixture(async ({ open }) => {
      const store = await open();
      await store.collection('notes').put({ id: 'counter', n: 0 });
      const bump = (/** @type {any} */ options) => store.transaction(async (tx) => {
        const counter = /** @type {any} */ (await tx.collection('notes').get('counter'));
        await delay(100); // both read before either writes
        await tx.collection('notes').put({ id: 'counter', n: counter.n + 1 });
        return tx.attempt;
      }, { isolation: 'repeatable read', ...options });
      const settled = await Promise.allSettled([bump(), bump()]);
      assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
      const refused = /** @type {any} */ (settled.find((s) => s.status === 'rejected')).reason;
      assert.equal(refused.class, 'busy'); assert.equal(refused.retryable, true);
      const attempts = await Promise.all([bump({ retry: { attempts: 5, baseMs: 1, maxMs: 5 } }), bump({ retry: { attempts: 5, baseMs: 1, maxMs: 5 } })]);
      assert.deepEqual(attempts.sort(), [1, 2], 'one of the two ran again');
      assert.equal(/** @type {any} */ (await store.collection('notes').get('counter')).n, 3);
      const turns = await Promise.all([1, 2].map(() => store.transaction(async (tx) => {
        const start = (await where(tx)).at;
        await sleep(tx, 0.1);
        return { start, end: (await where(tx)).at };
      }, { mode: 'immediate' })));
      turns.sort((a, b) => a.start - b.start);
      assert.ok(turns[0].end <= turns[1].start, `the writer lock ordered them: ${JSON.stringify(turns)}`);
    });
  });

  it('a paused root cursor holds one session, never the store', async () => {
    await fixture(async ({ open }) => {
      const several = await open(), one = await open({ sessions: 1, queueTimeout: 300 });
      for (let i = 0; i < 10; i++) await several.collection('notes').put({ id: `n${i}`, n: i });
      for (const [store, waits] of [[several, false], [one, true]]) {
        const cursor = /** @type {any} */ (store).collection('notes').query(stream);
        assert.equal(cursor.streaming, 'row');
        assert.equal((await cursor.next()).value, 'n0');
        const started = performance.now();
        if (waits) await assert.rejects(/** @type {any} */ (store).collection('notes').get('n1'), { code: 'JD0012' });
        else assert.deepEqual(await /** @type {any} */ (store).collection('notes').get('n1'), { id: 'n1', n: 1 });
        if (!waits) assert.ok(performance.now() - started < 250, 'an unrelated call did not wait for the cursor');
        assert.equal((await cursor.next()).value, 'n1');
        await cursor.return();
      }
    });
  });

  it('an escaped handle and an expired hold refuse per scope, beside a transaction that commits', async () => {
    await fixture(async ({ open }) => {
      const store = await open();
      /** @type {any} */
      let escaped;
      await store.transaction(async (tx) => { escaped = tx; });
      await assert.rejects(async () => escaped.collection('notes').get('x'), { code: 'JD2070' });
      // a handle of an OPEN transaction used from another transaction's body
      const opened = Promise.withResolvers(), done = Promise.withResolvers();
      const first = store.transaction(async (tx) => { opened.resolve(tx); await done.promise; });
      const crossed = store.transaction(async () => {
        const other = /** @type {any} */ (await opened.promise);
        await assert.rejects(async () => other.collection('notes').get('x'), { code: 'JD2070' });
      });
      await crossed; done.resolve(undefined); await first;
      const held = store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: 'held', n: 1 });
        await delay(300);
        await tx.collection('notes').get('held');
      }, { holdTimeoutMs: 100 });
      const quick = store.transaction(async (tx) => { await tx.collection('notes').put({ id: 'quick', n: 2 }); });
      await assert.rejects(held, { code: 'JD2098' });
      await quick;
      assert.equal(await store.collection('notes').get('held'), undefined);
      assert.deepEqual(await store.collection('notes').get('quick'), { id: 'quick', n: 2 });
      // work a body leaves behind runs, once the body ended, as a root call of its own
      const later = Promise.withResolvers();
      await store.transaction(async (tx) => {
        setTimeout(() => { Promise.resolve(store.collection('notes').put({ id: 'later', n: 3 })).then(later.resolve, later.reject); }, 30);
        await tx.collection('notes').put({ id: 'now', n: 4 });
      });
      await later.promise;
      assert.deepEqual(await store.collection('notes').get('later'), { id: 'later', n: 3 });
    });
  });

  it('serves the store\'s own unit of work on its first session while transactions hold the others, each with its own', async () => {
    await fixture(async ({ open }) => {
      const store = await open();
      const items = /** @type {any} */ (store).entity('Item');
      await items.create({ id: 'a', title: 'one' });
      const release = Promise.withResolvers();
      const holding = [1, 2, 3].map((i) => store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: `h${i}`, n: i });
        await release.promise;
      }));
      await delay(50);
      // three sessions are held; the first still serves root tracked work
      const started = performance.now();
      const tracked = await items.get('a');
      items.put({ ...tracked, title: 'two' });
      await store.saveChanges();
      assert.ok(performance.now() - started < 500, 'tracked work did not wait for the transactions');
      // a transaction saves its own unit of work, never the store's, and its
      // trusted SQL is not refused for the store's pending changes
      items.put({ ...(await items.get('a')), title: 'pending at the root' });
      await store.transaction(async (tx) => {
        const own = /** @type {any} */ (tx).entity('Item');
        own.put({ ...(await own.get('a')), title: 'three' });
        await /** @type {any} */ (tx).saveChanges();
        await /** @type {any} */ (tx).sql.prepare('UPDATE notes SET doc = doc WHERE key = $1', { access: 'write', affects: ['notes'] }).run(['h1']);
      });
      release.resolve(undefined);
      await Promise.all(holding);
      assert.equal((await items.asNoTracking().get('a')).title, 'three');
      await store.saveChanges();
      assert.equal((await items.asNoTracking().get('a')).title, 'pending at the root');
      // with every session held, tracked work waits for the first one, and says so
      const short = await open({ queueTimeout: 200 });
      const letGo = Promise.withResolvers();
      const all = [1, 2, 3, 4].map(() => short.transaction(async () => { await letGo.promise; }));
      await delay(50);
      await assert.rejects(/** @type {any} */ (short).entity('Item').get('a'), { code: 'JD0012', message: /first session/ });
      await assert.rejects(short.collection('notes').get('h1'), { code: 'JD0012', message: /one of the store's 4 sessions/ });
      letGo.resolve(undefined);
      await Promise.all(all);
    });
  });

  it('holds the owner lease on its first session and releases it there at close', async () => {
    await fixture(async ({ pool, open }) => {
      const owner = await open({ owner: { id: 'app' } });
      assert.equal(owner.capabilities.owner, 'session');
      await Promise.all([1, 2, 3].map((i) => owner.transaction(async (tx) => { await tx.collection('notes').put({ id: `o${i}`, n: i }); })));
      await assert.rejects(open({ owner: { id: 'other' }, sessions: 2 }), { code: 'JD2061' });
      const pooled = pool.totalCount;
      await owner.close();
      // a lock released where it was taken: every session goes back to the pool
      assert.equal(pool.totalCount, pooled);
      assert.equal(pool.idleCount, pool.totalCount);
      const next = await open({ owner: { id: 'next' } });
      assert.deepEqual(await next.collection('notes').get('o1'), { id: 'o1', n: 1 });
    });
  });

  it('keeps capture, jobs and live queries exact while sessions write at once', async () => {
    await fixture(async ({ open }) => {
      const store = await open({ capture: { mode: 'journal', log: { retention: 100 } }, jobs: true, live: asyncLive({ pollMs: 60000 }) });
      /** @type {number[]} */
      const delivered = [];
      store.observe((record) => delivered.push(record.seq));
      const live = await store.collection('notes').live([{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }]);
      await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: `c${i}`, n: i });
        await tx.jobs.enqueue('work', { i }, { id: `job${i}` });
        await delay(20);
      })));
      const page = await store.changes.page({ after: 0, limit: 100 });
      assert.deepEqual(page.items.map((record) => record.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(delivered, [1, 2, 3, 4, 5, 6, 7, 8], 'delivered once each, in sequence');
      assert.equal(new Set(page.items.flatMap((record) => record.patch.map((op) => op.path))).size, 8);
      await live.refresh();
      assert.deepEqual(live.result.rows, await store.collection('notes').execute([{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }]));
      /** @type {string[]} */
      const claimed = [];
      await Promise.all([1, 2, 3, 4].map(async (worker) => {
        for (;;) {
          const job = /** @type {any} */ (await store.jobs.claim({ kinds: ['work'], owner: `w${worker}` }));
          if (job === undefined) return;
          claimed.push(job.id);
          await store.jobs.complete(job.lease, { by: worker });
        }
      }));
      assert.deepEqual(claimed.sort(), [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `job${i}`).sort());
    });
  });
});
