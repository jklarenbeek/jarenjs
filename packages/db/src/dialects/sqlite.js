//@ts-check
/**
 * @file The SQLite dialect — the first spelling of the dialect
 * contract, not the only conceivable one. Documents are stored JSONB
 * in a BLOB column of a STRICT table; indexed paths become virtual
 * generated columns over `jsonb_extract`; reads render back to text
 * through `json()`. Parameters are positional (`?`) because every
 * binding this package ships binds arrays.
 */

import { createDialect } from '../dialect.js';

/** @param {string} s */
function quoteIdentifier(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/** @param {string} s */
function stringLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * SQLite JSON path text from typed segments. Object members are always
 * quoted (`$."name"`), which covers spaces, dots and leading digits; a
 * member name SQLite's path grammar cannot carry (an embedded `"` or a
 * control character) returns `null` so the caller falls back to a
 * whole-document strategy instead of emitting a wrong path.
 * @param {import('../dialect.js').JsonPathSegment[]} segments
 * @returns {string | null}
 */
function jsonPathText(segments) {
  let text = '$';
  for (const segment of segments) {
    if ('index' in segment) {
      text += `[${segment.index}]`;
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/["\u0000-\u001f]/.test(segment.name)) return null;
    text += `."${segment.name}"`;
  }
  return text;
}

/**
 * The declared column type for a schema-declared value type. Under
 * STRICT tables every column needs a type from the strict set; a path
 * whose schema declares none is honestly `ANY`.
 * @param {string | undefined} schemaType
 * @param {string} hint - `'key'` or `'generated'`
 * @returns {string}
 */
function typeFor(schemaType, hint) {
  switch (schemaType) {
    case 'string': return 'TEXT';
    case 'integer': return 'INTEGER';
    case 'number': return 'REAL';
    case 'boolean': return 'INTEGER';
    default: return hint === 'key' ? 'TEXT' : 'ANY';
  }
}

/**
 * A guarded PRAGMA argument: journal modes and similar keywords are a
 * closed word set, never interpolated user text.
 * @param {string} word
 * @returns {string}
 */
function pragmaWord(word) {
  if (!/^[a-z_]+$/i.test(String(word)))
    throw new TypeError(`not a PRAGMA keyword: '${word}'`);
  return String(word);
}

export const sqliteDialect = createDialect({
  name: 'sqlite',
  capabilities: {
    jsonb: true,
    generatedColumns: true,
    returning: true,
    upsert: true,
    savepoints: true,
    alterTableFull: false,
  },
  tableSuffix: ' STRICT',
  // RFC 3339 text → epoch milliseconds, in SQL: the migration planner
  // populates derived instant columns with it (rounded to the ms;
  // finer precision is the write contract's business, §10.3)
  epochFromRfc3339: (valueSql) =>
    `CAST(round((julianday(${valueSql}) - 2440587.5) * 86400000.0) AS INTEGER)`,
  docColumnType: 'BLOB',
  quoteIdentifier,
  parameterRef: () => '?',
  stringLiteral,
  booleanLiteral: (b) => (b ? '1' : '0'),
  typeFor,
  limitClause: (limit, offset) => (offset !== undefined && offset > 0
    ? `LIMIT ${limit === null ? -1 : limit} OFFSET ${offset}`
    : `LIMIT ${limit === null ? -1 : limit}`),
  jsonPathText,
  jsonExtract: (columnSql, pathText) =>
    `jsonb_extract(${columnSql}, ${stringLiteral(pathText)})`,
  jsonSet: (exprSql, pathText, valueSql) =>
    `jsonb_set(${exprSql}, ${stringLiteral(pathText)}, ${valueSql})`,
  jsonRemove: (exprSql, pathText) =>
    `jsonb_remove(${exprSql}, ${stringLiteral(pathText)})`,
  jsonAppend: (exprSql, arrayPathText, valueSql) =>
    `jsonb_insert(${exprSql}, ${stringLiteral(`${arrayPathText}[#]`)}, ${valueSql})`,
  jsonEncode: (paramSql) => `jsonb(${paramSql})`,
  jsonText: (columnSql) => `json(${columnSql})`,
  jsonAgg: (exprSql) => `json_group_array(${exprSql})`,
  jsonTypeOf: (columnSql, pathText) =>
    `json_type(${columnSql}, ${stringLiteral(pathText)})`,
  valueTypeOf: (paramSql) => `typeof(${paramSql})`,
  // the half-open range over the prefix, which an index on the value
  // can seek; `substr(value, 1, n) = p` and `value LIKE 'p%'` both read
  // every row. SQLite's default BINARY collation compares UTF-8 bytes,
  // which orders code points, so the range holds exactly the values
  // that begin with the prefix
  strStartsWith: (valueSql, lowerParamSql, upperParamSql) =>
    `(${valueSql} >= ${lowerParamSql} AND ${valueSql} < ${upperParamSql})`,
  strStartsWithExact: (valueSql, patternA, patternB) =>
    `substr(${valueSql}, 1, length(${patternA})) = ${patternB}`,
  strEndsWith: (valueSql, patternA, patternB, patternC) =>
    `(length(${patternA}) = 0 OR substr(${valueSql}, -length(${patternB})) = ${patternC})`,
  strContains: (valueSql, patternSql) => `instr(${valueSql}, ${patternSql}) > 0`,
  orderNulls: (nullsFirst) => (nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'),
  rowIdentity: () => '"rowid"',
  explainQuery: (sql) => `EXPLAIN QUERY PLAN ${sql}`,
  excludedRef: (columnSql) => `excluded.${columnSql}`,
  tx: {
    begin: 'BEGIN',
    beginImmediate: 'BEGIN IMMEDIATE',
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    savepoint: (n) => `SAVEPOINT ${quoteIdentifier(n)}`,
    release: (n) => `RELEASE SAVEPOINT ${quoteIdentifier(n)}`,
    rollbackTo: (n) => `ROLLBACK TO SAVEPOINT ${quoteIdentifier(n)}`,
  },
  pragma: {
    busyTimeout: (ms) => `PRAGMA busy_timeout = ${Math.trunc(ms)}`,
    journalMode: (mode) => `PRAGMA journal_mode = ${pragmaWord(mode)}`,
    foreignKeys: (on) => `PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`,
    foreignKeyCheck: () => 'PRAGMA foreign_key_check',
  },
  introspect: {
    version: () => 'SELECT sqlite_version() AS version',
    compileOptions: () =>
      'SELECT compile_options AS name FROM pragma_compile_options',
    tableExists: () =>
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    columns: (table) =>
      `SELECT name, type, hidden FROM pragma_table_xinfo(${stringLiteral(table)})`,
    indexes: (table) =>
      `SELECT name, "unique" AS uniq, origin FROM pragma_index_list(${stringLiteral(table)})`,
    indexColumns: (index) =>
      `SELECT name FROM pragma_index_info(${stringLiteral(index)})`,
    foreignKeysOn: () => 'SELECT foreign_keys AS enabled FROM pragma_foreign_keys',
    dataVersion: () => 'SELECT data_version AS v FROM pragma_data_version',
    foreignKeyList: (table) =>
      `SELECT "table" AS target, "from" AS source_column, "to" AS target_column, `
      + `on_delete, on_update, seq FROM pragma_foreign_key_list(${stringLiteral(table)}) `
      + 'ORDER BY id, seq',
    // Every schema object one table owns, with the CREATE text SQLite
    // stored verbatim. That text is where the physical facts no pragma
    // reports actually live — STRICT, CHECK, a generated column's
    // expression, a partial index predicate, an index term's collation
    // and direction, the primary key's position — so comparing it against
    // the planned statements is what makes "verify, never alter" true
    // rather than approximately true.
    declaredSql: (table) =>
      'SELECT type, name, sql FROM sqlite_schema '
      + `WHERE tbl_name = ${stringLiteral(table)} AND sql IS NOT NULL `
      + 'ORDER BY type, name',
    // the whole declared schema, for shape-equality comparison after a
    // rebuild: every object that carries SQL text, in a stable order
    schemaDump: () =>
      "SELECT type, name, tbl_name AS owner, sql FROM sqlite_schema "
      + "WHERE sql IS NOT NULL ORDER BY type, name",
  },
});
