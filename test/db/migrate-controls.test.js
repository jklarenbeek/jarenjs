//@ts-check
/**
 * @file Every control a migration entry point reads is admitted before a
 * connection is acquired: a malformed deadline, a hook that is not a
 * function, `expressions` that is not a plain object, a `shadowDriver`
 * without `open()` and a non-boolean `dryRun`/`shadow` refuse `JD0013`, and
 * a malformed `physicalTarget` (`null` included, never read as absent)
 * refuses `JD0021` from every entry point that reads one — an owned call
 * opens no connection and creates no file, a borrowed one runs nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { migrate, migrationStatus, migrationHistory, adoptMigrationHistory, createModelShape } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';
import { EMPTY, legacy, document, all } from './migration-identity-helpers.js';

const OBSERVED = { version: 1, dialect: 'sqlite', order: 'rowid',
  history: { present: false, rows: [] }, identity: { present: false, rows: [] } };
const LEGACY = [legacy('first')];
const OWNER = { migrate: 'migrate()', status: 'migrationStatus()', history: 'migrationHistory()', adopt: 'adoptMigrationHistory()' };
/** @type {Record<string, (target: any, options: any) => any>} */
const CALL = {
  migrate: (t, o) => migrate(t, [document('pending', [{ kind: 'sql', sql: 'CREATE TABLE ran(n INTEGER)' }])],
    { baseline: EMPTY, shadow: false, ...o }),
  status: (t, o) => migrationStatus(t, [], o),
  history: (t, o) => migrationHistory(t, o),
  adopt: (t, o) => adoptMigrationHistory(t, LEGACY, { observed: OBSERVED, model: EMPTY, ...o }),
};
const ALL = ['migrate', 'status', 'history', 'adopt'];
/** @type {[string[], string, any, string | null][]} entry points, member, value, rule (`null`: the target owner's) */
const MALFORMED = [
  [ALL, 'deadline', NaN, 'must be a finite timestamp'],
  [ALL, 'deadline', 'x', 'must be a finite timestamp'],
  [['migrate', 'status', 'adopt'], 'registerFunctions', 'x', 'must be a function'],
  [['migrate', 'adopt'], 'compileSchema', 'x', 'must be a function'],
  [['migrate'], 'onProgress', 'x', 'must be a function'],
  [['migrate'], 'onAssertionPlan', 'x', 'must be a function'],
  [['migrate'], 'shadowFixture', 'x', 'must be a function'],
  [['migrate', 'adopt'], 'expressions', 'x', 'must be a plain object of declarations'],
  [['migrate', 'status', 'adopt'], 'shadowDriver', 'x', 'must be a driver with open()'],
  [['migrate', 'status', 'adopt'], 'shadowDriver', {}, 'must be a driver with open()'],
  [['migrate', 'status', 'adopt'], 'physicalTarget', null, null],
  [['migrate', 'status', 'adopt'], 'physicalTarget', 'x', null],
  [['migrate'], 'dryRun', 'true', 'must be true or false'],
  [['migrate'], 'shadow', 'false', 'must be true or false'],
  [['migrate'], 'shadowPath', 5, 'must be a database path'],
];
/** The physical-target owner's refusal, shared by every entry point that reads one. */
const TARGET_REFUSAL = 'JD0021: physicalTarget requires complete objects and optional owned tables';
const expected = () => MALFORMED.flatMap(([entries, member, value, rule]) => entries.map((entry) => (rule === null
  ? [entry, member, String(value), 'JD0021', TARGET_REFUSAL]
  : [entry, member, String(value), 'JD0013', `JD0013: ${OWNER[entry]} option '${member}' ${rule}`])));

/** How a call answered: thrown, rejected, resolved or a plain value. @param {() => any} call */
async function settle(call) {
  let value;
  try { value = call(); }
  catch (error) { return { how: 'throw', error }; }
  if (typeof value?.then !== 'function') return { how: 'value', error: undefined };
  try { await value; return { how: 'resolve', error: undefined }; }
  catch (error) { return { how: 'reject', error }; }
}

describe('migration controls are admitted before acquisition', () => {
  it('an owned target rejects every malformed control with JD0013 and opens nothing', async () => {
    const temp = tempDbPath();
    try {
      const driver = nodeDriver();
      let opened = 0;
      const target = { path: temp.dbPath, driver: { ...driver, open(/** @type {any[]} */ ...args) {
        opened++; return driver.open(...args);
      } } };
      const answers = [];
      for (const [entries, member, value] of MALFORMED) {
        for (const entry of entries) {
          const { how, error } = await settle(() => CALL[entry](target, { [member]: value }));
          answers.push([entry, member, String(value), how === 'reject' ? error?.code : how, error?.message]);
        }
      }
      assert.deepEqual(answers, expected());
      assert.equal(opened, 0, 'no refused call acquired a connection');
      assert.equal(existsSync(temp.dbPath), false, 'and none created the database file');
    }
    finally { temp.cleanup(); }
  });

  it('a borrowed target throws the same refusals and runs nothing', async () => {
    const connection = await nodeDriver().open(':memory:');
    try {
      const answers = [];
      for (const [entries, member, value] of MALFORMED) {
        for (const entry of entries) {
          const { how, error } = await settle(() => CALL[entry]({ connection }, { [member]: value }));
          answers.push([entry, member, String(value), how === 'throw' ? error?.code : how, error?.message]);
        }
      }
      assert.deepEqual(answers, expected());
      assert.deepEqual(all(connection, 'SELECT name FROM sqlite_schema'), [], 'no step, history or identity table');
    }
    finally { await connection.close(); }
  });

  it('well-formed controls keep their results', async () => {
    const temp = tempDbPath();
    try {
      const model = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
      const driver = nodeDriver(), target = { driver, path: temp.dbPath };
      const created = await driver.open(temp.dbPath);
      try { await createModelShape(created, model); }
      finally { await created.close(); }
      const link = document('valid', [], model);
      const deadline = Date.now() + 600_000;
      const applied = await migrate(target, [link], {
        baseline: model, model, registerFunctions() {}, compileSchema: () => () => true,
        onProgress() {}, onAssertionPlan() {}, shadowFixture: (/** @type {any} */ shadow) => createModelShape(shadow, model),
        expressions: {}, shadowDriver: driver, shadow: true, shadowPath: ':memory:', dryRun: false, deadline,
      });
      assert.deepEqual(applied, { applied: ['valid'], skipped: [], shape: link.to });
      assert.deepEqual(await migrationStatus(target, [link], { model, registerFunctions() {}, shadowDriver: driver, deadline }),
        { applied: ['valid'], pending: [], drift: null, upToDate: true, baseline: 'valid' });
      assert.deepEqual((await migrationHistory(target, { deadline })).history.rows.map((/** @type {any} */ row) => row.id), ['valid']);
    }
    finally { temp.cleanup(); }
  });
});
