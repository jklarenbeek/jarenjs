//@ts-check
/**
 * @file A walk over a store's items — the tables an open verifies or
 * creates, a migration's steps and links, the indexes a table holds, the
 * rows a write or a tick touches, the rules a write is judged by — holds
 * one item on the stack, however many there are. On a synchronous driver a
 * walk that recursed once per item through `chain()` overflowed the host's
 * stack (`RangeError`) at a few thousand: a model of 4096 collections did
 * not open.
 *
 * Each walk runs here over a driver that records, for every statement, the
 * depth of the stack that ran it: a statement the walk runs once per item
 * runs at one depth for every item after the first. That holds on any host,
 * whatever its stack size; the 4096-collection store checks the size itself.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';
import { jobSchedules } from '@jarenjs/db/schedules';
import { createRuntime } from '@jarenjs/core/runtime';
import { compileRecurrence, floatingValue } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { inOrder } from '../../packages/db/src/driver.js';
import { createLogicalRows } from '../../packages/db/src/logical-rows.js';
import { writeIdentityRows } from '../../packages/db/src/migration-history.js';
import { tempDbPath } from './helpers.js';

/** How many items each walk below runs over. */
const N = 40;

/** @typedef {{ sql: string, depth: number }} Ran */

/** The depth of the stack that calls this. */
const depth = () => String(new Error().stack).split('\n').length;

/** Record a statement's text and depth each time it runs. @param {any} statement @param {string} sql @param {Ran[]} ran */
const watch = (statement, sql, ran) => new Proxy(statement, { get(target, member) {
  const value = Reflect.get(target, member);
  if (typeof value !== 'function') return value;
  return ['run', 'get', 'all', 'iterate'].includes(String(member))
    ? (/** @type {any[]} */ ...args) => { ran.push({ sql, depth: depth() }); return value.apply(target, args); } : value.bind(target);
} });

/**
 * A SQLite driver that records every statement the database runs, with the
 * depth of the stack it ran at, below the store.
 * @param {Ran[]} ran
 */
const depthDriver = (ran) => ({
  name: 'node-sqlite', dialect: sqliteDialect,
  open: (/** @type {string} */ dbPath) => {
    const db = new DatabaseSync(dbPath);
    return adaptNodeDatabase({
      exec: (/** @type {string} */ sql) => { ran.push({ sql, depth: depth() }); return db.exec(sql); },
      prepare: (/** @type {string} */ sql) => watch(db.prepare(sql), sql, ran),
      function: (/** @type {string} */ name, /** @type {any} */ o, /** @type {any} */ fn) => db.function(name, o, fn),
      aggregate: (/** @type {string} */ name, /** @type {any} */ spec) => db.aggregate(name, spec),
      createSession: (/** @type {any} */ o) => (o === undefined ? db.createSession() : db.createSession(o)),
      close: () => db.close(),
    });
  },
});

/**
 * No statement run once per item or more — its text with every number in
 * it read as one (`"c7"` as `"c#"`) — runs deeper item by item:
 * a walk that recursed per item ran each item's statements at a depth of
 * their own, where one that holds one item runs them at the few depths the
 * statement's other callers run it at. At least one such statement ran.
 * @param {Ran[]} ran @param {string} label
 */
function flat(ran, label) {
  /** @type {Map<string, number[]>} */
  const byText = new Map();
  for (const { sql, depth: at } of ran) {
    const text = sql.replace(/\d+/g, '#');
    byText.set(text, [...(byText.get(text) ?? []), at]);
  }
  const walked = [...byText].filter(([, depths]) => depths.length >= N);
  assert.ok(walked.length > 0, `${label}: no statement ran once per item`);
  for (const [text, depths] of walked) {
    const distinct = new Set(depths).size;
    assert.ok(distinct < N / 4, `${label}: '${text.slice(0, 90)}' ran ${depths.length} times at ${distinct} depths, ${Math.min(...depths)} to ${Math.max(...depths)}`);
  }
}

const range = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i);
const LOG = { identity: 'integer', schema: { type: 'object' } };
const collections = (/** @type {number} */ n) => ({ $model: '0.1', collections: Object.fromEntries(range(n).map((i) => [`c${i}`, LOG])) });

/** @type {number} */
let limit;
before(() => { limit = Error.stackTraceLimit; Error.stackTraceLimit = Infinity; });
after(() => { Error.stackTraceLimit = limit; });

describe('inOrder', () => {
  it('runs each item in order and answers null without a promise when every item answers a value', () => {
    const seen = [];
    assert.equal(inOrder(5, (i) => { seen.push(i); return i * 2; }), null);
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
    assert.equal(inOrder(0, () => { throw new Error('never'); }), null);
  });

  it('holds one item on the stack over 100000 items', () => {
    const depths = new Set();
    assert.equal(inOrder(100000, (i) => { if (i % 1000 === 1) depths.add(depth()); return null; }), null);
    assert.equal(depths.size, 1);
  });

  it('resumes from a promise an item answers, and runs the next item once it settles', async () => {
    const seen = [];
    let settled = false;
    const out = inOrder(5, (i) => {
      seen.push(i === 3 ? `3 after ${settled}` : i);
      if (i === 2) return new Promise((resolve) => setTimeout(() => { settled = true; resolve('ignored'); }, 1));
      return null;
    });
    assert.ok(out instanceof Promise);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(await out, null);
    assert.deepEqual(seen, [0, 1, 2, '3 after true', 4]);
  });

  it('stops at an item that throws, and throws it', () => {
    const seen = [];
    assert.throws(() => inOrder(5, (i) => { seen.push(i); if (i === 2) throw new RangeError('item 2'); return null; }), /item 2/);
    assert.deepEqual(seen, [0, 1, 2]);
  });

  it('stops at an item whose promise rejects, and rejects with it', async () => {
    const seen = [];
    await assert.rejects(Promise.resolve(inOrder(5, (i) => {
      seen.push(i);
      return i === 1 ? Promise.resolve() : i === 3 ? Promise.reject(new RangeError('item 3')) : null;
    })), /item 3/);
    assert.deepEqual(seen, [0, 1, 2, 3]);
  });
});

describe('a walk over a store\'s items holds one item on the stack', () => {
  it('an open creating and verifying every collection, and introspect() reading every table', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      /** @type {Ran[]} */
      const ran = [];
      await (await openStore(collections(N), { driver: depthDriver(ran), path: dbPath })).close();
      flat(ran, 'create');
      const store = await openStore(collections(N), { driver: depthDriver([]), path: dbPath });
      try { assert.equal(Object.keys((await store.introspect()).model.collections).length, N); }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('an open creating every entity, and every index of a table', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const entity = { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' } } } };
      const indexed = { identity: 'integer', schema: { type: 'object', properties: Object.fromEntries(range(N).map((i) => [`m${i}`, { type: 'string' }])) },
        indexes: range(N).map((i) => ({ name: `i${i}`, path: `$.m${i}` })) };
      const model = { $model: '0.1', collections: { indexed }, entities: Object.fromEntries(range(N).map((i) => [`E${i}`, entity])) };
      /** @type {Ran[]} */
      const created = [];
      await (await openStore(model, { driver: depthDriver(created), path: dbPath })).close();
      flat(created.filter(({ sql }) => !sql.includes('"indexed"')), 'entities');
      flat(created.filter(({ sql }) => sql.includes('"indexed"')), 'indexes created');
      const store = await openStore(model, { driver: depthDriver([]), path: dbPath });
      try { assert.equal((await store.introspect()).model.collections.indexed.indexes.length, N); }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('a migration\'s steps, the collections it verifies, and a chain of links', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(collections(1), { driver: nodeDriver(), path: dbPath })).close();
      const { migration } = planModelMigration(collections(1), collections(N), { dialect: sqliteDialect, id: 'add' });
      /** @type {Ran[]} */
      const ran = [];
      await migrate({ driver: depthDriver(ran), path: dbPath }, [migration], { baseline: collections(1), model: collections(N), shadow: false });
      flat(ran, 'steps');
      const model = collections(N);
      const links = range(N).map((k) => planModelMigration(model, model, { dialect: sqliteDialect, id: `link${k}` }).migration);
      const again = links.map((link, k) => ({ ...link, id: `again${k}` }));
      for (const [atomic, chain] of /** @type {const} */ ([[true, [migration, ...links]], [false, [migration, ...links, ...again]]])) {
        /** @type {Ran[]} */
        const chained = [];
        const outcome = await migrate({ driver: depthDriver(chained), path: dbPath }, chain, { baseline: collections(1), model, shadow: false, atomic });
        assert.equal(outcome.applied.length, N);
        flat(chained, atomic ? 'links in one transaction' : 'links one by one');
      }
    }
    finally { cleanup(); }
  });

  it('a write naming every key of a many-to-many relation', async () => {
    const model = { $model: '0.1', entities: {
      Item: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
        tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
      Tag: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
    } };
    /** @type {Ran[]} */
    const ran = [];
    const store = await openStore(model, { driver: depthDriver(ran) });
    try {
      const tags = range(N).map((i) => `t${i}`);
      for (const name of tags) await store.entity('Tag').create({ name });
      ran.length = 0;
      await store.entity('Item').create({ id: 'i', tags });
      flat(ran, 'memberships');
      const [item] = await store.entity('Item').asNoTracking().load({ include: { tags: true } });
      assert.equal(item.tags.length, N);
    }
    finally { await store.close(); }
  });

  it('rekey() over every row another provider keyed', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const temporals = storeTemporals();
    const doc = { $model: '0.1', collections: { ev: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id',
      temporals: [{ name: 'z', path: '$.z', kind: 'zoned', policy: 'rfc5545' }], indexes: [{ name: 'by_z', path: '$.z' }] } } };
    /** @type {Ran[]} */
    const ran = [];
    const older = await openStore(doc, { driver: nodeDriver(), temporals, path: dbPath, zoneProvider: createIntlZoneProvider({ revision: 'test-a' }) });
    const current = await openStore(doc, { driver: depthDriver(ran), temporals, path: dbPath, zoneProvider: createIntlZoneProvider({ revision: 'test-b' }) });
    try {
      for (const i of range(N)) await older.collection('ev').put({ id: `e${i}`, z: { kind: 'zoned', date: '2026-10-25', time: '02:30', zone: 'Europe/Amsterdam' } });
      ran.length = 0;
      assert.equal(await current.collection('ev').rekey(), N);
      flat(ran, 'rekey');
    }
    finally { await current.close(); await older.close(); cleanup(); }
  });

  it('a tick over every due schedule, and over every occurrence one schedule catches up', async () => {
    const HOUR = 3600000;
    for (const shape of ['due', 'catch-up']) {
      const clock = { at: Date.UTC(2026, 2, 1, 12) };
      const now = () => clock.at;
      /** @type {Ran[]} */
      const ran = [];
      const store = await openStore(collections(1), { driver: depthDriver(ran),
        runtime: createRuntime({ zoneProvider: createIntlZoneProvider({ revision: 'r' }), now }), jobs: { now, random: () => 0, schedules: jobSchedules() } });
      try {
        if (shape === 'due') {
          const hourly = compileRecurrence({ dtstart: floatingValue('2026-03-01', '13:00'), rrule: 'FREQ=HOURLY' });
          for (const i of range(N)) await store.jobs.schedule({ id: `s${i}`, kind: 'k', series: hourly, zone: 'UTC', missed: 'once' });
          clock.at += 2 * HOUR;
          ran.length = 0;
          assert.equal((await store.jobs.tick({ limit: N })).fired.length, 2 * N);
        }
        else {
          const minutely = compileRecurrence({ dtstart: floatingValue('2026-03-01', '12:01'), rrule: 'FREQ=MINUTELY' });
          await store.jobs.schedule({ id: 'm', kind: 'k', series: minutely, zone: 'UTC', missed: { catchUp: N } });
          clock.at += (N + 1) * 60000;
          ran.length = 0;
          assert.equal((await store.jobs.tick()).fired.length, N + 1);
        }
        flat(ran, shape);
      }
      finally { await store.close(); }
    }
  });

  it('a write judged by every store invariant that probes another entity', async () => {
    const model = { $model: '0.1', entities: {
      Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } } },
      Line: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, parent: { type: 'integer' } } },
        invariants: range(N).map((i) => ({ name: `r${i}`, on: ['insert'], enforcement: 'store',
          assert: { '$exists-row': { entity: 'Doc', match: { id: '$.new.parent' } } } })) },
    } };
    /** @type {Ran[]} */
    const ran = [];
    const store = await openStore(model, { driver: depthDriver(ran) });
    try {
      await store.entity('Doc').create({ id: 1 });
      ran.length = 0;
      await store.entity('Line').create({ id: 1, parent: 1 });
      flat(ran, 'invariants');
      await assert.rejects(store.entity('Line').create({ id: 2, parent: 9 }), { code: 'JD2096', message: /'r0' rejected/ });
    }
    finally { await store.close(); }
  });

  it('a replica\'s emptiness over every table, and the identity rows a history writes', () => {
    /** @type {Ran[]} */
    const ran = [];
    const statement = (/** @type {string} */ sql) => ({ run: () => { ran.push({ sql, depth: depth() }); return { changes: 1 }; },
      get: () => { ran.push({ sql, depth: depth() }); return undefined; }, all: () => [], finalize() {} });
    const connection = { dialect: sqliteDialect, prepare: statement };
    assert.equal(createLogicalRows(/** @type {any} */ ({ connection, shapes: new Map(range(N).map((i) => [`t${i}`, {}])) })).empty(), true);
    flat(ran, 'empty');
    ran.length = 0;
    let checked = 0;
    assert.equal(writeIdentityRows(connection, range(N).map((i) => ({ key: `receipt:${i}`, value: '{}' })), () => { checked++; }), null);
    assert.equal(checked, N);
    flat(ran, 'identity rows');
  });
});

describe('a store of many items', () => {
  // the open verifies a table's indexes from one catalog read, so no statement
  // runs per index: the count itself is the check, under SQLite's 2000 columns
  it('a table of 1900 indexes opens again, and is introspected', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const indexes = 1900;
      const model = { $model: '0.1', collections: { indexed: { identity: 'integer',
        schema: { type: 'object', properties: Object.fromEntries(range(indexes).map((i) => [`m${i}`, { type: 'string' }])) },
        indexes: range(indexes).map((i) => ({ name: `i${i}`, path: `$.m${i}` })) } } };
      await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      try { assert.equal((await store.introspect()).model.collections.indexed.indexes.length, indexes); }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('a store of 4096 collections opens, creating every table and verifying every table, and is introspected whole', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = collections(4096);
      await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      try {
        const key = await store.collection('c4095').insert({ n: 1 });
        assert.deepEqual(await store.collection('c4095').get(key), { n: 1 });
        assert.equal(Object.keys((await store.introspect()).model.collections).length, 4096);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});
