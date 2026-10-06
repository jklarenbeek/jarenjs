//@ts-check
/** Installed public migration identity: one DB-only proof, also driven by the LINQ pen. */
import assert from 'node:assert/strict';
import { qualifyMigrationIdentityHosts } from './migration-identity-hosts.js';
import { migrationHistory, adoptMigrationHistory, migrationStatus, migrate,
  planModelMigration, shapeHash, migrationChecksum, createModelShape, sqliteDialect,
  migrateDocuments, streamDocuments } from '@jarenjs/db';

const MODEL = { $model: '0.1', entities: { Item: { schema: {
  type: 'object', additionalProperties: false, required: ['id', 'name'],
  properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } },
} } } };

/** @param {any} connection @param {string} sql @param {any[]} [params] */
async function all(connection, sql, params = []) {
  const statement = await connection.prepare(sql);
  try { return (await statement.all(params)).map((row) => ({ ...row })); }
  finally { await statement.finalize?.(); }
}

/**
 * Run exactly the same adoption/extension observations through the DB planner
 * or an injected pen author. No optional LINQ import enters the DB closure.
 * @param {(from: any, to: any, id: string) => any} [author]
 */
export async function qualifyMigrationIdentity(author = (from, to, id) =>
  planModelMigration(from, to, { dialect: sqliteDialect, id }).migration) {
  const driver = process.versions.bun
    ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const connection = await driver.open(':memory:', {});
  try {
    const target = { connection };
    const empty = migrationHistory(target);
    assert.equal(typeof empty?.then, 'undefined', 'borrowed synchronous observation remains synchronous');
    assert.deepEqual(empty, { version: 1, dialect: 'sqlite', order: 'rowid',
      history: { present: false, rows: [] }, identity: { present: false, rows: [] } });
    await createModelShape(connection, MODEL);
    const legacy = { $migration: '0.1', id: '0001-reviewed', from: shapeHash(MODEL), to: shapeHash(MODEL),
      steps: [{ kind: 'sql', sql: `INSERT INTO "Item" ("id", "name", "doc") VALUES ('one', 'Ada', jsonb('{}'))` }] };
    await connection.exec(legacy.steps[0].sql);
    await connection.exec(`CREATE TABLE IF NOT EXISTS "_jaren_migrations" ("id" TEXT PRIMARY KEY, "applied_at" INTEGER, "from_hash" TEXT, "to_hash" TEXT, "checksum" TEXT, "steps" INTEGER) STRICT`);
    const insert = await connection.prepare(`INSERT INTO "_jaren_migrations"
      (rowid, id, applied_at, from_hash, to_hash, checksum, steps) VALUES (-7, ?, 9007199254740993, ?, ?, ?, 1)`);
    try { await insert.run([legacy.id, legacy.from, legacy.to, migrationChecksum(legacy)]); }
    finally { await insert.finalize?.(); }
    const legacyBytes = JSON.stringify(legacy);
    const observed = migrationHistory(target);
    assert.equal(typeof observed?.then, 'undefined');
    assert.equal(observed.history.rows[0].rowid, '-7');
    assert.equal(observed.history.rows[0].applied_at, '9007199254740993');
    assert.equal(observed.history.rows[0].steps, '1');
    const jsonObservation = JSON.parse(JSON.stringify(observed));
    assert.equal(JSON.stringify(jsonObservation), JSON.stringify(observed));
    await assert.rejects(async () => migrationStatus(target, [legacy]), { code: 'JD0028' });
    await assert.rejects(async () => migrate(target, [legacy], { baseline: MODEL, model: MODEL, shadow: false, shadowDriver: driver }), { code: 'JD0028' });
    const options = { observed: jsonObservation, model: MODEL, shadowDriver: driver };
    assert.deepEqual(await adoptMigrationHistory(target, [legacy], options), { adopted: 1, unchanged: 0 });
    const adopted = await migrationHistory(target);
    assert.deepEqual(adopted.history, observed.history);
    assert.equal(adopted.identity.present, true);
    assert.deepEqual(await adoptMigrationHistory(target, [legacy], options), { adopted: 0, unchanged: 1 });
    assert.deepEqual(await migrationHistory(target), adopted, 'a repeat changes neither row family');
    assert.equal(JSON.stringify(legacy), legacyBytes);
    assert.deepEqual(await all(connection, 'SELECT "id", "name" FROM "Item"'), [{ id: 'one', name: 'Ada' }]);
    const planned = author(MODEL, MODEL, '0002-exact');
    assert.equal(planned.$migration, '0.2');
    assert.equal(planned.identity.version, 1);
    assert.equal(planned.identity.from, planned.identity.to);
    const exact = { ...planned, steps: [...planned.steps,
      { kind: 'sql', sql: `UPDATE "Item" SET "name" = 'ADA' WHERE "id" = 'one'` }] };
    const chain = [legacy, exact];
    const applied = await migrate(target, chain, { baseline: MODEL, model: MODEL, shadow: false, shadowDriver: driver });
    assert.deepEqual(applied.applied, [exact.id]);
    assert.deepEqual(await all(connection, 'SELECT "id", "name" FROM "Item"'), [{ id: 'one', name: 'ADA' }]);
    const complete = await migrationHistory(target);
    assert.deepEqual((await migrate(target, chain, { baseline: MODEL, model: MODEL, shadow: false, shadowDriver: driver })).applied, []);
    assert.deepEqual(await migrationHistory(target), complete);
    assert.equal((await migrationStatus(target, chain)).upToDate, true);
    await assert.rejects(async () => adoptMigrationHistory(target, [legacy], options), { code: 'JD0022' });
    const changed = structuredClone(exact);
    changed.steps.at(-1).sql = `UPDATE "Item" SET "name" = 'wrong' WHERE "id" = 'one'`;
    await assert.rejects(async () => migrationStatus(target, [legacy, changed]), { code: 'JD0022' });

    // Storeless 0.1 input remains independent of database history authority.
    const documents = { $migration: '0.1', id: 'documents', from: 'old', to: 'next',
      steps: [{ kind: 'jslt', collection: 'items', stylesheet: [{ match: '$', body: { id: '$.id', name: { $upper: '$.name' } } }] }] };
    const rows = { items: [{ id: 'one', name: 'Ada' }] };
    const materialized = await migrateDocuments(rows, [documents]);
    assert.deepEqual(materialized.documents.items, [{ id: 'one', name: 'ADA' }]);
    const streamed = [];
    await streamDocuments(rows, [documents], { write: (_name, row) => streamed.push(row) });
    assert.deepEqual(streamed, materialized.documents.items);
  }
  finally { await connection.close(); }
  return { legacyReceipts: 1, exactReceipts: 1, observationNumeric: 'text', storelessLegacy: true,
    hosts: await qualifyMigrationIdentityHosts(author) };
}
