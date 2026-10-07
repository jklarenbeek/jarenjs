//@ts-check
/**
 * @file The admission boundary of the four migration entry points: an owned
 * `{ driver, path }` target answers every refusal of its call as a rejected
 * promise and opens nothing, a borrowed `{ connection }` target throws the
 * same refusal synchronously, and a target that is neither form is a
 * `TypeError`, thrown before anything else is read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';
import { EMPTY, legacy, all } from './migration-identity-helpers.js';

const OBSERVED = { version: 1, dialect: 'sqlite', order: 'rowid',
  history: { present: false, rows: [] }, identity: { present: false, rows: [] } };
const LEGACY = [legacy('first')];

/** How a call answered: thrown, rejected, resolved or a plain value. @param {() => any} call */
async function settle(call) {
  let value;
  try { value = call(); }
  catch (error) { return { how: 'throw', error }; }
  if (typeof value?.then !== 'function') return { how: 'value', error: undefined };
  try { await value; return { how: 'resolve', error: undefined }; }
  catch (error) { return { how: 'reject', error }; }
}

/** A refusal's identity: its code, or its class and message. @param {any} error */
const identity = (error) => (typeof error?.code === 'string' ? error.code : `${error?.name}: ${error?.message}`);

/** @type {[string, (target: any) => any, string][]} */
const CASES = [
  ['migrate signal', (t) => migrate(t, [], { baseline: EMPTY, signal: /** @type {any} */ (5) }), 'JD0013'],
  ['migrate typo', (t) => migrate(t, [], /** @type {any} */ ({ baseline: EMPTY, atomik: true })), 'JD0013'],
  ['migrate batchSize', (t) => migrate(t, [], { baseline: EMPTY, batchSize: /** @type {any} */ ('5') }),
    'TypeError: batchSize must be a positive safe integer'],
  ['migrate list', (t) => migrate(t, /** @type {any} */ ('x'), { baseline: EMPTY }),
    'TypeError: migrate needs the full ordered migration list'],
  ['adopt signal', (t) => adoptMigrationHistory(t, LEGACY, { observed: OBSERVED, model: EMPTY, signal: /** @type {any} */ (5) }), 'JD0013'],
  ['adopt typo', (t) => adoptMigrationHistory(t, LEGACY, /** @type {any} */ ({ observed: OBSERVED, model: EMPTY, typo: 1 })), 'JD0013'],
  ['adopt batchSize', (t) => adoptMigrationHistory(t, LEGACY, { observed: OBSERVED, model: EMPTY, batchSize: /** @type {any} */ ('5') }),
    'TypeError: batchSize must be a positive safe integer'],
  ['adopt list', (t) => adoptMigrationHistory(t, [], { observed: OBSERVED, model: EMPTY }),
    'TypeError: adoptMigrationHistory needs the complete nonempty applied legacy migration list'],
  ['status signal', (t) => migrationStatus(t, [], { signal: /** @type {any} */ (5) }), 'JD0013'],
  ['status typo', (t) => migrationStatus(t, [], /** @type {any} */ ({ modl: EMPTY })), 'JD0013'],
  ['status list', (t) => migrationStatus(t, /** @type {any} */ ('x')),
    'TypeError: migrationStatus needs the full ordered migration list'],
  ['history signal', (t) => migrationHistory(t, { signal: /** @type {any} */ (5) }), 'JD0013'],
  ['history typo', (t) => migrationHistory(t, /** @type {any} */ ({ signl: 1 })), 'JD0013'],
];

describe('migration admission answers through its target\'s boundary', () => {
  it('an owned target rejects every admission refusal and acquires nothing', async () => {
    const temp = tempDbPath();
    try {
      const driver = nodeDriver();
      let opened = 0;
      const target = { path: temp.dbPath, driver: { ...driver, open(/** @type {any[]} */ ...args) {
        opened++; return driver.open(...args);
      } } };
      const answers = [];
      for (const [label, call] of CASES) {
        const { how, error } = await settle(() => call(target));
        answers.push([label, how, identity(error)]);
      }
      assert.deepEqual(answers, CASES.map(([label, , expected]) => [label, 'reject', expected]));
      assert.equal(opened, 0, 'no refused call acquired a connection');
      assert.equal(existsSync(temp.dbPath), false, 'and none created the database file');
    }
    finally { temp.cleanup(); }
  });

  it('a borrowed target throws the same refusals synchronously', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      const answers = [];
      for (const [label, call] of CASES) {
        const { how, error } = await settle(() => call({ connection }));
        answers.push([label, how, identity(error)]);
      }
      assert.deepEqual(answers, CASES.map(([label, , expected]) => [label, 'throw', expected]));
      assert.deepEqual(all(connection, 'SELECT name FROM sqlite_schema'), [], 'nothing ran on the borrowed connection');
    }
    finally { await connection.close(); }
  });

  it('a target that is neither form is a TypeError, thrown by every entry point', async () => {
    /** @type {[string, (target: any) => any][]} */
    const entries = [
      ['migrate', (t) => migrate(t, [], { baseline: EMPTY })],
      ['status', (t) => migrationStatus(t, [])],
      ['history', (t) => migrationHistory(t)],
      ['adopt', (t) => adoptMigrationHistory(t, LEGACY, { observed: OBSERVED, model: EMPTY })],
    ];
    for (const target of [null, {}, { driver: {} }, { connection: {} }]) {
      const answers = [];
      for (const [label, call] of entries) {
        const { how, error } = await settle(() => call(target));
        answers.push([label, how, identity(error)]);
      }
      assert.deepEqual(answers, entries.map(([label]) =>
        [label, 'throw', 'TypeError: migration target needs { driver, path? } or { connection }']), JSON.stringify(target));
    }
  });
});
