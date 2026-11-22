//@ts-check
/**
 * @file The catalog reads an open and a migration verify tables with: one
 * read of the namespace per catalog — a table's existence, its columns,
 * indexes and their columns, foreign keys, CHECKs, generated expressions and
 * stored CREATE text — over every table one verification pass names, keyed
 * by table (an index's own reads by index), in place of one read of each per
 * table. A pass takes its reader with {@link withNamespaceCatalog} and reads
 * with {@link catalogRows}, which answers what the per-table statement
 * answers, in its order: from the shared read for a table that existed when
 * the read was made, and through the per-table statement itself for any
 * other (a table the read did not find, so a pass probes a table it is
 * about to create just before it creates it; a virtual table; an index
 * created since) and on a connection that carries no reader. Each catalog is read when the
 * pass first asks for it, as of that moment. Every catalog read prepares
 * `CATALOG_READ`: one plain query, its rows buffered under the driver's row
 * and byte bound, never a cursor (on PostgreSQL a cursor is three round
 * trips: DECLARE, FETCH and CLOSE).
 */
import { chain, useStatementOnce } from './driver.js';

/** The preparation metadata of a catalog read. */
export const CATALOG_READ = Object.freeze({ buffered: true });

/** Where a connection view carries its pass's reader. */
const CATALOG = Symbol('namespace catalog');

/** The catalogs read per index rather than per table. */
const BY_INDEX = new Set(['indexColumns', 'indexKeyColumns']);

/**
 * A row without one of its columns, on the prototype the driver gave it
 * (node:sqlite answers rows without one), its other columns in their order.
 * @param {any} row @param {string} column @returns {any}
 */
function without(row, column) {
  const out = Object.create(Object.getPrototypeOf(row));
  for (const key of Object.keys(row)) if (key !== column) out[key] = row[key];
  return out;
}

/**
 * The rows the per-table statement answers, read by that statement:
 * `tableExists` binds its name and answers its one row, or none.
 * @param {any} connection @param {string} kind @param {string} key
 * @returns {any} value-or-promise of the rows
 */
function ownRows(connection, kind, key) {
  const introspect = connection.dialect.introspect;
  return kind === 'tableExists'
    ? useStatementOnce(connection, introspect.tableExists(), (statement) =>
      chain(statement.get([key]), (row) => (row === undefined || row === null ? [] : [row])), CATALOG_READ)
    : useStatementOnce(connection, introspect[kind](key), (statement) => statement.all([]), CATALOG_READ);
}

/**
 * The rows the dialect's per-table catalog statement `kind` answers for
 * `key` (a table; an index for `indexColumns` and `indexKeyColumns`): from
 * the reader the connection carries where it covers `key`, else through the
 * statement itself.
 * @param {any} connection
 * @param {string} kind - a member of the dialect's `introspect`
 * @param {string} key
 * @returns {any} value-or-promise of the rows
 */
export function catalogRows(connection, kind, key) {
  const reader = connection[CATALOG];
  return chain(reader === undefined ? null : reader(kind, key), (rows) => rows ?? ownRows(connection, kind, key));
}

/**
 * Whether the reader the connection carries answers `table` from its shared
 * read: `false` for a table it did not find, and on a connection that
 * carries none.
 * @param {any} connection @param {string} table
 * @returns {any} value-or-promise of a boolean
 */
export function catalogCovers(connection, table) {
  const reader = connection[CATALOG];
  return reader === undefined ? false : chain(reader('tableExists', table), (rows) => rows !== null);
}

/**
 * {@link catalogRows} as a statement already run: `all()` answers the rows,
 * so a site written over a prepared per-table statement reads the shared
 * read unchanged.
 * @param {any} connection @param {string} kind @param {string} key
 * @returns {any} value-or-promise of `{ all: () => any[] }`
 */
export function catalogRead(connection, kind, key) {
  return chain(catalogRows(connection, kind, key), (/** @type {any[]} */ rows) => ({ all: () => rows }));
}

/**
 * The connection view a verification pass over `tables` reads the catalog
 * through: the connection itself, carrying one reader of the namespace for
 * those tables, where the dialect reads its catalogs over many tables at once
 * (`introspect.namespace`); the connection unchanged where it does not.
 * @param {any} connection
 * @param {Iterable<string>} tables - the tables the pass verifies
 * @returns {any}
 */
export function withNamespaceCatalog(connection, tables) {
  const reads = connection.dialect.introspect.namespace;
  const names = [...new Set(tables)];
  if (reads === undefined || names.length === 0) return connection;
  const wanted = JSON.stringify(names);
  /** @type {Map<string, any>} each catalog read, by kind: value-or-promise of its rows by owner */
  const read = new Map();
  /** @param {string} kind */
  const rowsOf = (kind) => {
    if (!read.has(kind)) {
      read.set(kind, chain(useStatementOnce(connection, reads[kind](), (statement) => statement.all([wanted]), CATALOG_READ), (rows) => {
        /** @type {Map<string, any[]>} */
        const byOwner = new Map();
        for (const row of /** @type {any[]} */ (rows)) {
          const key = String(row.jaren_owner);
          if (!byOwner.has(key)) byOwner.set(key, []);
          /** @type {any[]} */ (byOwner.get(key)).push(without(row, 'jaren_owner'));
        }
        read.set(kind, byOwner);
        return byOwner;
      }));
    }
    return read.get(kind);
  };
  /** @param {string} kind @param {string} key @returns {any} value-or-promise of the rows, or `null` where it does not cover `key` */
  const reader = (kind, key) => {
    if (reads[kind] === undefined) return null;
    return chain(rowsOf('tableExists'), (/** @type {Map<string, any[]>} */ present) => {
      if (kind === 'tableExists') {
        // a table the read did not find is probed again on its own, just
        // before the pass creates it: a rival may have committed it since
        const row = present.get(key)?.[0];
        return row === undefined ? null : [without(row, 'jaren_virtual')];
      }
      if (BY_INDEX.has(kind)) return chain(rowsOf(kind), (/** @type {Map<string, any[]>} */ owned) => owned.get(key) ?? null);
      const table = present.get(key)?.[0];
      if (table === undefined || Number(table.jaren_virtual ?? 0) !== 0) return null;
      return chain(rowsOf(kind), (/** @type {Map<string, any[]>} */ owned) => owned.get(key) ?? []);
    });
  };
  return { ...connection, [CATALOG]: reader };
}
