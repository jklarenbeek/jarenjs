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
      // SQLite counts from the end as `[#-1]`; a bare `[-1]` is a bad path
      text += segment.index < 0 ? `[#${segment.index}]` : `[${segment.index}]`;
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
    // a GROUP BY / ORDER BY term may name a result alias, so a bucket
    // ladder is written once rather than three times
    groupByAlias: true,
  },
  tableSuffix: ' STRICT',
  // RFC 3339 text → epoch milliseconds, in SQL: the migration planner
  // populates derived instant columns with it (rounded to the ms;
  // finer precision is the write contract's business, §10.3)
  epochFromRfc3339: (valueSql) =>
    `CAST(round((julianday(${valueSql}) - 2440587.5) * 86400000.0) AS INTEGER)`,
  docColumnType: 'BLOB',
  // a `derive: 'vector'` column holds the packed little-endian binary32
  // form (`4·dims` bytes); it is a stored column on every driver, so
  // this is the whole of its SQL
  packedVectorType: 'BLOB',
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
  // a DERIVED column's expression: the member as JSON text handed to
  // the deterministic function the store registers at open. The
  // precision is a LITERAL, not a parameter — a generated column's
  // expression takes none — which is also what makes two precisions
  // over one path two different columns by declared text. Exhaustive
  // over the kind: a vector column is stored, never generated, so
  // asking for its expression is a planner defect, and an unknown kind
  // is refused rather than spelled as `jaren_bbox_undefined(...)`
  derivedExpression: (memberSql, column) => {
    switch (column.derive) {
      case 'geohash':
        return `jaren_geohash(${memberSql}, ${Math.trunc(Number(column.precision))})`;
      case 'bbox':
        return `jaren_bbox_${column.component}(${memberSql})`;
      case 'vector':
        throw new TypeError(
          "sqlite dialect: a derive: 'vector' column is stored on every driver and has no generated expression");
      default:
        throw new TypeError(
          `sqlite dialect: no generated-column expression for derive kind '${column.derive}'`);
    }
  },
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
  // the fixed bucket ladder, in integer arithmetic all the way down.
  // `origin + floor((at - origin) / every) * every` is `at` less the
  // NON-NEGATIVE remainder, and `((x % m) + m) % m` is how a language
  // whose `%` truncates towards zero (C's, and SQLite's) spells one —
  // which is the whole of why an instant before 1970 lands in its own
  // bucket rather than the one after it. The column is declared
  // INTEGER, so nothing here converts and nothing rounds.
  timeBucket: (instantSql, originSql, everyA, everyB, everyC) =>
    `(${instantSql} - (((${instantSql} - ${originSql}) % ${everyA} + ${everyB}) % ${everyC}))`,
  // `rows` is COUNT(*) — the D5 count of SOURCE rows, which is not
  // COUNT(value): a measured gap is a row that reported nothing, and
  // the difference between "nobody reported" and "everybody reported a
  // gap" is exactly what the count is for
  groupAggregate: (fn, valueSql) => (valueSql === null
    ? 'COUNT(*)'
    : `${{ sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[fn]}(${valueSql})`),
  rowIdentity: () => '"rowid"',
  // membership of the row identity in a bound list — the fetch of a
  // k-nearest plan's candidates. `IN` over the rowid is a primary-key
  // lookup per value; a NULL in the list matches no row, which is what
  // lets a caller pad a batch
  identityIn: (identitySql, paramSqls) => `${identitySql} IN (${paramSqls.join(', ')})`,
  // the R*Tree module and the shape this store gives it: the row id
  // and the four box edges in (minx, maxx, miny, maxy) order, which is
  // the (w, e, s, n) a bbox index covers its columns in. The three
  // shadow tables SQLite creates beside a virtual table are its own
  // storage — deterministic from the name, and dropped with it.
  rtree: { module: 'rtree', columns: ['id', 'minx', 'maxx', 'miny', 'maxy'] },
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
