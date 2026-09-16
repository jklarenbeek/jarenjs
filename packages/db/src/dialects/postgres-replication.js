//@ts-check
/** Native metadata checks for the shared managed replication protocol. */
import { DbCompileError } from '../errors.js';
import { verifyPostgresTables } from './postgres-metadata.js';

/** @param {any} connection @param {any} schema @param {string[]} managedTables */
async function verify(connection, schema, managedTables) {
  let objects;
  try { objects = await verifyPostgresTables(connection, schema, 'replication'); }
  catch (cause) { throw new DbCompileError('JD0002', 'replication metadata requires an explicit schema migration', '/replication', cause); }
  const metadata = new Set(schema.tables.map((table) => table.name));
  const names = new Set([...metadata, ...managedTables]);
  for (const row of objects) {
    if (!names.has(row.owner)) continue;
    const m = row.metadata;
    if (row.type === 'constraint' && m.kind === 'f'
      && (!m.deferrable || !m.validated || /\bRESTRICT\b/.test(row.sql)))
      throw new DbCompileError('JD0051', `replication requires a reviewed deferrable foreign key migration on ${row.owner}`);
    if (metadata.has(row.owner) && row.type === 'column' && m.collation
      && (m.collationSchema !== 'pg_catalog' || m.collationDeterministic !== true))
      throw new DbCompileError('JD0002', 'replication metadata requires deterministic catalog collation');
    if ((row.type === 'table' && (m.kind !== 'r' || m.rls || m.forceRls || m.persistence !== 'p' || m.inherits))
      || row.type === 'trigger' || row.type === 'policy'
      || (metadata.has(row.owner) && row.type === 'constraint' && !['p', 'n'].includes(m.kind)))
      throw new DbCompileError('JD0051', `replication cannot enroll external effects on ${row.owner}`);
  }
  const rules = await (await connection.prepare(`SELECT c.relname AS name FROM pg_catalog.pg_rewrite r
    JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND r.rulename<>'_RETURN'`)).all();
  if (rules.some((row) => names.has(row.name)))
    throw new DbCompileError('JD0051', 'replication cannot enroll external rewrite rules');
  const incoming = await (await connection.prepare(`SELECT c.relname AS owner, n.nspname AS schema,
    target.relname AS target, target_ns.nspname AS namespace FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_class target ON target.oid=k.confrelid
    JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid=target.relnamespace
    WHERE k.contype='f' AND target_ns.nspname=current_schema()`)).all();
  if (incoming.some((row) => names.has(row.target) && (row.schema !== row.namespace || !names.has(row.owner))))
    throw new DbCompileError('JD0051', 'replication cannot enroll incoming foreign keys from unmanaged tables');
}

/** Receipts, local sequences and bootstrap use the same capture write lock. */
export const postgresReplication = Object.freeze({
  numericType: 'BIGINT', textType: 'TEXT COLLATE "C"',
  initialize: (connection) => connection.dialect.capture.beforeWrite(connection),
  verify,
});
