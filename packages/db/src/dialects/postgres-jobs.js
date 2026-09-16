//@ts-check
/** PostgreSQL locking and catalog strategy for the shared job queue. */

import { verifyPostgresTables } from './postgres-metadata.js';

/** @param {any} connection @param {any} schema @returns {Promise<void>} */
async function verify(connection, schema) {
  const dialect = connection.dialect;
  const objects = await verifyPostgresTables(connection, schema, 'job');
  const name = `${schema.tables[0].name}_claim`;
  const index = objects.find((row) => row.type === 'index' && row.name === name);
  if (!index?.metadata.valid || !index.metadata.ready || index.metadata.unique
    || index.metadata.method !== 'btree' || index.metadata.predicate || index.metadata.expressions
    || index.metadata.keyCount !== 2 || index.owner !== schema.tables[0].name)
    throw new Error(`existing job index ${name} needs an explicit schema migration`);
  const keys = await (await connection.prepare(dialect.introspect.indexColumns(name))).all();
  if (JSON.stringify(keys.map((row) => row.name)) !== '["state","run_at"]')
    throw new Error(`existing job index ${name} has different keys`);
}

/** Native SQL is injected into one queue statement/schema owner. */
export const postgresJobs = Object.freeze({
  numericType: 'NUMERIC', textType: 'TEXT COLLATE "C"',
  claimLock: ' FOR UPDATE SKIP LOCKED', rowLock: ' FOR UPDATE',
  initialize: (connection) => connection.exec(
    'SELECT pg_catalog.pg_advisory_xact_lock(1246907990, pg_catalog.hashtext(current_schema()))'),
  verify,
  // One locked victim set drives both deletes under READ COMMITTED. A concurrent
  // requeue/reset cannot change which jobs lose their checkpoints halfway through.
  sweep: (selection, jobs, checkpoints) => `WITH victims AS MATERIALIZED (${selection} FOR UPDATE SKIP LOCKED), pruned AS (DELETE FROM ${checkpoints} WHERE run_id IN (SELECT id FROM victims)) DELETE FROM ${jobs} WHERE id IN (SELECT id FROM victims)`,
});
