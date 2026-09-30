//@ts-check
/**
 * @file Host steps and atomic runs on a real PostgreSQL server (the SQLite
 * files are `migrate-host-step.test.js` and `migrate-atomic.test.js`): an
 * asynchronous driver runs an async host inside the step's savepoint; an
 * atomic chain — a narrowing link, then its repair — commits whole after
 * the repair, and a chain whose second link fails leaves no link applied.
 * A step's failure is `JD0023`, classified.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planModelMigration, migrate, migrationStatus, shapeHash, sqliteDialect } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { JarenValidator } from '@jarenjs/validate';

const url = process.env.JAREN_PG_URL;
const compileSchema = (/** @type {any} */ schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (/** @type {any} */ doc) => validate(doc);
};
const V1 = { $model: '0.1', collections: { docs: { schema: { type: 'object', properties: { name: { type: 'string' } } }, key: '/id', indexes: [] } } };
const V2 = structuredClone(V1);
/** @type {any} */ (V2.collections.docs.schema.properties.name).maxLength = 3;
// a collection narrowing plans only its draft transform, whatever the dialect: without it the link runs no statement
const NARROW = { ...planModelMigration(V1, V2, { dialect: sqliteDialect, id: 'narrow' }).migration, steps: [] };
const REPAIR = { $migration: '0.1', id: 'repair', from: shapeHash(V2), to: shapeHash(V2), steps: [{ kind: 'host', run: 'truncate', version: '1' }] };
const FAILING = { $migration: '0.1', id: 'failing', from: shapeHash(V2), to: shapeHash(V2), steps: [{ kind: 'sql', sql: 'INSERT INTO nowhere VALUES (1)' }] };
const hosts = { truncate: { version: '1', async run(/** @type {any} */ scope) {
  await Promise.resolve();
  return scope.collection('docs').update((/** @type {any} */ doc) => (doc.name.length > 3 ? { ...doc, name: doc.name.slice(0, 3) } : undefined));
} } };

describe('PostgreSQL: host steps and atomic runs', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pg;
  /** @type {any} */
  let admin;
  /** @type {any[]} */
  const pools = [];
  let counter = 0;

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
  });
  after(async () => {
    for (const pool of pools.splice(0)) await pool.end().catch(() => {});
    await admin?.end();
  });

  /** A fresh schema holding the two documents a narrowing refuses until repaired. */
  const seeded = async () => {
    const schema = `jaren_migrate_atomic_${process.pid}_${counter++}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    pools.push(pool);
    const driver = () => postgresDriver(pool, { schema });
    const store = await openStore(V1, { driver: driver() });
    await store.collection('docs').put({ id: 'a', name: 'abcdef' });
    await store.collection('docs').put({ id: 'b', name: 'xy' });
    await store.close();
    return { driver, drop: () => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) };
  };

  it('an async host repairs inside an atomic chain, which commits whole; a repeat applies nothing', async () => {
    const { driver, drop } = await seeded();
    try {
      const outcome = await migrate({ driver: driver() }, [NARROW, REPAIR], { baseline: V1, model: V2, compileSchema, shadow: false, hosts, atomic: true });
      assert.deepEqual(/** @type {any} */ (outcome).applied, ['narrow', 'repair']);
      const store = await openStore(V2, { driver: driver() });
      assert.deepEqual(await store.collection('docs').all(), [{ id: 'a', name: 'abc' }, { id: 'b', name: 'xy' }]);
      await store.close();
      assert.deepEqual(await migrate({ driver: driver() }, [NARROW, REPAIR], { baseline: V1, model: V2, compileSchema, shadow: false, hosts, atomic: true }),
        { applied: [], skipped: ['narrow', 'repair'], upToDate: true });
    }
    finally { await drop(); }
  });

  it('a failing link leaves no link applied, and its failure is JD0023, classified', async () => {
    const { driver, drop } = await seeded();
    try {
      await assert.rejects(migrate({ driver: driver() }, [NARROW, FAILING], { baseline: V1, model: V2, compileSchema, shadow: false, atomic: true }),
        (/** @type {any} */ e) => e.code === 'JD0023' && typeof e.class === 'string' && typeof e.retryable === 'boolean'
          && /migration 'failing' step 0 \(sql\)/.test(e.message));
      assert.deepEqual((await migrationStatus({ driver: driver() }, [NARROW, FAILING], {})).applied, []);
    }
    finally { await drop(); }
  });
});
