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
import { rtreeDdl } from './rtree-ddl.js';
import { readExpression } from './expression-read.js';

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
 * A guarded PRAGMA word: a pragma's name and a keyword value (journal
 * modes and the like) are closed word sets, never interpolated user
 * text.
 * @param {string} word
 * @returns {string}
 */
function pragmaWord(word) {
  if (!/^[a-z_]+$/i.test(String(word)))
    throw new TypeError(`not a PRAGMA keyword: '${word}'`);
  return String(word);
}

/**
 * A guarded PRAGMA value: an integer spelled whole, or a keyword from a
 * closed set. Anything else is refused here, so no unvalidated value
 * can reach the statement text.
 * @param {number | string} value
 * @returns {string}
 */
function pragmaValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`not a PRAGMA value: ${value}`);
    return String(Math.trunc(value));
  }
  return pragmaWord(value);
}

/** SQLite's own per-row identity: the implicit `rowid` of every
 * table this store creates, which is INSERTION order. */
const rowIdentity = () => '"rowid"';

/** The R*Tree module and the shape this store gives it: the row id and
 * the four box edges in (minx, maxx, miny, maxy) order, which is the
 * (w, e, s, n) a bbox index covers its columns in. The three shadow
 * tables SQLite creates beside a virtual table are its own storage —
 * deterministic from the name, and dropped with it. */
const RTREE = Object.freeze({
  module: 'rtree',
  columns: Object.freeze(['id', 'minx', 'maxx', 'miny', 'maxy']),
});

/**
 * The schema type a declared column type came from. `INTEGER` carries
 * both `integer` and `boolean` in this mapping and `ANY` carries no
 * type at all, so the inverse is partial by construction — which is
 * what the introspector's loss report exists to say.
 * @param {string} declaredType
 * @returns {string | undefined}
 */
function schemaTypeOf(declaredType) {
  switch (String(declaredType).toUpperCase()) {
    case 'TEXT': return 'string';
    case 'INTEGER': return 'integer';
    case 'REAL': return 'number';
    default: return undefined;
  }
}

/**
 * The member path a generated column's expression reads, recovered
 * from this dialect's own spelling: `jsonb_extract("doc", '<path>')`
 * over a path text this same module wrote. Anything else — a hand-made
 * column, another tool's expression — answers `null`, and the caller
 * reports the column rather than inventing a path for it.
 * @param {string} expression
 * @returns {import('../dialect.js').JsonPathSegment[] | null}
 */
function memberPathOf(expression) {
  const match = /^\s*\(*\s*jsonb_extract\s*\(\s*"[^"]*"\s*,\s*'((?:[^']|'')*)'\s*\)\s*\)*\s*$/
    .exec(String(expression));
  if (match === null) return null;
  return parsePathText(match[1].replace(/''/g, "'"));
}

/**
 * `$."a"."b"[0]` back into typed segments — the inverse of
 * {@link jsonPathText}, and only of that: a path shape this module
 * cannot have written answers `null`.
 * @param {string} text
 * @returns {import('../dialect.js').JsonPathSegment[] | null}
 */
function parsePathText(text) {
  if (!text.startsWith('$')) return null;
  /** @type {import('../dialect.js').JsonPathSegment[]} */
  const segments = [];
  let i = 1;
  while (i < text.length) {
    if (text[i] === '.') {
      if (text[i + 1] !== '"') return null;
      const end = text.indexOf('"', i + 2);
      if (end < 0) return null;
      segments.push({ name: text.slice(i + 2, end) });
      i = end + 1;
      continue;
    }
    if (text[i] === '[') {
      const end = text.indexOf(']', i + 1);
      if (end < 0) return null;
      const body = text.slice(i + 1, end);
      // `[#-1]` is how this dialect writes a negative index
      const index = body.startsWith('#') ? Number(body.slice(1)) : Number(body);
      if (!Number.isInteger(index)) return null;
      segments.push({ index });
      i = end + 1;
      continue;
    }
    return null;
  }
  return segments.length === 0 ? null : segments;
}

/**
 * The declared index EXPRESSION a generated column computes, out of the
 * SQL this dialect wrote for it. `byName` maps the engine's function
 * name back to the model's — here that is the `jaren_x_` registration,
 * which the store made from the model's own name.
 * @param {string} expression
 * @param {Record<string, string>} byName
 * @returns {any | null}
 */
function expressionOf(expression, byName) {
  return readExpression(expression, {
    memberOf: (text) => {
      const segments = memberPathOf(text);
      return segments === null ? null : { member: pathOf(segments) };
    },
    nameOf: (name) => byName[name] ?? null,
    stringOf: (text) => (/^'(?:[^']|'')*'$/.test(text)
      ? text.slice(1, -1).replace(/''/g, "'") : null),
  });
}

/** A recovered segment list, in the spelling a model's path takes. */
function pathOf(segments) {
  let text = '$';
  for (const segment of segments) {
    if ('index' in segment) { text += `[${segment.index}]`; continue; }
    text += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.name)
      ? `.${segment.name}` : `[${JSON.stringify(segment.name)}]`;
  }
  return text;
}

/**
 * The generated columns of one table, out of the CREATE text SQLite
 * stored for it — the only place the expression lives here, since no
 * pragma reports one.
 * @param {any[]} rows - the `introspect.generated` answer
 * @returns {{ name: string, expression: string }[]}
 */
function readGenerated(rows) {
  const out = [];
  for (const row of rows) {
    const sql = String(row?.sql ?? '');
    // `"<name>" <type> GENERATED ALWAYS AS (<expression>) VIRTUAL|STORED`
    const pattern = /"((?:[^"]|"")*)"\s+\w+\s+GENERATED\s+ALWAYS\s+AS\s*\(/gi;
    let match = pattern.exec(sql);
    while (match !== null) {
      // the expression runs to the parenthesis that closes the one the
      // match ended on, so a nested call inside it is not the end
      let depth = 1;
      let i = pattern.lastIndex;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "'") {
          i = sql.indexOf("'", i + 1);
          if (i < 0) break;
        }
        else if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') depth -= 1;
        i += 1;
      }
      if (depth !== 0) break;
      out.push({ name: match[1].replace(/""/g, '"'), expression: sql.slice(pattern.lastIndex, i - 1) });
      pattern.lastIndex = i;
      match = pattern.exec(sql);
    }
  }
  return out;
}

export const sqliteDialect = createDialect({
  name: 'sqlite',
  capabilities: {
    jsonb: true,
    generatedColumns: true,
    indexableGeneratedColumns: true,
    // `ANY` is a STRICT table's honest answer for a path the schema
    // does not type, and it compares with a bound value of any type
    untypedColumns: true,
    returning: true,
    upsert: true,
    savepoints: true,
    // a SAVEPOINT outside a transaction starts one, which is why a
    // top-level transaction here is one checkpoint rather than a block
    savepointStartsTransaction: true,
    immediateTransactions: true,
    alterTableFull: false,
    virtualTables: true,
    triggers: true,
    pragmas: true,
    declaredSqlText: true,
    // foreign_keys defaults OFF and is set per connection, so this is
    // the one engine in the suite that must verify it took
    foreignKeysAlwaysOn: false,
    // the implicit `rowid` every non-WITHOUT ROWID table carries
    rowIdentity: true,
    // a GROUP BY / ORDER BY term may name a result alias, so a bucket
    // ladder is written once rather than three times
    groupByAlias: true,
  },
  tableSuffix: ' STRICT',
  // a generated column over `jsonb_extract` is cheap to recompute and
  // costs nothing on disk, so it is VIRTUAL; the value is materialised
  // only in the index over it
  generatedStorage: 'VIRTUAL',
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
  // SQLite keeps the two number types it stores apart, so a JSON number
  // is one of two names here
  numericTypeNames: ['integer', 'real'],
  jsonObject: (pairsSql) => `json_object(${pairsSql})`,
  // `json()` tags the value with SQLite's JSON subtype, which is what
  // makes an enclosing `json_object` embed it rather than quote it
  jsonEmbed: (columnSql) => `json(${columnSql})`,
  // a dynamically typed engine binds an external as itself and compares
  // it with whatever the member holds
  externalEncoding: 'value',
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
  rowIdentity,
  // membership of the row identity in a bound list — the fetch of a
  // k-nearest plan's candidates. `IN` over the rowid is a primary-key
  // lookup per value; a NULL in the list matches no row, which is what
  // lets a caller pad a batch
  identityIn: (identitySql, paramSqls) => `${identitySql} IN (${paramSqls.join(', ')})`,
  rtree: RTREE,
  rtreeDdl: rtreeDdl({ quoteIdentifier, rowIdentity, rtree: RTREE }),
  schemaTypeOf,
  memberPathOf,
  expressionOf,
  readGenerated,
  explainQuery: (sql) => `EXPLAIN QUERY PLAN ${sql}`,
  // SQLite's plan is PROSE, one `detail` column per row
  explainLines: (rows) => rows.map((row) => String(row.detail)),
  // `SCAN <table>` with no index behind it is the full read; a join
  // statement's narrative names the ALIAS the emitter gave the table,
  // which is why an alias shape counts as one too
  isFullScan: (line, tables) =>
    (/^SCAN t\d+\b/.test(line) || tables.some((table) => line.startsWith(`SCAN ${table}`)))
    && !line.includes('USING INDEX'),
  usesIndex: (line, index) =>
    line.includes(`USING INDEX ${index}`) || line.includes(`USING COVERING INDEX ${index}`),
  excludedRef: (columnSql) => `excluded.${columnSql}`,
  tx: {
    begin: 'BEGIN',
    beginImmediate: 'BEGIN IMMEDIATE',
    deferForeignKeys: 'PRAGMA defer_foreign_keys = ON',
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    savepoint: (n) => `SAVEPOINT ${quoteIdentifier(n)}`,
    release: (n) => `RELEASE SAVEPOINT ${quoteIdentifier(n)}`,
    rollbackTo: (n) => `ROLLBACK TO SAVEPOINT ${quoteIdentifier(n)}`,
  },
  pragma: {
    // the one configuration spelling: the name comes from the store's
    // closed pragma table and the value from its validators, and both
    // are guarded again here
    set: (name, value) => `PRAGMA ${pragmaWord(name)} = ${pragmaValue(value)}`,
    foreignKeys: (on) => `PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`,
    foreignKeyCheck: () => 'PRAGMA foreign_key_check',
    // the maintenance operations: a checkpoint mode is a closed word,
    // an integrity-check limit a whole integer
    walCheckpoint: (mode) => `PRAGMA wal_checkpoint(${pragmaWord(mode)})`,
    integrityCheck: (limit) => (limit === undefined
      ? 'PRAGMA integrity_check'
      : `PRAGMA integrity_check(${pragmaValue(limit)})`),
    optimize: () => 'PRAGMA optimize',
  },
  introspect: {
    version: () => 'SELECT sqlite_version() AS version',
    // the read-back of one configuration pragma: `PRAGMA name` answers
    // one row whose single column carries the value in effect
    pragma: (name) => `PRAGMA ${pragmaWord(name)}`,
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
    // every table this store might own: the engine's own are excluded
    // by name, and a VIEW is reported rather than derived
    tables: () =>
      "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') "
      + "AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    // the CREATE text is where a generated column's expression lives
    generated: (table) =>
      `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ${stringLiteral(table)}`,
    // the whole declared schema, for shape-equality comparison after a
    // rebuild: every object that carries SQL text, in a stable order
    schemaDump: () =>
      "SELECT type, name, tbl_name AS owner, sql FROM sqlite_schema "
      + "WHERE sql IS NOT NULL ORDER BY type, name",
  },
});
