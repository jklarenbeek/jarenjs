//@ts-check
/**
 * @file The store, the job queue and the migration runner over the
 * runtime record (`@jarenjs/core/runtime`): every member is read only
 * where the subsystem has no explicit option for it (`jobs.now`,
 * `jobs.random` and `zoneProvider` win), the record propagates from the
 * store to the job engine it constructs, a `zoneProvider: null` record
 * leaves a named zone the refusal it was, and — the reason the record
 * exists — one record with a fixed clock, a seeded source and a counting
 * identifier makes a run spanning the http binding, the store, a job
 * cycle and a migration byte-identical twice over.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openStore, migrate, planMigration, sqliteDialect, HISTORY_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createRuntime } from '@jarenjs/core/runtime';
import { mulberry32 } from '@jarenjs/core/random';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { tempDbPath, statementCountingDriver } from './helpers.js';
import { load, shopHandlers, jsonReq } from '../contract/helpers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MODEL = {
  $model: '0.1',
  collections: {
    notes: { schema: { type: 'object' }, key: null, identity: 'uuid' },
  },
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          email: { type: 'string' },
          created: { type: 'string', format: 'date-time', 'x-entity': { default: 'now' } },
        },
      },
    },
  },
};

const M0 = {
  $model: '0.1',
  collections: {
    users: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id', indexes: [] },
  },
};
const M1 = {
  $model: '0.1',
  collections: {
    users: M0.collections.users,
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};

const shop = compileContract(load('./fixtures/shop.contract.json'));
const SAVE = { revision: 1, product: { id: 1, name: 'x', price: 1 } };
const SAVE_URL = '/api/products/1/master';

/** A counting identifier. */
function counter(prefix) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A mutable clock. */
function clockAt(start) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
}

/** The `applied_at` stamps of a migration history, read raw. */
function appliedStamps(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT id, applied_at AS at FROM "${HISTORY_TABLE}" ORDER BY applied_at, id`).all()
      .map((row) => ({ id: String(row.id), at: Number(row.at) }));
  }
  finally {
    db.close();
  }
}

describe('the store over the runtime record', () => {
  it('allocates uuid keys and entity defaults from the record', async () => {
    const T = 1_700_000_000_000;
    const runtime = createRuntime({ uuid: counter('key'), now: () => T });
    const store = await openStore(MODEL, { driver: nodeDriver(), runtime });
    assert.strictEqual(await store.collection('notes').insert({ text: 'a' }), 'key-1');
    const user = await store.entity('User').create({ email: 'ada@example.test' });
    assert.strictEqual(user.id, 'key-2');
    assert.strictEqual(user.created, new Date(T).toISOString());
    await store.close();
  });

  it('allocates from the platform with no record, as it always did', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const before = Date.now();
    assert.match(String(await store.collection('notes').insert({ text: 'a' })), UUID_V4);
    const user = await store.entity('User').create({ email: 'ada@example.test' });
    assert.match(user.id, UUID_V4);
    const created = Date.parse(user.created);
    assert.ok(created >= before - 1000 && created <= Date.now());
    await store.close();
  });

  it('stamps a capture delivery with the record\'s clock', async () => {
    const runtime = createRuntime({ now: () => 4_242 });
    const store = await openStore(MODEL, {
      driver: nodeDriver(), capture: { log: { retention: 1000 } }, runtime,
    });
    await store.collection('notes').insert({ text: 'a' });
    const page = await store.changes.page({ after: 0 });
    assert.strictEqual(page.items.length, 1);
    assert.strictEqual(page.items[0].at, 4_242);
    await store.close();
  });

  it('refuses a malformed record where it was passed', () => {
    assert.throws(() => openStore(MODEL, { driver: nodeDriver(), runtime: /** @type {any} */ ({ clock: Date.now }) }),
      /a runtime record has 'now', 'uuid', 'random', 'zoneProvider', not 'clock'/);
    assert.throws(() => openStore(MODEL, { driver: nodeDriver(), runtime: /** @type {any} */ ({ uuid: 'x' }) }),
      /runtime\.uuid is a function/);
  });
});

describe('the job queue over the runtime record', () => {
  const open = (options) => openStore(MODEL, { driver: nodeDriver(), ...options });

  /** Enqueue, claim and fail one job; the stamps the clock and the source left. */
  async function cycle(store) {
    const id = await store.jobs.enqueue('mail', { to: 'ada' });
    const created = await store.jobs.get(id);
    const claimed = await store.jobs.claim({ kinds: ['mail'], owner: 'w' });
    await store.jobs.fail(claimed.lease, new Error('boom'));
    const failed = await store.jobs.get(id);
    return { id, token: claimed.lease.token, createdAt: created.createdAt, backoff: failed.runAt - failed.updatedAt };
  }

  it('lets explicit jobs.now and jobs.random win over the record (precedence, both directions)', async () => {
    // both: the explicit option wins
    const both = await open({
      jobs: { now: () => 5_000, random: () => 0 },
      runtime: createRuntime({ now: () => 9_000, random: () => 1 }),
    });
    const a = await cycle(both);
    assert.strictEqual(a.createdAt, 5_000);
    assert.strictEqual(a.backoff, 500, 'base 1000 × (0.5 + 0/2), the explicit source');
    await both.close();
    // only the record: the record wins over the platform
    const record = await open({ jobs: true, runtime: createRuntime({ now: () => 9_000, random: () => 1 }) });
    const b = await cycle(record);
    assert.strictEqual(b.createdAt, 9_000);
    assert.strictEqual(b.backoff, 1_000, 'base 1000 × (0.5 + 1/2), the record\'s source');
    await record.close();
    // neither: the platform
    const plain = await open({ jobs: true });
    const before = Date.now();
    const c = await cycle(plain);
    assert.ok(c.createdAt >= before && c.createdAt <= Date.now());
    assert.ok(c.backoff >= 500 && c.backoff <= 1_000, `${c.backoff} is base 1000 jittered by Math.random`);
    assert.match(c.id, UUID_V4);
    assert.match(c.token, UUID_V4);
    await plain.close();
  });

  it('propagates the record from the store to the engine it constructs: ids and lease tokens', async () => {
    const store = await open({ jobs: true, runtime: createRuntime({ uuid: counter('job'), now: () => 1 }) });
    const a = await cycle(store);
    assert.strictEqual(a.id, 'job-1', 'the job id is the record\'s');
    assert.strictEqual(a.token, 'job-2', 'the lease token is the record\'s');
    await store.close();
  });
});

describe('the migration runner over the runtime record', () => {
  const chain = () => [planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-add-events' }).migration];

  it('stamps an applied migration with the record\'s clock, the platform\'s with none', async () => {
    const stamped = tempDbPath();
    const plain = tempDbPath();
    try {
      const out = await migrate({ driver: nodeDriver(), path: stamped.dbPath }, chain(),
        { baseline: M0, runtime: createRuntime({ now: () => 7_777 }) });
      assert.deepStrictEqual(out.applied, ['0001-add-events']);
      assert.deepStrictEqual(appliedStamps(stamped.dbPath), [{ id: '0001-add-events', at: 7_777 }]);

      const before = Date.now();
      await migrate({ driver: nodeDriver(), path: plain.dbPath }, chain(), { baseline: M0 });
      const [row] = appliedStamps(plain.dbPath);
      assert.ok(row.at >= before && row.at <= Date.now());
    }
    finally {
      stamped.cleanup();
      plain.cleanup();
    }
  });

  it('refuses a malformed record before touching the database', () => {
    const target = tempDbPath();
    try {
      assert.throws(() => migrate({ driver: nodeDriver(), path: target.dbPath }, chain(),
        { baseline: M0, runtime: /** @type {any} */ ({ now: 'later' }) }), /runtime\.now is a function/);
    }
    finally {
      target.cleanup();
    }
  });
});

describe('the zone provider over the runtime record', () => {
  const provider = createIntlZoneProvider();

  it('reads the record\'s provider only where the explicit option is absent', async () => {
    const fromRecord = await openStore(MODEL, { driver: nodeDriver(), runtime: createRuntime({ zoneProvider: provider }) });
    assert.strictEqual(fromRecord.capabilities.zoneProvider, true);
    await fromRecord.close();
    // an explicit `null` is a deliberate none, and wins over the record
    const explicitNone = await openStore(MODEL, {
      driver: nodeDriver(), zoneProvider: null, runtime: createRuntime({ zoneProvider: provider }),
    });
    assert.strictEqual(explicitNone.capabilities.zoneProvider, false);
    await explicitNone.close();
    const explicit = await openStore(MODEL, { driver: nodeDriver(), zoneProvider: provider, runtime: createRuntime() });
    assert.strictEqual(explicit.capabilities.zoneProvider, true);
    await explicit.close();
  });

  it('leaves a named zone the refusal it was under a null record and under no record', async () => {
    const nullRecord = await openStore(MODEL, { driver: nodeDriver(), runtime: createRuntime({ zoneProvider: null }) });
    const none = await openStore(MODEL, { driver: nodeDriver() });
    assert.strictEqual(nullRecord.capabilities.zoneProvider, false);
    assert.strictEqual(none.capabilities.zoneProvider, false);
    await nullRecord.close();
    await none.close();
  });

  it('never hands the record itself to query compilation: only the provider crosses', () => {
    for (const file of ['packages/db/src/query.js', 'packages/db/src/residual.js', 'packages/db/src/cursor.js']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.ok(!source.includes('core/runtime'), `${file} imports the runtime record`);
      assert.ok(!/\bruntime\.(now|uuid|random)\b/.test(source), `${file} reads a runtime member`);
    }
  });
});

describe('deterministic_run_is_byte_identical', () => {
  /**
   * One run across the four subsystems, under a runtime the caller
   * builds: everything the run observes is returned as one JSON string.
   * @param {() => any} buildRuntime
   */
  async function run(buildRuntime) {
    const runtime = buildRuntime();
    const out = [];

    // the http binding: a trace per request and a ledger claim per key —
    // the ledger is given the SAME record (its uuid mints each generation)
    const ledger = createMemoryLedger({ runtime });
    const server = serveHttp(shop, shopHandlers(), { ledger, runtime });
    const first = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k' }));
    const replay = await server.dispatch(jsonReq('PUT', SAVE_URL, SAVE, { 'idempotency-key': 'k' }));
    out.push({ status: first.status, trace: first.headers['x-jaren-trace'], body: first.body });
    out.push({ replayed: replay.headers['idempotent-replayed'], trace: replay.headers['x-jaren-trace'] });
    out.push(ledger.lookup({ op: 'product.save', scope: '', key: 'k' }));

    // the store: keys, entity defaults, the capture log
    const store = await openStore(MODEL, {
      driver: nodeDriver(), jobs: true, capture: { log: { retention: 1000 } }, runtime,
    });
    const notes = store.collection('notes');
    out.push(await notes.insert({ text: 'one' }), await notes.insert({ text: 'two' }));
    out.push(await store.entity('User').create({ email: 'ada@example.test' }));

    // a job: enqueue, claim, fail (jittered backoff), claim again, settle
    runtime.now.advance?.(11);
    const id = await store.jobs.enqueue('mail', { to: 'ada' });
    const held = await store.jobs.claim({ kinds: ['mail'], owner: 'w' });
    runtime.now.advance?.(3);
    await store.jobs.fail(held.lease, new Error('boom'));
    out.push(await store.jobs.get(id));
    runtime.now.advance?.(60_000);
    const again = await store.jobs.claim({ kinds: ['mail'], owner: 'w' });
    out.push(again.lease);
    await store.jobs.complete(again.lease, { sent: true });
    out.push(await store.jobs.get(id));
    out.push(await store.changes.page({ after: 0 }));
    await store.close();

    // a migration, stamped
    const target = tempDbPath();
    try {
      const applied = await migrate({ driver: nodeDriver(), path: target.dbPath },
        [planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-add-events' }).migration],
        { baseline: M0, runtime });
      out.push(applied.applied, appliedStamps(target.dbPath));
    }
    finally {
      target.cleanup();
    }
    return JSON.stringify(out);
  }

  /** The record a reproducible run is configured with, once. */
  const reproducible = () => createRuntime({
    now: clockAt(1_700_000_000_000),
    uuid: counter('u'),
    random: mulberry32(2026),
    zoneProvider: createIntlZoneProvider(),
  });

  it('two runs under one record are byte-identical across contract, store, jobs and migrations', async () => {
    const a = await run(reproducible);
    const b = await run(reproducible);
    assert.strictEqual(a, b);
    assert.ok(a.includes('"u-1"') && a.includes('1700000000000'), 'the record\'s identifiers and clock are in the output');
    assert.ok(a.length > 1000, `${a.length} bytes of observed output`);
  });

  it('and the test is load-bearing: with only the clock fixed, two runs differ', async () => {
    // the platform's identifiers and source are what make a run unique;
    // the clock alone is fixed so the backoff still passes
    const clockOnly = () => createRuntime({ now: clockAt(1_700_000_000_000) });
    const a = await run(clockOnly);
    const b = await run(clockOnly);
    assert.notStrictEqual(a, b);
  });
});

describe('a query deadline over the runtime record', () => {
  const MODEL_D = {
    $model: '0.1',
    collections: { docs: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' } },
    entities: {
      Item: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' } } } },
    },
  };
  const codeIs = (code, pattern = undefined) => (error) =>
    error.code === code && (pattern === undefined || pattern.test(error.message));

  it('compares a deadline against the record\'s clock: eligible at 0, refused before a statement or a row once the clock passes it', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const now = clockAt(0);
    const store = await openStore(MODEL_D, {
      driver: statementCountingDriver(counters), runtime: createRuntime({ now }),
    });
    store.sync.transaction(() => {
      for (let i = 1; i <= 3; i++) {
        store.sync.collection('docs').insert({ id: `d${i}` });
        store.sync.entity('Item').create({ id: i, n: i });
      }
    });
    for (const key of Object.keys(counters)) counters[key] = 0;
    const items = { $for: { it: '$.Item[*]' }, $return: '$it' };
    const docs = { $for: { it: '$[*]' }, $return: '$it' };

    // the platform clock is far past 10; the record's clock says 0 — the call is eligible
    assert.ok(Date.now() > 10);
    assert.strictEqual((await store.entity('Item').execute(items, { deadline: 10 })).length, 3);
    assert.strictEqual((await store.collection('docs').execute(docs, { deadline: 10 })).length, 3);
    const entityCursor = store.entity('Item').cursor(items, { deadline: 10 });
    const collectionCursor = store.collection('docs').query(docs, { deadline: 10 });
    const loadCursor = store.entity('Item').loadCursor({}, { deadline: 10 });
    assert.strictEqual((await entityCursor.next()).done, false);
    assert.strictEqual((await collectionCursor.next()).done, false);
    assert.strictEqual((await loadCursor.next()).done, false);
    const page = await store.entity('Item').page({}, { deadline: 10 });
    assert.strictEqual(page.items.length, 3);

    // the record's clock advances past the deadline: refused before a statement…
    now.advance(11);
    const statementsBefore = counters.iterate + counters.all;
    assert.throws(() => store.entity('Item').execute(items, { deadline: 10 }), codeIs('JD2075', /passed before the call ran/));
    assert.throws(() => store.collection('docs').execute(docs, { deadline: 10 }), codeIs('JD2075', /passed before the call ran/));
    assert.throws(() => store.entity('Item').cursor(items, { deadline: 10 }), codeIs('JD2075'));
    assert.throws(() => store.collection('docs').query(docs, { deadline: 10 }), codeIs('JD2075'));
    assert.throws(() => store.entity('Item').loadCursor({}, { deadline: 10 }), codeIs('JD2075'));
    await assert.rejects(async () => store.entity('Item').page({}, { deadline: 10 }), codeIs('JD2075'));
    assert.strictEqual(counters.iterate + counters.all, statementsBefore, 'no statement was issued for a passed deadline');
    // …and before another row on the cursors already open, each released at its row boundary
    const returnsBefore = counters.return;
    await assert.rejects(() => entityCursor.next(), codeIs('JD2075', /passed before the next row/));
    await assert.rejects(() => collectionCursor.next(), codeIs('JD2075', /passed before the next row/));
    await assert.rejects(() => loadCursor.next(), codeIs('JD2075', /passed before the next row/));
    assert.strictEqual(counters.return, returnsBefore + 3, 'each open statement released once');
    await store.close();
  });

  it('reads the platform clock with no record, as it always did', async () => {
    const store = await openStore(MODEL_D, { driver: nodeDriver() });
    assert.throws(() => store.entity('Item').cursor({ $for: { it: '$.Item[*]' }, $return: '$it' }, { deadline: Date.now() - 1 }),
      codeIs('JD2075'));
    // an empty set answers `undefined` (the engine's result shape); the point is that a live deadline is not refused
    assert.strictEqual(await store.entity('Item').execute({ $for: { it: '$.Item[*]' }, $return: '$it' }, { deadline: Date.now() + 60_000 }), undefined);
    await store.close();
  });

  it('reads the clock from the store state only: no platform clock in the query engine or the cursor', () => {
    for (const file of ['packages/db/src/query.js', 'packages/db/src/cursor.js']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.ok(!/\bDate\.now\(\)/.test(source), `${file} calls the platform clock`);
    }
    const cursor = readFileSync(new URL('../../packages/db/src/cursor.js', import.meta.url), 'utf8');
    assert.ok(!cursor.includes('Date.now'), 'the cursor names no platform clock at all: the clock arrives in its spec');
  });
});
