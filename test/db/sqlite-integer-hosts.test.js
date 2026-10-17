//@ts-check
/**
 * @file Every SQLite host reads a stored 64-bit integer through one decoder:
 * an integer a double holds exactly (2^53 + 2, 2^60, -2^62: every integer the
 * store writes) reads back as that number on each read — a point read, a
 * graph load, a native projection — and one a number would round
 * (9007199254740993) is refused `JD2003`, class `data`, with node:sqlite's
 * own refusal as its cause. The hosts: node:sqlite, the Node worker, the
 * worker pool, the child process and sqlite-wasm. bun:sqlite runs the same
 * corpus in a file of its own. Change capture reads a changeset's integer
 * by the same rule.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import init from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { integerColumns, decodeIntegers, decodeRunResult, decodingIterator }
  from '../../packages/db/src/drivers/sqlite-integers.js';
import { tempDbPath } from './helpers.js';
import { checkIntegerReads } from './oracle/integer-reads.js';

/** @type {any} */
let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });

/** A host over a file a second `node:sqlite` connection writes beside it.
 * @param {() => any} driver */
const fileHost = (driver) => async () => {
  const { dbPath, cleanup } = tempDbPath();
  try {
    await checkIntegerReads((model) => openStore(model, { driver: driver(), path: dbPath }), (sql) => {
      const db = new DatabaseSync(dbPath);
      try { db.exec(sql); }
      finally { db.close(); }
    });
  }
  finally { cleanup(); }
};

/** sqlite-wasm in memory, written through the database the handle opened. */
const wasmHost = async () => {
  /** @type {any} */
  let opened = null;
  class Kept extends sqlite3.oo1.DB {
    /** @param {any[]} args */
    constructor(...args) { super(...args); opened = this; }
  }
  await checkIntegerReads((model) => openStore(model, { driver: wasmDriver(sqlite3Handle(sqlite3, { DbClass: Kept })) }),
    (sql) => opened.exec(sql));
};

const HOSTS = /** @type {[string, () => Promise<void>][]} */ ([
  ['node:sqlite', fileHost(() => nodeDriver())],
  ['the Node worker', fileHost(() => nodeWorkerDriver())],
  ['the worker pool', fileHost(() => nodeWorkerPoolDriver())],
  ['the child process', fileHost(() => nodeProcessDriver())],
  ['sqlite-wasm', wasmHost],
]);

describe('a stored integer past ±(2^53 - 1) on every SQLite host', () => {
  for (const [name, host] of HOSTS) {
    it(`reads back exactly where a double holds it and is refused where it would round, on ${name}`, async () => {
      await host();
    });
  }
});

describe('the node:sqlite binding', () => {
  it('reads a statement\'s integers as numbers, a write that returns rows reporting its counts as numbers', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      connection.exec('CREATE TABLE "t" ("v" INTEGER, "s" TEXT)');
      const insert = await connection.prepare('INSERT INTO "t" VALUES (?, ?) RETURNING "v"');
      assert.deepEqual({ ...await insert.run([2 ** 60, 'a']) }, { changes: 1, lastInsertRowid: 1 });
      const read = await connection.prepare('SELECT "v", "s", rowid AS "r" FROM "t"');
      assert.deepEqual({ ...await read.get([]) }, { v: 2 ** 60, s: 'a', r: 1 });
      const rows = [];
      for await (const row of await read.iterate([])) rows.push({ ...row });
      assert.deepEqual(rows, [{ v: 2 ** 60, s: 'a', r: 1 }]);
    }
    finally { await connection.close(); }
  });
});

describe('the sqlite-wasm binding', () => {
  it('reports a write\'s row id as a number', async () => {
    const connection = await wasmDriver(sqlite3Handle(sqlite3)).open(':memory:');
    try {
      connection.exec('CREATE TABLE "t" ("v" INTEGER)');
      const insert = await connection.prepare('INSERT INTO "t" VALUES (?)');
      assert.deepEqual({ ...await insert.run([2 ** 60]) }, { changes: 1, lastInsertRowid: 1 });
      const read = await connection.prepare('SELECT "v" FROM "t"');
      assert.deepEqual({ ...await read.get([]) }, { v: 2 ** 60 });
    }
    finally { await connection.close(); }
  });
});

describe('the shared decoder', () => {
  it('names the columns that can hand back an integer by their declared affinity', () => {
    assert.deepEqual(integerColumns([
      { name: 'a', type: 'INTEGER' }, { name: 'b', type: 'TEXT' }, { name: 'c', type: 'REAL' },
      { name: 'd', type: null }, { name: 'e', type: 'BLOB' }, { name: 'f', type: 'NUMERIC' },
      { name: 'g', type: 'VARCHAR(10)' }, { name: 'h', type: 'DOUBLE PRECISION' }, { name: 'i', type: 'FLOATING POINT' },
      { name: 'j', type: '' }, { name: 'k', type: 'ANY' }, { name: 'l', type: 'BIGINT' }]),
    ['a', 'd', 'e', 'f', 'i', 'j', 'k', 'l']);
  });

  it('reads an integer a double holds exactly as that number and refuses any other', () => {
    const row = { a: 2n ** 60n, b: -(2n ** 53n) - 2n, c: 7n, d: 'text', e: 1.5 };
    assert.deepEqual(decodeIntegers(row, ['a', 'b', 'c', 'd', 'e']), { a: 2 ** 60, b: -(2 ** 53) - 2, c: 7, d: 'text', e: 1.5 });
    assert.equal(decodeIntegers(undefined, ['a']), undefined);
    for (const value of [2n ** 53n + 1n, -(2n ** 53n) - 1n, 2n ** 60n + 24n, 2n ** 63n - 1n]) {
      assert.throws(() => decodeIntegers({ a: value }, ['a']), (error) => {
        assert.deepEqual({ code: error.code, message: error.message },
          { code: 'ERR_OUT_OF_RANGE', message: `Value is too large to be represented as a JavaScript number: ${value}` });
        return true;
      });
    }
  });

  it('reads a write\'s counts as numbers', () => {
    assert.deepEqual(decodeRunResult({ changes: 1n, lastInsertRowid: 2n ** 60n }), { changes: 1, lastInsertRowid: 2 ** 60 });
    const counts = { changes: 1, lastInsertRowid: 2 };
    assert.equal(decodeRunResult(counts), counts);
  });

  it('decodes each row an iterator yields and closes the iterator it wraps', () => {
    let closed = 0;
    const rows = [{ v: 1n }, { v: 2n ** 60n }];
    const inner = { next: () => (rows.length > 0 ? { done: false, value: rows.shift() } : { done: true, value: undefined }),
      return: () => { closed++; return { done: true, value: undefined }; } };
    const iterator = decodingIterator(/** @type {any} */ (inner), ['v']);
    assert.deepEqual(iterator.next(), { done: false, value: { v: 1 } });
    assert.deepEqual([...iterator], [{ v: 2 ** 60 }]);
    assert.deepEqual(iterator.return?.(undefined), { done: true, value: undefined });
    assert.equal(closed, 1);
    assert.deepEqual(decodingIterator(/** @type {any} */ ({ next: () => ({ done: true, value: undefined }) }), []).return?.(5),
      { done: true, value: 5 });
  });
});

describe('a changeset\'s integer', () => {
  it('is read by the same rule: exactly where a double holds it, refused where it would round', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const model = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' }, w: { type: 'integer' } } } } } };
    try {
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath, capture: { mode: 'session' } });
      try {
        /** @type {any[]} */
        const records = [];
        store.observe((/** @type {any} */ record) => records.push(record.patch));
        // a trigger the store does not know writes the integer the changeset carries
        const db = new DatabaseSync(dbPath);
        db.exec('CREATE TRIGGER "t_w" AFTER INSERT ON "T" BEGIN '
          + 'UPDATE "T" SET "w" = NEW."v" * 1024 + NEW."v" % 2 WHERE "id" = NEW."id"; END');
        db.close();
        await store.entity('T').create({ id: 'a', v: 2 ** 50 });
        // 2^60 + 1025, which a number would round
        await assert.rejects(async () => store.entity('T').create({ id: 'b', v: 2 ** 50 + 1 }), (/** @type {any} */ error) => {
          assert.deepEqual({ code: error.code, class: error.class, cause: error.cause?.code },
            { code: 'JD2003', class: 'data', cause: 'ERR_OUT_OF_RANGE' });
          assert.match(error.reason, /: 1152921504606848001$/);
          return true;
        });
        assert.deepEqual(records, [[{ op: 'add', path: '/T/a', value: { id: 'a', v: 2 ** 50, w: 2 ** 60 } }]]);
        assert.equal(await store.entity('T').get('b'), undefined);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});
