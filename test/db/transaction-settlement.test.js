//@ts-check
/** Deferred constraints are checked at commit, after the callback succeeds. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openConnection, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { asyncWasmHandle } from './helpers.js';

const schema = 'PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); '
  + 'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) '
  + 'DEFERRABLE INITIALLY DEFERRED);';

describe('failed transaction settlement rolls back before releasing the connection', () => {
  for (const asynchronous of [false, true]) {
    for (const mode of ['deferred', 'immediate']) {
      it(`${asynchronous ? 'async' : 'sync'} ${mode} leaves no rows after a deferred constraint failure`, async () => {
        const driver = asynchronous ? wasmDriver(asyncWasmHandle()) : nodeDriver();
        const connection = await driver.open(':memory:');
        try {
          await connection.exec(schema);
          await assert.rejects(async () => connection.transaction(
            (tx) => tx.exec('INSERT INTO child VALUES(1, 9)'), undefined, mode),
          /FOREIGN KEY constraint failed/);
          const query = await connection.prepare('SELECT id, parent_id FROM child ORDER BY id');
          assert.deepStrictEqual(await query.all(), []);
          await connection.transaction((tx) => tx.exec(
            'INSERT INTO parent VALUES(9); INSERT INTO child VALUES(2, 9)'), undefined, mode);
          assert.deepStrictEqual((await query.all()).map((row) => ({ ...row })),
            [{ id: 2, parent_id: 9 }], 'later work cannot commit the failed transaction');
        }
        finally {
          await connection.close();
        }
      });

      it(`${asynchronous ? 'async' : 'sync'} ${mode} preserves settlement and rollback errors`, async () => {
        const commitError = new Error('commit refused');
        const rollbackError = new Error('rollback refused');
        const calls = [];
        let commitFailed = false;
        const execute = (sql) => {
          calls.push(sql);
          if (!commitFailed && (sql === sqliteDialect.tx.commit || sql.startsWith('RELEASE'))) {
            commitFailed = true;
            throw commitError;
          }
          if (sql.startsWith('ROLLBACK')) throw rollbackError;
        };
        const connection = await openConnection({
          exec: asynchronous ? async (sql) => execute(sql) : execute,
          close() {},
        }, { dialect: sqliteDialect, synchronous: !asynchronous, probe: () => ({}) });
        try {
          await assert.rejects(async () => connection.transaction(() => 1, undefined, mode), (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepStrictEqual(error.errors, [commitError, rollbackError]);
            return true;
          });
          assert.strictEqual(calls.filter((sql) => sql.startsWith('ROLLBACK')).length, 1);
          assert.strictEqual(connection.mustQueue, false);
          assert.strictEqual(await connection.transaction(() => 2, undefined, mode), 2);
        }
        finally {
          await connection.close();
        }
      });
    }
  }

  for (const mode of ['deferred', 'immediate']) {
    it(`${mode} lets a queued transaction proceed only after rollback`, async () => {
      const connection = await wasmDriver(asyncWasmHandle()).open(':memory:');
      const entered = Promise.withResolvers();
      const proceed = Promise.withResolvers();
      try {
        await connection.exec(schema);
        const first = connection.transaction(async (tx) => {
          await tx.exec('INSERT INTO child VALUES(1, 9)');
          entered.resolve(undefined);
          await proceed.promise;
        }, undefined, mode);
        const refused = assert.rejects(first, /FOREIGN KEY constraint failed/);
        await entered.promise;
        const second = connection.transaction((tx) => tx.exec(
          'INSERT INTO parent VALUES(9); INSERT INTO child VALUES(2, 9)'), undefined, mode);
        proceed.resolve(undefined);
        await refused;
        await second;
        const query = await connection.prepare('SELECT id FROM child ORDER BY id');
        assert.deepStrictEqual((await query.all()).map((row) => row.id), [2]);
      }
      finally {
        await connection.close();
      }
    });
  }
});
