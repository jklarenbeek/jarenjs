//@ts-check
import assert from 'node:assert/strict';
import { postgresDriver } from '@jarenjs/db/postgres';
import { shapeHash, migrationChecksum } from '../../packages/db/src/migrate.js';
import { migrationIdentity } from '../../packages/db/src/migration-identity.js';
import { historyStatements } from '../../packages/db/src/migration-history.js';
import { useStatementOnce } from '../../packages/db/src/driver.js';

export const EMPTY = { $model: '0.1', collections: {} };
export const native = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver
  : (await import('@jarenjs/db/node')).nodeDriver;
export const hosts = ['sqlite', ...(process.env.JAREN_PG_URL ? ['postgres'] : [])];
let nextFixture = 0;

export function document(id, steps = [], from = EMPTY, to = from) {
  return { $migration: '0.2', id, from: shapeHash(from), to: shapeHash(to),
    identity: migrationIdentity(from, to), steps };
}

export function legacy(id, steps = [], from = EMPTY, to = from) {
  return { $migration: '0.1', id, from: shapeHash(from), to: shapeHash(to), steps };
}

export function all(connection, sql, params = []) {
  return useStatementOnce(connection, sql, (statement) => statement.all(params));
}

export function run(connection, sql, params = []) {
  return useStatementOnce(connection, sql, (statement) => statement.run(params));
}

/** Construct original persisted history as an old pinned runtime did. No bypass
 * is exposed by the migration API being tested. */
export async function seedLegacy(connection, documents, timestamp = 1234, oldHosts = {}) {
  const sql = historyStatements(connection.dialect);
  await connection.exec(sql.create);
  for (const migration of documents) {
    for (const step of migration.steps) {
      if (step.kind === 'host') {
        assert.equal(typeof oldHosts[step.run], 'function', 'legacy host behavior is supplied explicitly by the fixture');
        await oldHosts[step.run](connection);
      }
      else {
        assert.ok(['sql', 'ddl'].includes(step.kind));
        await connection.exec(step.sql);
      }
    }
    await run(connection, sql.insert, [migration.id, timestamp, migration.from, migration.to,
      migrationChecksum(migration), migration.steps.length]);
  }
}

export async function fixture(host, execute) {
  let pool, connection;
  const schema = `jaren_identity_${process.pid}_${nextFixture++}`;
  try {
    let driver = native();
    if (host === 'postgres') {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 4 });
      await pool.query(`CREATE SCHEMA "${schema}"`);
      driver = postgresDriver(pool, { schema, lockTimeoutMs: 5000 });
    }
    connection = await driver.open(':memory:');
    await execute(connection, { driver, pool, schema });
  }
  finally {
    await connection?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  }
}

export function rejected(call, code) { return assert.rejects(async () => call(), { code }); }
