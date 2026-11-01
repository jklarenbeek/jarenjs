//@ts-check
/**
 * @file A root cursor's turn for the event loop (MODEL-FORMAT §5.1). On an
 * in-thread (synchronous) driver every pull of a root cursor settles in
 * microtasks, so no timer, I/O callback or immediate runs until the cursor
 * ends; `yieldEvery: { rows, ms }` asks for one macrotask before a pull,
 * outside the gate. A worker host turns the loop at every pull already and
 * accepts the option to no effect; a transaction's cursor and the
 * synchronous twin refuse it by name. Counted, never timed: an immediate
 * that reschedules itself counts the loop turns a read lets through, and an
 * async hook counts the immediates a read schedules.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { openStore } from '@jarenjs/db';
import { sql, relational } from '@jarenjs/db/relational';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { statementCountingDriver, tempDbPath } from './helpers.js';

const ROWS = 20001;
const c = (/** @type {string} */ name) => sql.column(name);
const TABLE_DOC = { from: 't', columns: { id: c('id'), name: c('name') } };
const T_DOC = { $for: { it: '$.T[*]' }, $return: '$it' };
const BIG_MODEL = {
  $model: '0.1',
  entities: {
    T: {
      schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, name: { type: 'string' } } },
      physical: { table: 't', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'reject' } } },
    },
  },
};
const SMALL_MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, key: '/id', indexes: [] },
  },
  entities: {
    Item: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, tag: { type: 'string' } } } },
  },
};
const DOCS = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' };
const ITEMS = { $for: { it: '$.Item[*]' }, $orderby: ['$it.id'], $return: '$it' };
const ITEM_ROWS = { from: 'Item', columns: { id: c('id') }, orderBy: [{ by: c('id') }] };

/** Every root cursor of the asynchronous store, opened with `options`. */
const ROOT_CURSORS = {
  'collection.query': (/** @type {any} */ store, /** @type {any} */ options) => store.collection('docs').query(DOCS, options),
  'entity.cursor': (/** @type {any} */ store, /** @type {any} */ options) => store.entity('Item').cursor(ITEMS, options),
  'entity.loadCursor': (/** @type {any} */ store, /** @type {any} */ options) =>
    store.entity('Item').loadCursor({ orderBy: '$it.id' }, options),
  'relational.iterate': (/** @type {any} */ store, /** @type {any} */ options) => store.relational.iterate(ITEM_ROWS, options),
  'jobs.page': (/** @type {any} */ store, /** @type {any} */ options) => store.jobs.page({ limit: 1000, ...options }),
};
/** How each root cursor spells itself in a refusal. */
const SPELLINGS = {
  'collection.query': "collection('docs').query",
  'entity.cursor': 'entity cursor()',
  'entity.loadCursor': "entity('Item').loadCursor",
  'relational.iterate': 'relational',
  'jobs.page': 'jobs.page',
};

/** @param {any} cursor */
const drain = async (cursor) => {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
};
/** @param {any} cursor */
const idsOf = async (cursor) => (await drain(cursor)).map((row) => row.id);

/** Read to the end while an immediate that reschedules itself counts the
 * loop turns the read lets through.
 * @template T @param {() => Promise<T>} read @returns {Promise<{ result: T, turns: number }>} */
async function turnsDuring(read) {
  let turns = 0;
  let reading = true;
  const spin = () => {
    if (!reading) return;
    turns++;
    setImmediate(spin);
  };
  setImmediate(spin);
  try {
    const result = await read();
    return { result, turns };
  }
  finally { reading = false; }
}

/** Read to the end while an async hook counts the immediates scheduled.
 * @template T @param {() => Promise<T>} read @returns {Promise<{ result: T, scheduled: number }>} */
async function scheduledDuring(read) {
  let scheduled = 0;
  const hook = createHook({ init(_id, type) { if (type === 'Immediate') scheduled++; } });
  hook.enable();
  try {
    const result = await read();
    return { result, scheduled };
  }
  finally { hook.disable(); }
}

/** A value or the code it refused with, whether the call threw or rejected.
 * @param {() => any} call */
const settle = async (call) => {
  try { return { value: await call() }; }
  catch (error) { return { code: /** @type {any} */ (error).code, message: /** @type {any} */ (error).message }; }
};

/** A file of `ROWS` rows in table `t`, adopted by a store on the driver
 * `makeDriver` makes. @param {() => any} makeDriver */
async function bigStore(makeDriver) {
  const { dbPath, cleanup } = tempDbPath();
  const seed = await nodeDriver().open(dbPath);
  seed.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL '
    + `SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO t SELECT i, printf('row %d', i) FROM n;`);
  seed.close();
  try {
    const store = await openStore(BIG_MODEL, { driver: makeDriver(), path: dbPath, adopt: true });
    return { store, close: async () => { try { await store.close(); } finally { cleanup(); } } };
  }
  catch (error) { cleanup(); throw error; }
}

/** Fifty documents, entities and jobs, on a store that counts its driver
 * steps when `counters` is given. @param {any} [counters] @param {any} [options] */
async function smallStore(counters = undefined, options = {}) {
  const driver = counters === undefined ? nodeDriver() : statementCountingDriver(counters);
  const store = await openStore(SMALL_MODEL, { driver, jobs: true, ...options });
  await store.transaction(async (tx) => {
    for (let n = 0; n < 50; n++) {
      const id = String(n).padStart(2, '0');
      await tx.collection('docs').put({ id: `d${id}` }, `d${id}`);
      await tx.entity('Item').create({ id: n + 1, tag: `t${n + 1}` });
      await tx.jobs.enqueue('kind', { n }, { id: `j${id}` });
    }
  });
  if (counters !== undefined) for (const key of Object.keys(counters)) counters[key] = 0;
  return store;
}

describe('an in-thread root cursor gives the event loop a turn only when asked', () => {
  /** @type {any} */
  let big;
  before(async () => { big = await bigStore(nodeDriver); });
  after(async () => { await big?.close(); });

  it('store.relational.iterate: no immediate runs during the read without yieldEvery, one per 1000 rows with it, the same rows', async () => {
    const { store } = big;
    const plain = await turnsDuring(() => idsOf(store.relational.iterate(TABLE_DOC)));
    assert.equal(plain.result.length, ROWS);
    assert.equal(plain.turns, 0, 'every pull settles in microtasks: the loop does not turn until the cursor ends');
    const paced = await turnsDuring(() => idsOf(store.relational.iterate(TABLE_DOC, { yieldEvery: { rows: 1000 } })));
    assert.equal(paced.turns, 20, 'a turn before the pull after every 1000 rows delivered: 20,001 rows give 20');
    assert.deepEqual(paced.result, plain.result, 'the same rows, in the same order');
    const scheduled = await scheduledDuring(() => idsOf(store.relational.iterate(TABLE_DOC, { yieldEvery: { rows: 1000 } })));
    assert.equal(scheduled.scheduled, 20, 'one macrotask per turn, and nothing else');
    const unpaced = await scheduledDuring(() => idsOf(store.relational.iterate(TABLE_DOC)));
    assert.equal(unpaced.scheduled, 0, 'the default schedules nothing');
    const timed = await turnsDuring(() => idsOf(store.relational.iterate(TABLE_DOC, { yieldEvery: { ms: 1 } })));
    assert.ok(timed.turns > 0, `a ${ROWS}-row read outlasts 1 ms, so the clock asks for turns (${timed.turns})`);
    assert.deepEqual(timed.result, plain.result);
  });

  it('the entity root cursor: the same, and a tracked cursor too', async () => {
    const { store } = big;
    const plain = await turnsDuring(() => idsOf(store.entity('T').cursor(T_DOC)));
    assert.equal(plain.result.length, ROWS);
    assert.equal(plain.turns, 0);
    const paced = await turnsDuring(() => idsOf(store.entity('T').cursor(T_DOC, { yieldEvery: { rows: 1000 } })));
    assert.equal(paced.turns, 20);
    assert.deepEqual(paced.result, plain.result);
    const tracked = await turnsDuring(() => idsOf(store.entity('T').cursor(T_DOC, { tracking: true, yieldEvery: { rows: 5000 } })));
    assert.equal(tracked.turns, 4, 'a tracked cursor is admitted through the unit of work, paced alike');
    assert.deepEqual(tracked.result, plain.result);
  });

  it('every root cursor reads the one spelling: a turn per `rows` items, the same items', async () => {
    const store = await smallStore();
    try {
      for (const [surface, open] of Object.entries(ROOT_CURSORS)) {
        const plain = await turnsDuring(() => drain(open(store, undefined)));
        assert.equal(plain.result.length, 50, surface);
        assert.equal(plain.turns, 0, `${surface}: no turn by default`);
        const paced = await turnsDuring(() => drain(open(store, { yieldEvery: { rows: 10 } })));
        assert.equal(paced.turns, 5, `${surface}: 50 items, a turn after every 10 (the last before the pull that ends it)`);
        assert.deepEqual(paced.result, plain.result, surface);
        const both = await turnsDuring(() => drain(open(store, { yieldEvery: { rows: 25, ms: 60_000 } })));
        assert.equal(both.turns, 2, `${surface}: rows and ms together, whichever comes first`);
        const ended = open(store, { yieldEvery: { rows: 1 } });
        assert.equal((await drain(ended)).length, 50);
        const past = await scheduledDuring(async () => [await ended.next(), await ended.next()]);
        assert.deepEqual(past, { result: [{ done: true, value: undefined }, { done: true, value: undefined }], scheduled: 0 },
          `${surface}: a pull past the end delivers no item, so it asks for no turn`);
      }
    }
    finally { await store.close(); }
  });

  it('a host without setImmediate (an in-thread wasm driver in a browser) takes each turn as a zero timeout', async () => {
    const store = await smallStore();
    const immediate = globalThis.setImmediate;
    try {
      const plain = await drain(store.relational.iterate(ITEM_ROWS));
      let timeouts = 0;
      const hook = createHook({ init(_id, type) { if (type === 'Timeout') timeouts++; } });
      /** @type {any} */ (globalThis).setImmediate = undefined;
      hook.enable();
      let paced;
      try { paced = await drain(store.relational.iterate(ITEM_ROWS, { yieldEvery: { rows: 10 } })); }
      finally {
        hook.disable();
        globalThis.setImmediate = immediate;
      }
      assert.equal(timeouts, 5, 'one timeout per turn');
      assert.deepEqual(paced, plain);
    }
    finally {
      globalThis.setImmediate = immediate;
      await store.close();
    }
  });

  it('a store call made during a turn runs between two pulls, the gate free even on a strict store', async () => {
    const store = await smallStore(undefined, { transactions: 'strict' });
    try {
      for (const yieldEvery of [undefined, { rows: 1 }]) {
        let delivered = 0;
        /** @type {any} */
        let outcome = null;
        for await (const row of store.relational.iterate(ITEM_ROWS, yieldEvery === undefined ? undefined : { yieldEvery })) {
          delivered++;
          if (row.id !== 2) continue;
          setImmediate(() => {
            const at = delivered;
            settle(() => store.relational.get({ from: 'Item', columns: { n: sql.call('count', []) } }))
              .then((settled) => { outcome = { at, n: settled.value?.n, code: settled.code }; });
          });
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(outcome, { at: yieldEvery === undefined ? 50 : 2, n: 50, code: undefined },
          yieldEvery === undefined ? 'without a turn the call waits for the cursor to end' : 'served at the next turn, between pulls 2 and 3');
      }
    }
    finally { await store.close(); }
  });
});

describe('an abort or return() during a turn closes the cursor as during a pull', () => {
  it('return() waits for the pull already asked for, then releases the statement once, on every root cursor', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await smallStore(counters);
    try {
      for (const [surface, open] of Object.entries(ROOT_CURSORS)) {
        const outcomes = [];
        for (const yieldEvery of [undefined, { rows: 2 }]) {
          const cursor = open(store, yieldEvery === undefined ? undefined : { yieldEvery });
          const delivered = [(await cursor.next()).done, (await cursor.next()).done];
          const steps = counters.next;
          const releases = counters.return;
          // with the option this pull waits for its turn; without it, it is in flight
          const pending = cursor.next();
          const returned = await cursor.return();
          const pulled = await pending;
          outcomes.push({ delivered, pulled: pulled.done, returned, after: await cursor.next(),
            steps: counters.next - steps, releases: counters.return - releases });
        }
        assert.deepEqual(outcomes[1], outcomes[0], `${surface}: the turn changes nothing a return does`);
        assert.deepEqual(outcomes[0].pulled, false, `${surface}: the pull asked for first delivers its item`);
        assert.deepEqual(outcomes[0].after, { done: true, value: undefined }, surface);
      }
    }
    finally { await store.close(); }
  });

  it('a row-streaming cursor: one more row stepped, one release, in both cases', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await smallStore(counters);
    try {
      for (const yieldEvery of [undefined, { rows: 2 }]) {
        const cursor = store.relational.iterate(ITEM_ROWS, yieldEvery === undefined ? undefined : { yieldEvery });
        await cursor.next();
        await cursor.next();
        const before = { next: counters.next, return: counters.return };
        const pending = cursor.next();
        await cursor.return();
        const pulled = await pending;
        assert.deepEqual({ done: pulled.done, value: { ...pulled.value } }, { done: false, value: { id: 3 } });
        assert.deepEqual({ next: counters.next - before.next, return: counters.return - before.return }, { next: 1, return: 1 },
          `yieldEvery ${JSON.stringify(yieldEvery)}`);
      }
    }
    finally { await store.close(); }
  });

  it('an abort releases the statement at once and the pull waiting for its turn refuses JD2072, on every root cursor', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await smallStore(counters);
    try {
      for (const [surface, open] of Object.entries(ROOT_CURSORS)) {
        const outcomes = [];
        for (const yieldEvery of [undefined, { rows: 2 }]) {
          const controller = new AbortController();
          const cursor = open(store, { signal: controller.signal, ...(yieldEvery === undefined ? {} : { yieldEvery }) });
          await cursor.next();
          await cursor.next();
          const steps = counters.next;
          const releases = counters.return;
          const pending = cursor.next();
          controller.abort();
          const released = counters.return - releases;
          const pulled = await settle(() => pending);
          const later = await settle(() => cursor.next());
          outcomes.push({ released, pulled: pulled.code, later: later.code, steps: counters.next - steps,
            releases: counters.return - releases });
        }
        assert.deepEqual(outcomes[1], outcomes[0], `${surface}: the turn changes nothing an abort does`);
        assert.deepEqual([outcomes[0].pulled, outcomes[0].later, outcomes[0].steps], ['JD2072', 'JD2072', 0], surface);
      }
    }
    finally { await store.close(); }
  });
});

describe('yieldEvery is refused where it is malformed or where no turn can be given', () => {
  it('a malformed value refuses JD0013 before any statement, on every root cursor', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await smallStore(counters);
    try {
      const cases = [
        [5, "option 'yieldEvery' must be an object naming rows, ms or both"],
        [null, "option 'yieldEvery' must be an object naming rows, ms or both"],
        [[1000], "option 'yieldEvery' must be an object naming rows, ms or both"],
        [{}, "option 'yieldEvery' must name rows, ms or both"],
        [{ row: 10 }, "option 'yieldEvery.row' is not one it reads — did you mean 'rows'?"],
        [{ rows: 10, every: 1 }, "option 'yieldEvery.every' is not one it reads; the options are rows, ms"],
        [{ rows: 0 }, "option 'yieldEvery.rows' must be a whole number of items from 1"],
        [{ rows: 1.5 }, "option 'yieldEvery.rows' must be a whole number of items from 1"],
        [{ rows: '10' }, "option 'yieldEvery.rows' must be a whole number of items from 1"],
        [{ ms: 0 }, "option 'yieldEvery.ms' must be a positive finite number of milliseconds"],
        [{ ms: -5 }, "option 'yieldEvery.ms' must be a positive finite number of milliseconds"],
        [{ ms: Infinity }, "option 'yieldEvery.ms' must be a positive finite number of milliseconds"],
        [{ ms: Number.NaN }, "option 'yieldEvery.ms' must be a positive finite number of milliseconds"],
      ];
      for (const [surface, open] of Object.entries(ROOT_CURSORS)) {
        const ran = { ...counters };
        for (const [yieldEvery, rule] of cases) {
          assert.throws(() => open(store, { yieldEvery }),
            { code: 'JD0013', message: `JD0013: ${SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (surface)]} ${rule}` },
            `${surface} ${JSON.stringify(yieldEvery)}`);
        }
        assert.deepEqual(counters, ran, `${surface}: refused before any statement`);
        assert.equal((await drain(open(store, { yieldEvery: undefined }))).length, 50, `${surface}: undefined is no option`);
      }
    }
    finally { await store.close(); }
  });

  it("a transaction's cursor and the synchronous twin refuse it by name (JD0013), as they refused it before", async () => {
    const store = await smallStore();
    const only = "option 'yieldEvery' is read by a root cursor of the asynchronous store only: a synchronous cursor "
      + "answers values, and a transaction's cursor runs inside a scope that holds the connection until it settles";
    const yieldEvery = { rows: 1 };
    try {
      await store.transaction(async (tx) => {
        for (const [surface, open] of Object.entries(ROOT_CURSORS)) {
          if (surface === 'jobs.page') continue; // administration is a root call only
          assert.throws(() => open(tx, { yieldEvery }),
            { code: 'JD0013', message: `JD0013: ${SPELLINGS[/** @type {keyof typeof SPELLINGS} */ (surface)]} ${only}` }, `tx ${surface}`);
        }
        assert.equal((await drain(tx.relational.iterate(ITEM_ROWS))).length, 50, 'and reads without it as before');
      });
      const twin = store.sync;
      assert.throws(() => twin.relational.iterate(ITEM_ROWS, { yieldEvery }), { code: 'JD0013', message: `JD0013: relational ${only}` });
      assert.throws(() => twin.entity('Item').cursor(ITEMS, { yieldEvery }), { code: 'JD0013', message: `JD0013: entity cursor() ${only}` });
      assert.throws(() => twin.entity('Item').loadCursor({ orderBy: '$it.id' }, { yieldEvery }),
        { code: 'JD0013', message: `JD0013: entity('Item').loadCursor ${only}` });
      await store.transaction((tx) => {
        assert.throws(() => tx.sync.relational.iterate(ITEM_ROWS, { yieldEvery }), { code: 'JD0013', message: `JD0013: relational ${only}` });
        assert.throws(() => tx.sync.entity('Item').cursor(ITEMS, { yieldEvery }), { code: 'JD0013' });
      });
    }
    finally { await store.close(); }
    const db = await nodeDriver().open(':memory:');
    try {
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
      const engine = relational(db);
      assert.throws(() => engine.iterate({ from: 't', columns: { id: c('id') } }, { yieldEvery }),
        { code: 'JD0013', message: `JD0013: relational ${only}` }, 'the bare engine over a synchronous connection');
      engine.dispose();
    }
    finally { db.close(); }
  });

  it('explain takes a cursor call\'s options; execute and the whole-result reads keep refusing it by name', async () => {
    const store = await smallStore();
    try {
      const options = { yieldEvery: { rows: 10 } };
      assert.deepEqual(await store.collection('docs').explain(DOCS, options), await store.collection('docs').explain(DOCS));
      assert.deepEqual(await store.entity('Item').explain(ITEMS, options), await store.entity('Item').explain(ITEMS));
      for (const [what, call] of /** @type {[string, () => any][]} */ ([
        ["collection('docs').execute", () => store.collection('docs').execute(DOCS, options)],
        ['entity execute()', () => store.entity('Item').execute(ITEMS, options)],
        ['relational', () => store.relational.all(ITEM_ROWS, options)],
      ])) {
        const refused = await settle(call);
        assert.equal(refused.code, 'JD0013', what);
        assert.match(String(refused.message), new RegExp(`^JD0013: ${what.replace(/[()]/g, '\\$&')} option 'yieldEvery' is not one it reads`), what);
      }
    }
    finally { await store.close(); }
  });
});

describe('a worker host accepts yieldEvery and changes nothing', () => {
  it('the same rows, and the cursor schedules no macrotask: every pull already awaits the worker', async () => {
    const { store, close } = await bigStore(nodeWorkerDriver);
    try {
      const plain = await idsOf(store.relational.iterate(TABLE_DOC));
      assert.equal(plain.length, ROWS);
      for (const read of [
        () => idsOf(store.relational.iterate(TABLE_DOC, { yieldEvery: { rows: 1 } })),
        () => idsOf(store.entity('T').cursor(T_DOC, { yieldEvery: { rows: 1, ms: 1 } })),
      ]) {
        const paced = await scheduledDuring(read);
        assert.equal(paced.scheduled, 0, 'no turn is added where the loop already turns');
        assert.deepEqual(paced.result, plain);
      }
    }
    finally { await close(); }
  });
});

const url = process.env.JAREN_PG_URL;
// a packed consumer inherits the variable but installs no PostgreSQL client
const pgClient = url ? await import('pg').then(() => true, () => false) : false;
describe('PostgreSQL accepts yieldEvery and changes nothing', {
  skip: (!url && 'JAREN_PG_URL is not set') || (!pgClient && 'the pg client is not installed') }, () => {
  it('the relational and entity root cursors read the same rows, and the cursor adds no turn', async () => {
    const pg = (await import('pg')).default;
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    const schema = `jaren_root_yield_${process.pid}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const store = await openStore({ $model: '0.1', entities: { Item: SMALL_MODEL.entities.Item } },
        { driver: postgresDriver(pool, { schema }) });
      try {
        await store.transaction(async (tx) => {
          for (let n = 1; n <= 50; n++) await tx.entity('Item').create({ id: n, tag: `t${n}` });
        });
        for (const open of [
          (/** @type {any} */ options) => store.relational.iterate(ITEM_ROWS, options),
          (/** @type {any} */ options) => store.entity('Item').cursor(ITEMS, options),
        ]) {
          const plain = await scheduledDuring(() => drain(open(undefined)));
          const paced = await scheduledDuring(() => drain(open({ yieldEvery: { rows: 1 } })));
          assert.equal(plain.result.length, 50);
          assert.deepEqual(paced.result, plain.result);
          assert.equal(paced.scheduled, plain.scheduled, 'no turn added: every pull already awaits the server');
        }
      }
      finally { await store.close(); }
    }
    finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally {
        await admin.end();
        await pool.end();
      }
    }
  });
});
