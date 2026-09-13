//@ts-check
/** Independent restoration attempts retain every failure and preserve borrowed ownership. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { withForeignKeysSuspended } from '@jarenjs/db';

const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();

for (const asynchronous of [false, true]) for (const bodyFails of [false, true]) {
  for (const failure of ['legacy', 'foreignKeys', 'both']) {
    it(`${asynchronous ? 'asynchronous' : 'synchronous'} ${failure} restoration failure after a ${bodyFails ? 'failed' : 'successful'} body attempts both settings once`, async () => {
      const db = await driver.open(':memory:');
      const bodyError = new Error('body failed'), legacyError = new Error('legacy restoration failed'), foreignKeysError = new Error('foreign-key restoration failed');
      const errors = failure === 'both' ? [legacyError, foreignKeysError] : [failure === 'legacy' ? legacyError : foreignKeysError];
      let closes = 0, bodies = 0;
      const attempted = [];
      const connection = { ...db, get mustQueue() { return db.mustQueue; },
        close() { closes++; return db.close(); },
        exec(sql) {
          const setting = /legacy_alter_table\s*=\s*OFF/i.test(sql) ? 'legacy'
            : /foreign_keys\s*=\s*ON/i.test(sql) ? 'foreignKeys' : null;
          if (setting === null) return db.exec(sql);
          attempted.push(setting);
          const execute = () => {
            if (failure === setting || failure === 'both') throw setting === 'legacy' ? legacyError : foreignKeysError;
            return db.exec(sql);
          };
          // Cleanup accepts value-or-promise host failures. Only this fault
          // boundary is delayed; the native transaction and body stay real.
          return asynchronous ? Promise.resolve().then(execute) : execute();
        },
      };
      try {
        db.exec('PRAGMA foreign_keys=ON;PRAGMA legacy_alter_table=OFF;CREATE TABLE items(value INTEGER);INSERT INTO items VALUES(0)');
        await assert.rejects(async () => withForeignKeysSuspended(connection, () => {
          bodies++;
          db.exec('UPDATE items SET value=1');
          if (bodyFails) throw bodyError;
          return 'complete';
        }), (error) => {
          if (bodyFails || errors.length > 1) {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, bodyFails ? [bodyError, ...errors] : errors);
            if (bodyFails) assert.equal(error.cause, bodyError);
          }
          else assert.equal(error, errors[0]);
          return true;
        });
        assert.deepEqual(attempted, ['legacy', 'foreignKeys']);
        assert.equal(bodies, 1, 'an admitted body is never retried');
        assert.equal(closes, 0, 'failure does not close the borrowed connection');
        assert.equal(db.prepare('SELECT value FROM items').get([]).value, bodyFails ? 0 : 1);
        assert.equal(db.prepare('PRAGMA foreign_keys').get([]).foreign_keys, failure === 'legacy' ? 1 : 0);
        assert.equal(db.prepare('PRAGMA legacy_alter_table').get([]).legacy_alter_table, failure === 'foreignKeys' ? 0 : 1);
        db.exec('PRAGMA foreign_keys=ON;PRAGMA legacy_alter_table=OFF');
        assert.equal(db.prepare('SELECT 1 AS usable').get([]).usable, 1);
      }
      finally { db.close(); }
    });
  }
}
