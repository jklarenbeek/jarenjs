//@ts-check
/**
 * @file SQLite's catalog reads over a set of tables at once: each answers
 * the rows its per-table twin in the dialect's `introspect` answers, in the
 * same order and the same columns, for every table `?1` (a JSON array of
 * names) lists, each row led by the table it belongs to (`jaren_owner`; the
 * index for an index's own reads). A virtual table is listed as one
 * (`jaren_virtual`) and read by no other: its module may be absent, and
 * its own reads stay its twin's.
 */

/** A table `?1` names, as the namespace holds it. */
const WANTED = "m.type = 'table' AND m.name IN (SELECT value FROM json_each(?))";
/** The namespace's virtual tables. */
const VIRTUAL = "SELECT l.name FROM pragma_table_list l WHERE l.schema = 'main' AND l.type = 'virtual'";
/** ... that is no virtual table. */
const PLAIN = `${WANTED} AND m.name NOT IN (${VIRTUAL})`;

/** The catalog reads over the tables `?1` names, by the per-table read each stands for. */
export const sqliteNamespaceReads = Object.freeze({
  tableExists: () => `SELECT m.name AS jaren_owner, m.name IN (${VIRTUAL}) AS jaren_virtual, m.name `
    + `FROM sqlite_schema m WHERE ${WANTED}`,
  columns: () => 'SELECT m.name AS jaren_owner, p.name, p.type, p.hidden, p.pk, p."notnull" AS not_null, p.dflt_value AS default_value '
    + `FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) p WHERE ${PLAIN} ORDER BY m.name, p.cid`,
  indexes: () => 'SELECT m.name AS jaren_owner, p.name, p."unique" AS uniq, p.origin, p.partial '
    + `FROM sqlite_schema m JOIN pragma_index_list(m.name) p WHERE ${PLAIN} ORDER BY m.name, p.seq`,
  indexColumns: () => 'SELECT i.name AS jaren_owner, p.name '
    + `FROM sqlite_schema m JOIN pragma_index_list(m.name) i JOIN pragma_index_info(i.name) p WHERE ${PLAIN} ORDER BY i.name, p.seqno`,
  foreignKeyList: () => 'SELECT m.name AS jaren_owner, p."table" AS target, p."from" AS source_column, p."to" AS target_column, '
    + 'p.on_delete, p.on_update, p.id, p.seq, p.match '
    + `FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) p WHERE ${PLAIN} ORDER BY m.name, p.id, p.seq`,
  generated: () => `SELECT m.name AS jaren_owner, m.sql FROM sqlite_schema m WHERE ${PLAIN}`,
  checks: () => `SELECT m.name AS jaren_owner, m.sql FROM sqlite_schema m WHERE ${PLAIN}`,
  declaredSql: () => 'SELECT d.tbl_name AS jaren_owner, d.type, d.name, d.sql FROM sqlite_schema d '
    + `WHERE d.sql IS NOT NULL AND d.tbl_name IN (SELECT m.name FROM sqlite_schema m WHERE ${PLAIN}) `
    + 'ORDER BY d.tbl_name, d.type, d.name',
});
