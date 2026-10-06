//@ts-check
/** Process interruption preserves normal history and exact authority together.
 * These are recovery and backup controls, not power-loss qualification. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { migrate, migrationHistory, migrationStatus, adoptMigrationHistory,
  createModelShape, shapeHash, migrationChecksum } from '@jarenjs/db';
import { defineMigration } from '@jarenjs/linq/migration';
import { assertCrash } from './fixtures/abrupt-exit.js';

const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
const exact = (id, steps) => ({ ...defineMigration({ id, from: MODEL, to: MODEL }).document, steps });
const first = exact('first', [
  { kind: 'sql', sql: 'CREATE TABLE witness(value TEXT)' },
  { kind: 'sql', sql: "INSERT INTO witness VALUES('first')" },
]);
const tail = exact('tail', [{ kind: 'sql', sql: "INSERT INTO witness VALUES('tail')" }]);
const legacy = { $migration: '0.1', id: 'legacy', from: shapeHash(MODEL), to: shapeHash(MODEL), steps: first.steps };
const child = fileURLToPath(new URL('./sqlite-migration-identity-recovery-child.js', import.meta.url));
const native = process.versions.bun ? bunDriver : nodeDriver;
const hosts = [
  ['Node', process.versions.bun ? 'node' : process.execPath],
  ['Bun', process.versions.bun ? process.execPath : 'bun'],
];
const options = { baseline: MODEL, model: MODEL, shadow: false };

/** The independent row oracle releases each temporary native statement. */
function all(connection, sql) {
  const statement = connection.prepare(sql);
  try {
    return statement.all([]).map((row) => ({ ...row }));
  }
  finally {
    statement.finalize?.();
  }
}

/** Seed the original six-field format as an older runtime did. */
function seedLegacy(connection) {
  for (const step of legacy.steps) connection.exec(step.sql);
  connection.exec('CREATE TABLE IF NOT EXISTS "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, "to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT');
  const statement = connection.prepare('INSERT INTO "_jaren_migrations" (rowid,id,applied_at,from_hash,to_hash,checksum,steps) VALUES (-7,?,9007199254740993,?,?,?,2)');
  try {
    statement.run([legacy.id, legacy.from, legacy.to, migrationChecksum(legacy)]);
  }
  finally {
    statement.finalize?.();
  }
}

for (const [host, executable] of hosts) {
  for (const point of ['normal', 'side', 'adopt-header', 'adopt-receipt', 'copy', 'publish-before', 'publish-after']) {
    it(`${host}: ${point} interruption preserves migration rows and exact authority`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jaren-identity-recovery-'));
      const file = join(dir, 'source.sqlite');
      const adoption = point.startsWith('adopt');
      const backup = point === 'copy' || point.startsWith('publish');
      let connection;
      try {
        connection = await native().open(file);
        connection.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        createModelShape(connection, MODEL);
        if (adoption || backup) seedLegacy(connection);
        else migrate({ connection }, [first], options);
        const observed = migrationHistory({ connection });
        if (adoption || backup) {
          assert.equal(observed.history.rows[0].rowid, '-7');
          assert.equal(observed.history.rows[0].applied_at, '9007199254740993');
        }
        if (backup) {
          adoptMigrationHistory({ connection }, [legacy], { observed, model: MODEL });
          migrate({ connection }, [legacy, tail], options);
        }
        const before = migrationHistory({ connection });
        const data = all(connection, 'SELECT value FROM witness ORDER BY rowid');
        if (backup) {
          assert.equal(existsSync(`${file}-wal`), true);
          // Without its committed WAL, the main file has neither receipt family.
          const mainOnly = join(dir, 'main-only.sqlite');
          copyFileSync(file, mainOnly);
          const incomplete = await native().open(mainOnly);
          try {
            const withoutWal = migrationHistory({ connection: incomplete });
            assert.equal(withoutWal.history.present, false);
            assert.equal(withoutWal.identity.present, false);
          }
          finally {
            await incomplete.close();
          }
        }
        else {
          await connection.close();
          connection = undefined;
        }
        const migrations = adoption ? [legacy] : backup ? [legacy, tail] : [first, tail];
        const input = `${file}.json`;
        const bytes = JSON.stringify({ model: MODEL, observed, migrations });
        writeFileSync(input, bytes);
        const killed = spawnSync(executable, [child, file, input, point], { encoding: 'utf8', timeout: 15000 });
        assertCrash(killed, point);
        assert.equal(readFileSync(input, 'utf8'), bytes);
        await connection?.close();
        connection = await native().open(file);
        assert.deepEqual(migrationHistory({ connection }), before, 'interruption preserves both original receipt families');
        assert.deepEqual(all(connection, 'SELECT value FROM witness ORDER BY rowid'), data);
        if (backup) {
          assert.equal(existsSync(`${file}.backup`), point === 'publish-after');
          if (point === 'publish-after') {
            const copy = await native().open(`${file}.backup`);
            try {
              assert.deepEqual(migrationHistory({ connection: copy }), before);
              assert.deepEqual(all(copy, 'SELECT value FROM witness ORDER BY rowid'), data);
              assert.equal(migrationStatus({ connection: copy }, migrations).upToDate, true);
              assert.deepEqual(migrate({ connection: copy }, migrations, options).applied, []);
              assert.deepEqual(migrationHistory({ connection: copy }), before);
            }
            finally {
              await copy.close();
            }
          }
        }
        else if (adoption) {
          assert.throws(() => migrationStatus({ connection }, migrations), { code: 'JD0028' });
          assert.deepEqual(adoptMigrationHistory({ connection }, migrations, { observed, model: MODEL }),
            { adopted: 1, unchanged: 0 });
          const after = migrationHistory({ connection });
          assert.deepEqual(after.history, before.history);
          assert.deepEqual(adoptMigrationHistory({ connection }, migrations, { observed, model: MODEL }),
            { adopted: 0, unchanged: 1 });
          assert.deepEqual(migrationHistory({ connection }), after);
        }
        else {
          assert.deepEqual(migrationStatus({ connection }, migrations).pending, ['tail']);
          assert.deepEqual(migrate({ connection }, migrations, options).applied, ['tail']);
          const after = migrationHistory({ connection });
          assert.deepEqual(after.history.rows[0], before.history.rows[0]);
          assert.deepEqual(migrate({ connection }, migrations, options).applied, []);
          assert.deepEqual(migrationHistory({ connection }), after);
          assert.deepEqual(all(connection, 'SELECT value FROM witness ORDER BY rowid'), [{ value: 'first' }, { value: 'tail' }]);
        }
      }
      finally {
        await connection?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
