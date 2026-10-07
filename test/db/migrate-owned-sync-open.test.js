//@ts-check
/**
 * @file An owned `{ driver, path? }` target answers through its promise
 * whatever its driver does. A driver whose `open()` answers synchronously
 * (the wasm driver over a synchronous handle) runs the whole call
 * synchronously, and every refusal met after acquisition (a malformed
 * document, a history the list disagrees with, a failed step, an adoption
 * whose observation is stale) is still a rejected promise; so is an `open()`
 * that throws. A borrowed `{ connection }` keeps its synchronous throws.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, sqliteDialect, migrationChecksum } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { document, legacy, EMPTY, seedLegacy } from './migration-identity-helpers.js';

/** How a call answered, and with what: thrown, rejected, resolved or a plain value.
 * @param {() => any} call @returns {Promise<[string, string?]>} */
async function settle(call) {
  let value;
  try { value = call(); }
  catch (error) { return ['throw', identity(error)]; }
  if (typeof value?.then !== 'function') return ['value'];
  try { await value; return ['resolve']; }
  catch (error) { return ['reject', identity(error)]; }
}

/** A refusal's identity: its code, or its class and message. @param {any} error */
const identity = (error) => (typeof error?.code === 'string' ? error.code : `${error?.name}: ${error?.message}`);

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const CREATE = document('a', [{ kind: 'sql', sql: 'CREATE TABLE t(x INTEGER)' }]);
const LEGACY = legacy('first', [], MODEL, MODEL);

describe('an owned target over a driver whose open() answers synchronously', () => {
  /** @type {any} */ let sqlite3;
  /** @type {any} */ let driver;
  /** @type {any[]} */ const holders = [];
  /** A wasm memdb database kept alive between owned calls. @param {string} name */
  const database = (name) => {
    const path = `file:/${name}?vfs=memdb`;
    holders.push(new sqlite3.oo1.DB(path, 'c'));
    return path;
  };

  before(async () => {
    sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
    driver = wasmDriver(sqlite3Handle(sqlite3));
  });
  after(() => { for (const holder of holders) holder.close(); });

  it('rejects every refusal met after acquisition, as an asynchronous driver does', async () => {
    const fresh = { driver, path: database('fresh') };
    const applied = { driver, path: database('applied') };
    assert.deepEqual(await migrate(applied, [CREATE], { baseline: EMPTY, shadow: false }),
      { applied: ['a'], skipped: [], shape: CREATE.to });
    // an observation of a legacy history the owned database does not hold
    const seeded = await driver.open(database('legacy'));
    let observed;
    try {
      await seedLegacy(seeded, [LEGACY]);
      observed = await migrationHistory({ connection: seeded });
    }
    finally { await seeded.close(); }
    /** @type {[string, () => any, string][]} */
    const cases = [
      ['migrate a malformed document', () => migrate(fresh, [{ $migration: '0.2', id: 'x' }], { baseline: EMPTY, shadow: false }), 'JD0023'],
      ['migrate an edited history', () => migrate(applied, [document('b')], { baseline: EMPTY, shadow: false }), 'JD0022'],
      ['status of an edited history', () => migrationStatus(applied, [document('b')]), 'JD0022'],
      ['migrate a failing step', () => migrate(applied, [CREATE,
        document('c', [{ kind: 'sql', sql: 'INSERT INTO missing_table VALUES (1)' }])], { baseline: EMPTY, shadow: false }), 'JD0023'],
      ['adopt a stale observation', () => adoptMigrationHistory(fresh, [LEGACY], { observed, model: MODEL }), 'JD0022'],
    ];
    const answers = [];
    for (const [label, call] of cases) answers.push([label, ...await settle(call)]);
    assert.deepEqual(answers, cases.map(([label, , code]) => [label, 'reject', code]));
    assert.deepEqual(await migrationHistory(applied).then((/** @type {any} */ o) => o.history.rows.map((/** @type {any} */ r) => r.id)),
      ['a'], 'the refused calls changed nothing');
  });

  it('rejects an open() that throws, from all four entry points', async () => {
    let opened = 0;
    const target = { driver: { name: 'throwing', dialect: sqliteDialect,
      open() { opened++; throw new Error('the handle is gone'); } } };
    // an observation admission accepts, so adoption reaches the open
    const observed = { version: 1, dialect: 'sqlite', order: 'rowid', identity: { present: false, rows: [] },
      history: { present: true, rows: [{ rowid: '1', id: 'first', applied_at: '1234', from_hash: LEGACY.from,
        to_hash: LEGACY.to, checksum: migrationChecksum(LEGACY), steps: '0' }] } };
    /** @type {[string, () => any][]} */
    const entries = [
      ['migrate', () => migrate(target, [CREATE], { baseline: EMPTY, shadow: false })],
      ['status', () => migrationStatus(target, [CREATE])],
      ['history', () => migrationHistory(target)],
      ['adopt', () => adoptMigrationHistory(target, [LEGACY], { observed, model: MODEL })],
    ];
    const answers = [];
    for (const [label, call] of entries) answers.push([label, ...await settle(call)]);
    assert.deepEqual(answers, entries.map(([label]) => [label, 'reject', 'Error: the handle is gone']));
    assert.equal(opened, entries.length, 'every call reached the open');
  });

  it('a borrowed connection of the same driver keeps its synchronous throws', async () => {
    const connection = await driver.open(database('borrowed'));
    try {
      assert.deepEqual(await settle(() => migrate({ connection }, [{ $migration: '0.2', id: 'x' }], { baseline: EMPTY, shadow: false })),
        ['throw', 'JD0023']);
      assert.deepEqual(await settle(() => migrationStatus({ connection }, [{ $migration: '0.2', id: 'x' }])), ['throw', 'JD0023']);
    }
    finally { await connection.close(); }
  });
});
