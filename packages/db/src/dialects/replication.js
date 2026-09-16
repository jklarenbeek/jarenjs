//@ts-check
/** One metadata declaration for the managed replication engine and its catalog checks. */
import { REPLICATION_TABLES } from '../replication-tables.js';

/** @param {any} dialect @returns {any} */
export function replicationSchema(dialect) {
  const strategy = dialect.replication ?? {};
  const numeric = strategy.numericType ?? 'INTEGER';
  const text = strategy.textType ?? 'TEXT', required = 'NOT NULL';
  const tables = [
    { name: REPLICATION_TABLES.state, keys: ['id'], columns: [
      ['id', numeric, 'PRIMARY KEY'], ['value', text, required],
    ] },
    { name: REPLICATION_TABLES.rows, keys: ['name', 'key'], columns: [
      ['name', text, required], ['key', text, required], ['value', text, required], ['frontier', text, required],
    ] },
    ...['receipts', 'outbox', 'conflicts', 'claims'].map((name) => ({
      name: REPLICATION_TABLES[name], keys: [name === 'outbox' ? 'seq' : 'id'], columns: [
        [name === 'outbox' ? 'seq' : 'id', name === 'outbox' ? numeric : text, 'PRIMARY KEY'],
        [name === 'conflicts' ? 'evidence' : 'payload', text, required],
      ],
    })),
  ];
  return { tables, create: tables.map((table) => `CREATE TABLE IF NOT EXISTS ${table.name} (`
    + table.columns.map((column) => column.join(' ')).join(', ')
    + (table.keys.length > 1 ? `, PRIMARY KEY(${table.keys.join(', ')})` : '') + ')') };
}
