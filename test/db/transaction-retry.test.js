//@ts-check
/**
 * @file `retry` re-runs a transaction as a whole (MODEL-FORMAT §5.1):
 * explicitly, boundedly, and only after a failure that says it may be
 * retried — `class: 'busy'`, `retryable: true`, a known commit outcome.
 * Each attempt is a complete top-level transaction through the gate, on
 * a fresh unit of work of its own, and the callback sees its number as
 * `tx.attempt`. Before, `{ retry }` was accepted and ignored, and
 * re-running a callback by hand after a busy failure inserted TWO rows
 * under the default shared unit of work.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { open } from '@jarenjs/linq/db';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] }, key: '/id', indexes: [] },
  },
  entities: {
    Post: {
      schema: {
        type: 'object',
        required: ['pid'],
        properties: { pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' } },
      },
    },
  },
};

/** @param {string} code */
const coded = (code) => (/** @type {any} */ error) => error?.code === code;

/** Two stores on one fresh file; `b` interferes, `a` retries. */
async function pair(aOptions = {}) {
  const { dbPath, cleanup } = tempDbPath();
  const a = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 50, ...aOptions });
  const b = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, busyTimeout: 2000 });
  return { a, b, close: async () => { await a.close(); await b.close(); cleanup(); } };
}

/**
 * A read-then-write body on `a` that meets the busy the handler cannot
 * retry whenever `interfere(attempt)` says so: after its read, `b`
 * commits a write, so `a`'s upgrade to a writer fails busy.
 * @param {any} a @param {any} b
 * @param {(attempt: number) => boolean} interfere
 * @param {number[]} seen
 */
const readThenWrite = (a, b, interfere, seen) => async (/** @type {any} */ tx) => {
  seen.push(tx.attempt);
  const row = await tx.collection('docs').get('k');
  if (interfere(tx.attempt)) await b.collection('docs').put({ id: `b${tx.attempt}`, n: 0 }, `b${tx.attempt}`);
  await tx.collection('docs').put({ id: 'k', n: (row?.n ?? 0) + 1 }, 'k');
  return tx.attempt;
};

describe('store.transaction(fn, { retry })', () => {
  it('a busy failure on attempt 1 commits on attempt 2, and the callback saw tx.attempt === 2', async () => {
    const { a, b, close } = await pair();
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      /** @type {number[]} */
      const seen = [];
      const attempt = await a.transaction(readThenWrite(a, b, (n) => n === 1, seen), { retry: { attempts: 3, baseMs: 1, maxMs: 2 } });
      assert.equal(attempt, 2);
      assert.deepEqual(seen, [1, 2]);
      assert.equal((await a.collection('docs').get('k'))?.n, 1, 'exactly one increment landed');
    }
    finally { await close(); }
  });

  it('exhausted attempts reject with the last busy failure, carrying attempts', async () => {
    const { a, b, close } = await pair();
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      /** @type {number[]} */
      const seen = [];
      await assert.rejects(a.transaction(readThenWrite(a, b, () => true, seen), { retry: { attempts: 3, baseMs: 1, maxMs: 2 } }),
        (/** @type {any} */ error) => error.class === 'busy' && error.retryable === true && error.attempts === 3);
      assert.deepEqual(seen, [1, 2, 3]);
      assert.equal((await a.collection('docs').get('k'))?.n, 0);
    }
    finally { await close(); }
  });

  it("the callback's own error, and a failure that is not retryable, surface after exactly one attempt", async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    let runs = 0;
    await assert.rejects(store.transaction(async () => { runs++; throw new Error('mine'); }, { retry: { attempts: 5 } }),
      (/** @type {any} */ error) => error.message === 'mine' && error.attempts === 1);
    assert.equal(runs, 1);
    await store.collection('docs').insert({ id: 'dup' });
    await assert.rejects(store.transaction(async (tx) => { runs++; await tx.collection('docs').insert({ id: 'dup' }); }, { retry: { attempts: 5 } }),
      (/** @type {any} */ error) => error.code === 'JD2001' && error.retryable === false && error.attempts === 1);
    assert.equal(runs, 2);
    await store.close();
  });

  it('a tracked auto-key insert that met a busy failure commits exactly one row under retry', async () => {
    const { a, b, close } = await pair();
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      // the interference counts runs, not `tx.attempt`: the first run of
      // the body meets the busy failure whatever the store calls it
      let runs = 0;
      await a.transaction(async (tx) => {
        runs += 1;
        await tx.collection('docs').get('k');
        tx.entity('Post').add({ title: 'once' });
        if (runs === 1) await b.collection('docs').put({ id: 'x', n: 0 }, 'x');
        await tx.saveChanges();
      }, { retry: { attempts: 3, baseMs: 1, maxMs: 2 } });
      assert.equal(runs, 2, 'the busy first run was retried once');
      const posts = /** @type {any[]} */ (await a.entity('Post').load());
      assert.equal(posts.length, 1, 'one row, not the restored pending insert beside the retried one');
      assert.equal(/** @type {any} */ (a.stats()).tracker.pendingInserts, 0, 'the root tracker holds nothing of it');
    }
    finally { await close(); }
  });

  it('an abort during the backoff rejects with the signal\'s reason and makes no further attempt', async () => {
    const { a, b, close } = await pair({ runtime: { random: () => 1 } });
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      /** @type {number[]} */
      const seen = [];
      const controller = new AbortController();
      const running = a.transaction(readThenWrite(a, b, () => true, seen),
        { retry: { attempts: 3, baseMs: 10_000, maxMs: 10_000 }, signal: controller.signal });
      setTimeout(() => controller.abort(new Error('stop retrying')), 100);
      await assert.rejects(running, (/** @type {any} */ error) => error.message === 'stop retrying');
      assert.deepEqual(seen, [1], 'the backoff was interrupted before attempt 2');
    }
    finally { await close(); }
  });

  it('retry cannot act where it cannot wait or would save twice (JD0014); a malformed retry is JD0013', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await assert.rejects(store.transaction(async () => {}, { retry: { attempts: 2 }, unitOfWork: 'shared' }), coded('JD0014'));
    assert.throws(() => store.sync?.transaction(() => {}, /** @type {any} */ ({ retry: { attempts: 2 } })), coded('JD0014'));
    await store.transaction(async (tx) => {
      await assert.rejects(tx.transaction(async () => {}, /** @type {any} */ ({ retry: { attempts: 2 } })), coded('JD0014'));
    });
    for (const retry of [3, { attempts: 0 }, { attempts: 33 }, { attempts: 1.5 }, { attempts: 2, baseMs: 10, maxMs: 5 },
      { attempts: 2, baseMs: -1 }, {}]) {
      await assert.rejects(store.transaction(async () => {}, /** @type {any} */ ({ retry })), coded('JD0013'), JSON.stringify(retry));
    }
    await assert.rejects(store.transaction(async () => {}, /** @type {any} */ ({ retry: { atempts: 2 } })),
      (/** @type {any} */ error) => error.code === 'JD0013' && /did you mean 'attempts'\?/.test(error.message));
    await store.close();
  });

  it('the typed client passes retry through, and its transaction client carries tx.attempt', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    assert.equal(await client.transaction(async (tx) => tx.attempt, { retry: { attempts: 2 } }), 1);
    assert.equal(await client.transaction(async (tx) => tx.attempt), 1);
    await client.close();
  });
});

const url = process.env.JAREN_PG_URL;
describe('retry on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  const schema = `jaren_retry_${process.pid}`;
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

  it('a serialization failure (40001) on attempt 1 commits on attempt 2', async () => {
    // both sessions run REPEATABLE READ, so the second writer of one row
    // after a concurrent commit fails 40001 instead of waiting
    const sessionOptions = '-c default_transaction_isolation=repeatable\\ read';
    const poolA = new pg.Pool({ connectionString: url, max: 1, options: sessionOptions });
    const poolB = new pg.Pool({ connectionString: url, max: 1, options: sessionOptions });
    const a = await openStore(MODEL, { driver: postgresDriver(poolA, { schema }) });
    const b = await openStore(MODEL, { driver: postgresDriver(poolB, { schema }) });
    try {
      await a.collection('docs').put({ id: 'k', n: 0 }, 'k');
      /** @type {number[]} */
      const seen = [];
      const attempt = await a.transaction(async (tx) => {
        seen.push(tx.attempt);
        const row = await tx.collection('docs').get('k');
        if (tx.attempt === 1) await b.collection('docs').put({ id: 'k', n: 100 }, 'k');
        await tx.collection('docs').put({ id: 'k', n: (row?.n ?? 0) + 1 }, 'k');
        return tx.attempt;
      }, { retry: { attempts: 3, baseMs: 1, maxMs: 2 } });
      assert.equal(attempt, 2);
      assert.deepEqual(seen, [1, 2]);
      assert.equal((await a.collection('docs').get('k'))?.n, 101, 'attempt 2 read the concurrent commit');
    }
    finally {
      await a.close();
      await b.close();
      await poolA.end();
      await poolB.end();
    }
  });
});
