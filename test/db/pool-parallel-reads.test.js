//@ts-check
/**
 * @file Parallel root reads on the pool host (MODEL-FORMAT §5.1, HOSTS.md):
 * a Store opened with `reads: 'parallel'` admits its classified root reads
 * on the pool's readers, each in a read transaction of its own — one
 * committed snapshot — instead of the one gate every other call takes.
 * Two long reads overlap in time, a write commits while both run, and
 * neither sees the write's rows until a read that begins after its commit.
 * A cursor holds one read across its pulls and gives it back when it
 * settles. Without the option nothing changes; on a host without readers
 * the option is JD0009; tracked reads and writes keep the gate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    items: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' }, text: { type: 'string' } } },
    },
  },
  entities: {
    Part: {
      schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, label: { type: 'string' } } },
    },
  },
};

/** Enough rows that a full scan keeps a reader busy for a while. */
const SEED = 20000;
/** A full scan that matches only the row a write adds: `undefined` (no
 * item) before it commits, the row itself after. */
const SCAN = '$[?@.n < 0]';
const MARKER = { id: 'marker', n: -1, text: 'written while the reads ran' };

/**
 * A pool driver whose connection records, per parallel read, when it
 * began (its reader taken, its read transaction open) and when it ended.
 * @param {any} [configuration]
 */
function instrumentedPool(configuration = { readers: 2 }) {
  const base = nodeWorkerPoolDriver(configuration);
  /** @type {{ raw: any, windows: { start: number, end: number }[] }} */
  const state = { raw: null, windows: [] };
  const driver = {
    ...base,
    open: async (/** @type {any[]} */ ...args) => {
      const raw = await base.open(...args);
      state.raw = raw;
      if (raw.shared === null) return raw;
      const shared = raw.shared;
      return Object.freeze(Object.defineProperties({
        ...raw,
        shared: (/** @type {any} */ fn, /** @type {any} */ what, /** @type {any} */ signal, /** @type {any} */ held) =>
          shared((/** @type {any} */ enter) => {
            const window = { start: performance.now(), end: Infinity };
            state.windows.push(window);
            return Promise.resolve(fn(enter)).finally(() => { window.end = performance.now(); });
          }, what, signal, held),
      }, { mustQueue: { get: () => raw.mustQueue } }));
    },
  };
  return { driver, state };
}

/**
 * A store on a fresh file, seeded with `SEED` items.
 * @param {any} driver @param {any} [options]
 */
async function seeded(driver, options = {}) {
  const { dbPath, cleanup } = tempDbPath();
  const seed = await openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 1 }), path: dbPath });
  await seed.transaction(async (tx) => {
    const items = tx.collection('items');
    for (let n = 0; n < SEED; n++) await items.put({ id: `k${String(n).padStart(6, '0')}`, n, text: 'x'.repeat(32) });
    await tx.entity('Part').create({ id: 'p1', label: 'first' });
  });
  await seed.close();
  const store = await openStore(MODEL, { driver, path: dbPath, ...options });
  return { store, dbPath, close: async () => { await store.close(); cleanup(); } };
}

/** A transaction held open with the marker written and not committed. */
function heldWrite(/** @type {any} */ store) {
  /** @type {() => void} */
  let commit = () => {};
  /** @type {() => void} */
  let written = () => {};
  const open = new Promise((resolve) => { written = () => resolve(undefined); });
  const release = new Promise((resolve) => { commit = () => resolve(undefined); });
  const settled = store.transaction(async (/** @type {any} */ tx) => {
    await tx.collection('items').put(MARKER);
    await tx.entity('Part').update('p1', { label: 'changed' });
    written();
    await release;
  });
  return { open, commit, settled };
}

const readersActive = (/** @type {any} */ raw) => raw.metrics().workers.filter((/** @type {any} */ w) => w.readOnly && w.active).length;
const overlap = (/** @type {any} */ a, /** @type {any} */ b) => a.start < b.end && b.start < a.end;

describe('parallel root reads on the pool host', () => {
  it('two long reads overlap, a write commits inside both, neither sees its rows', { timeout: 60000 }, async () => {
    const { driver, state } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel' });
    try {
      assert.equal(store.capabilities.parallelReads, 'parallel');
      const items = store.collection('items');
      // two one-shot scans, issued together, run at once on the two readers
      state.windows.length = 0;
      const [a, b] = await Promise.all([items.execute(SCAN), items.execute(SCAN)]);
      assert.deepEqual([a, b], [undefined, undefined]);
      assert.equal(state.windows.length, 2);
      assert.ok(overlap(state.windows[0], state.windows[1]),
        `the two scans overlap: ${JSON.stringify(state.windows)}`);

      // two streamed reads hold their readers while a write commits
      const write = heldWrite(store);
      await write.open;
      state.windows.length = 0;
      const first = items.query('$[*]');
      const second = items.query('$[*]');
      const heads = [await first.next(), await second.next()];
      assert.deepEqual(heads.map((step) => step.value.id), ['k000000', 'k000000']);
      assert.equal(readersActive(state.raw), 2, 'both reads hold a reader at once');
      // the open transaction's rows are not committed: no read sees them
      write.commit();
      await write.settled;
      const committedAt = performance.now();
      const counts = [];
      for (const cursor of [first, second]) {
        let count = 1;
        for await (const doc of cursor) {
          assert.notEqual(doc.id, MARKER.id, 'a read that began before the commit never sees its row');
          count++;
        }
        counts.push(count);
      }
      assert.deepEqual(counts, [SEED, SEED]);
      assert.equal(state.windows.length, 2);
      assert.ok(overlap(state.windows[0], state.windows[1]), 'the streamed reads overlap');
      for (const window of state.windows)
        assert.ok(window.start < committedAt && committedAt < window.end, 'the commit lands inside both reads');
      assert.equal(readersActive(state.raw), 0, 'an exhausted cursor gives its reader back');
      // a read that begins after the commit sees it
      assert.deepEqual(await items.execute(SCAN), MARKER);
      assert.equal((await items.all()).length, SEED + 1);
    }
    finally { await close(); }
  });

  it('a root read runs while a transaction holds the writer, on the committed state', { timeout: 60000 }, async () => {
    const { driver } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel', transactions: 'strict' });
    try {
      const items = store.collection('items');
      const parts = store.entity('Part');
      const write = heldWrite(store);
      await write.open;
      // classified reads neither wait for the open transaction nor see it
      assert.equal(await items.get(MARKER.id), undefined);
      assert.equal(await items.execute(SCAN), undefined);
      assert.equal((await parts.asNoTracking().get('p1')).label, 'first');
      assert.equal(await store.execute('$.Part[*].label'), 'first');
      // `transactions: 'strict'` keeps its meaning for the exclusive path
      await assert.rejects(items.put({ id: 'late', n: 1, text: '' }), { code: 'JD0012' });
      await assert.rejects(parts.get('p1'), { code: 'JD0012' }, 'a tracked read keeps the gate');
      write.commit();
      await write.settled;
      assert.equal((await parts.asNoTracking().get('p1')).label, 'changed');
      assert.equal((await parts.get('p1')).label, 'changed');
    }
    finally { await close(); }
  });

  it('a tracked read waits for the open transaction, as every exclusive call does', { timeout: 60000 }, async () => {
    const { driver } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel' });
    try {
      const write = heldWrite(store);
      await write.open;
      let tracked = false;
      const read = store.entity('Part').get('p1').then((/** @type {any} */ part) => { tracked = true; return part; });
      assert.equal((await store.entity('Part').asNoTracking().get('p1')).label, 'first');
      assert.equal(tracked, false, 'the tracked read is still queued behind the transaction');
      write.commit();
      assert.equal((await read).label, 'changed');
    }
    finally { await close(); }
  });

  it('a cursor gives its reader back when released, aborted or closed with the store', { timeout: 60000 }, async () => {
    const { driver, state } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel' });
    try {
      const items = store.collection('items');
      const released = items.query('$[*]');
      await released.next();
      assert.equal(readersActive(state.raw), 1);
      await released.return();
      assert.equal(readersActive(state.raw), 0);
      assert.deepEqual(await released.next(), { done: true, value: undefined });

      const controller = new AbortController();
      const aborted = items.query('$[*]', { signal: controller.signal });
      await aborted.next();
      controller.abort();
      await assert.rejects(aborted.next(), { code: 'JD2072' });
      assert.equal(readersActive(state.raw), 0);

      // `break` releases through return()
      for await (const doc of items.query('$[*]')) { assert.ok(doc.id); break; }
      assert.equal(readersActive(state.raw), 0);

      // a buffered cursor gives its reader back once its first pull filled
      // the buffer: an external that cannot bind diverts to the engine
      const diverted = items.query({ $for: { it: '$[*]' }, $where: { $eq: ['$it.n', '$flag'] }, $return: '$it.id' },
        { externals: { flag: true } });
      assert.equal(diverted.streaming, 'buffered');
      assert.equal((await diverted.next()).done, true);
      assert.equal(readersActive(state.raw), 0);
    }
    finally { await close(); }
    // a store closed with a cursor holding a read closes without waiting it out
    const again = instrumentedPool();
    const { store: open, close: closeAgain } = await seeded(again.driver, { reads: 'parallel' });
    const held = open.collection('items').query('$[*]');
    await held.next();
    assert.equal(readersActive(again.state.raw), 1);
    const started = performance.now();
    await closeAgain();
    assert.ok(performance.now() - started < 2500, 'close gives the held read back instead of waiting out the pool grace');
    // and the stream it cut short refuses its next pull rather than ending as though it were complete
    await assert.rejects(held.next(), { code: 'JD2063' });
    await assert.rejects(held.next(), { code: 'JD2063' });
    assert.deepEqual(await held.return(), { done: true, value: undefined });
  });

  it('a point read borrows the free writer while every reader is held', { timeout: 60000 }, async () => {
    for (const reads of ['serialized', 'parallel']) {
      const { driver, state } = instrumentedPool();
      const { store, close } = await seeded(driver, { reads });
      try {
        const items = store.collection('items');
        const cursors = [items.query('$[*]'), items.query('$[*]')];
        for (const cursor of cursors) await cursor.next();
        assert.equal(readersActive(state.raw), 2, `${reads}: both readers held`);
        assert.equal((await items.get('k000007')).n, 7, `${reads}: the get is served`);
        assert.equal((await store.entity('Part').asNoTracking().get('p1')).label, 'first');
        for (const cursor of cursors) await cursor.return();
      }
      finally { await close(); }
    }
  });

  it('root collection.get is classified read-only and runs on a reader', { timeout: 60000 }, async () => {
    for (const reads of ['serialized', 'parallel']) {
      const { driver, state } = instrumentedPool();
      const { store, close } = await seeded(driver, { reads });
      try {
        const executions = () => state.raw.metrics().workers.map((/** @type {any} */ w) => w.executions);
        const before = executions();
        assert.equal((await store.collection('items').get('k000042')).n, 42);
        const after = executions();
        const moved = after.map((count, i) => count - before[i]);
        assert.equal(moved[0], 0, `${reads}: the writer ran nothing`);
        assert.ok(moved.slice(1).some((count) => count > 0), `${reads}: a reader ran the get`);
      }
      finally { await close(); }
    }
  });

  it('one parallel read is one snapshot across its statements', { timeout: 60000 }, async () => {
    const { dbPath, cleanup } = tempDbPath();
    const pool = await nodeWorkerPoolDriver({ readers: 2 }).open(dbPath);
    const other = await nodeDriver().open(dbPath);
    try {
      await pool.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)');
      const count = async () => (await (await pool.prepare('SELECT count(*) AS n FROM t', { readOnly: true })).get()).n;
      const [inside, outside] = [[], []];
      await pool.shared(async () => {
        inside.push(await count());
        // another connection commits between the read's two statements
        other.exec('INSERT INTO t VALUES (2)');
        inside.push(await count());
      });
      outside.push(await count());
      other.exec('INSERT INTO t VALUES (3)');
      outside.push(await count());
      assert.deepEqual(inside, [1, 1], 'both statements of the read see the snapshot it began on');
      assert.deepEqual(outside, [2, 3], 'outside a parallel read each statement sees the latest commit');
    }
    finally {
      await other.close();
      await pool.close();
      cleanup();
    }
  });

  it('a cursor asks the owner lease before every pull, and renews it as a gated pull does', { timeout: 60000 }, async () => {
    const lease = 600000;
    let clock = Date.now();
    const { driver } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel', owner: { id: 'reader', leaseMs: lease },
      runtime: { now: () => clock } });
    try {
      const cursor = store.collection('items').query('$[*]');
      let rows = 0;
      for (let i = 0; i < 3; i++) { await cursor.next(); rows++; }
      // past the lease on the store's own clock: the next pull renews it first
      clock += lease + 1;
      for await (const doc of cursor) { assert.ok(doc.id); rows++; }
      assert.equal(rows, SEED, 'every row arrives after the renewal');
    }
    finally { await close(); }
  });

  it('a pull refused before it reached the source leaves the cursor and its read for the next pull', { timeout: 60000 }, async () => {
    const lease = 600000;
    let clock = Date.now();
    const { driver, state } = instrumentedPool({ readers: 1 });
    const { store, close } = await seeded(driver, { reads: 'parallel', owner: { id: 'reader', leaseMs: lease },
      runtime: { now: () => clock } });
    try {
      const items = store.collection('items');
      const holder = items.query('$[*]');
      await holder.next(); // the only reader
      const late = items.query(SCAN);
      // admitted under a good lease, the pull waits for the reader; the lease
      // lapses meanwhile, so the check inside the read refuses it
      const refused = late.next().then(() => 'answered', (error) => error.code);
      await new Promise((resolve) => setTimeout(resolve, 50));
      clock += lease + 1;
      await holder.return();
      assert.equal(await refused, 'JD2061');
      clock -= lease + 1;
      // a stranger's transaction holds the writer with a row not yet committed:
      // the cursor's next pull reads its own committed snapshot, never that row
      const write = heldWrite(store);
      await write.open;
      assert.deepEqual(await late.next(), { done: true, value: undefined });
      write.commit();
      await write.settled;
      assert.equal(readersActive(state.raw), 0, 'the read went back when the cursor was done');
    }
    finally { await close(); }
  });

  it('a transaction started from inside a parallel read — a host function that writes — is refused by name (JD0014)', { timeout: 60000 }, async () => {
    /** @type {{ store?: any, attempt?: Promise<string> }} */
    const holder = {};
    const touch = (/** @type {any} */ value) => {
      holder.attempt ??= holder.store.collection('items').patch('k000001', [{ op: 'replace', path: '/text', value: 'changed' }])
        .then(() => 'written', (/** @type {any} */ error) => error.code);
      return value;
    };
    const { driver } = instrumentedPool();
    const { store, close } = await seeded(driver, { reads: 'parallel', functions: { touch } });
    holder.store = store;
    try {
      await store.collection('items').execute({ $for: { it: '$[?@.n < 3]' }, $return: { $call: ['touch', '$it.n'] } });
      assert.equal(await holder.attempt, 'JD0014', 'the write neither joins the read nor runs on its reader');
      assert.equal((await store.collection('items').get('k000001')).text, 'x'.repeat(32));
    }
    finally { await close(); }
  });

  it('a statement left behind by a parallel read that has ended is refused, not run on its reader', { timeout: 60000 }, async () => {
    const { dbPath, cleanup } = tempDbPath();
    const pool = await nodeWorkerPoolDriver({ readers: 1 }).open(dbPath);
    try {
      await pool.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)');
      /** @type {Promise<any>} */
      let late = Promise.resolve();
      const answered = await pool.shared(async () => {
        // work the read sets going and does not await: it outlives the read
        late = new Promise((resolve) => setTimeout(resolve, 20))
          .then(async () => (await pool.prepare('SELECT n FROM t', { readOnly: true })).get());
        return (await (await pool.prepare('SELECT n FROM t', { readOnly: true })).get()).n;
      });
      assert.equal(answered, 1);
      await assert.rejects(late, (error) => error.code === 'JD2090' && error.retryable === false
        && /parallel read that had ended/.test(error.message));
      // the reader it held serves the next read as usual
      assert.equal((await pool.shared(async () => (await (await pool.prepare('SELECT n FROM t', { readOnly: true })).get()).n)), 1);
    }
    finally {
      await pool.close();
      cleanup();
    }
  });

  it('without the option nothing changes: root reads wait for the open transaction', { timeout: 60000 }, async () => {
    const { driver } = instrumentedPool();
    const { store, close } = await seeded(driver);
    try {
      assert.equal(store.capabilities.parallelReads, 'serialized');
      const write = heldWrite(store);
      await write.open;
      let answered = false;
      const read = store.collection('items').get(MARKER.id).then((/** @type {any} */ doc) => { answered = true; return doc; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(answered, false, 'the serialized read waits for the commit');
      write.commit();
      assert.deepEqual(await read, MARKER);
    }
    finally { await close(); }
  });

  it("refuses reads: 'parallel' where there are no readers, naming the host (JD0009)", { timeout: 60000 }, async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, reads: 'parallel' }),
        (error) => error.code === 'JD0009' && /'node-sqlite' has no readers/.test(error.message));
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerDriver(), path: dbPath, reads: 'parallel' }),
        (error) => error.code === 'JD0009' && /has no readers/.test(error.message));
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 0 }), path: dbPath, reads: 'parallel' }),
        (error) => error.code === 'JD0009' && /has no readers for this open/.test(error.message));
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 2 }), path: ':memory:', reads: 'parallel' }),
        (error) => error.code === 'JD0009' && /has no readers for this open/.test(error.message));
      await assert.rejects(openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 2 }), path: dbPath, reads: 'yes' }),
        (error) => error.code === 'JD0009' && /'serialized' or 'parallel'/.test(error.message));
      // an explicit 'serialized' is today's behaviour on every host
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, reads: 'serialized' });
      assert.equal(store.capabilities.parallelReads, 'serialized');
      await store.close();
      // every worker of a read-only pool is a reader, so one opened with readers: 0 reads in parallel
      const readOnly = await openStore(MODEL, { driver: nodeWorkerPoolDriver({ readers: 0 }), path: dbPath,
        readOnly: true, reads: 'parallel' });
      assert.equal(readOnly.capabilities.parallelReads, 'parallel');
      assert.equal(await readOnly.collection('items').get('missing'), undefined);
      await readOnly.close();
    }
    finally { cleanup(); }
  });
});
