//@ts-check
/**
 * @file The SQLite dialect — the first spelling of the dialect
 * contract, not the only conceivable one. Documents are stored JSONB
 * in a BLOB column of a STRICT table; indexed paths become virtual
 * generated columns over `jsonb_extract`; reads render back to text
 * through `json()`. Parameters are positional (`?`) because every
 * binding this package ships binds arrays.
 */

import { createDialect, stringLiteral, MEMBER_WHEN } from '../dialect.js';
import { rtreeDdl } from './rtree-ddl.js';
import { readExpression } from './expression-read.js';
import { SQLITE, sqliteInvariantTriggers } from './invariant-sql.js';
import { sqliteChecks, SQLITE_PREDICATE } from './check-read.js';
import { OWNER_TABLE } from '../engine-metadata.js';
import { modelPath } from '../model-path.js';

/** @param {string} s */
function quoteIdentifier(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * SQLite JSON path text from typed segments. Object members are always
 * quoted (`$."name"`), which covers spaces, dots and leading digits.
 * SQLite decodes JSON escapes inside a quoted label, so a backslash is
 * written doubled and the path addresses the member literally named —
 * never the member an escape spelled in the name would decode to, and
 * never an invalid escape stored into the document. A member name
 * SQLite's path grammar cannot carry on every qualified version — an
 * embedded `"`, since the earliest qualified SQLite ends a quoted label
 * at its first quote, escaped or not, or a control character — returns
 * `null` so the caller falls back to a whole-document strategy instead
 * of emitting a wrong path.
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
    text += `."${segment.name.replace(/\\/g, '\\\\')}"`;
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
 * table this store creates, which is INSERTION order. SQLite resolves a
 * name to a column of the table before it resolves it to the row, and
 * `rowid`, `oid` and `_rowid_` name the same row, so given the names of a
 * table's columns the identity is the first of the three that none of them
 * takes (names compare with ASCII case folded), and `null` when they take
 * all three. Without the names it is `rowid`, for the tables whose columns
 * the store names itself.
 * @type {{ (): string, (columns: readonly string[]): string | null }} */
const rowIdentity = /** @type {any} */ ((/** @type {readonly string[] | undefined} */ columns) => {
  if (columns === undefined) return '"rowid"';
  const taken = new Set(columns.map((name) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())));
  const alias = ['rowid', 'oid', '_rowid_'].find((name) => !taken.has(name));
  return alias === undefined ? null : `"${alias}"`;
});

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
 * from this dialect's own spelling: `jsonb_extract("doc", '<path>')`, or
 * the same read with its numbers as doubles (the `key` read), over a path
 * text this same module wrote. Anything else — a hand-made
 * column, another tool's expression — answers `null`, and the caller
 * reports the column rather than inventing a path for it.
 * @param {string} expression
 * @returns {import('../dialect.js').JsonPathSegment[] | null}
 */
function memberPathOf(expression) {
  const text = String(expression);
  const match = PLAIN_READ.exec(text) ?? KEY_READ.exec(text);
  if (match === null) return null;
  return parsePathText(match[1].replace(/''/g, "'"));
}

/**
 * The key a unique index holds for a member the untyped column holds as an
 * object or an array. The column holds a container as its JSONB, whose bytes
 * follow the order its members were written in, so two objects the query
 * engine compares equal (`{"a":1,"b":2}`, `{"b":2,"a":1}`) would be two keys.
 * This key is the container's text with its members in one order: one entry
 * per node of the tree (its path, its JSON type, and a string as its quoted
 * text or a number as the double the engine holds, printed exactly), sorted by
 * path, so two containers are one key exactly when the engine compares them
 * equal. It reads a table-valued function, which no index expression or
 * generated column may, so a trigger writes it into a plain column of the
 * table after every write of the document, and the unique index keys that
 * column. A member's name is keyed as it reads decoded, so a name a writer
 * spelled with escapes (`"\u0041"`) is the name spelled without (`"A"`).
 */
const CONTAINER_KEY = Object.freeze({
  /**
   * Whether the member at `pathText` of the document is an object or an array.
   * @param {string} documentSql @param {string} pathText
   * @returns {string}
   */
  holds: (documentSql, pathText) => `json_type(${documentSql}, ${stringLiteral(pathText)}) IN ('object', 'array')`,
  /**
   * The key of the container at `pathText`, NULL where the member is none.
   * @param {string} documentSql @param {string} pathText
   * @returns {string}
   */
  read: (documentSql, pathText) => `(CASE WHEN ${CONTAINER_KEY.holds(documentSql, pathText)} THEN ${containerText(documentSql, pathText)} END)`,
  /**
   * The two triggers that keep the key column of one member: after an insert
   * of a document that holds a container there, and after an update of the
   * document that holds one there or held one.
   * @param {{ table: string, keyColumn: string, docColumn: string, column: string, pathText: string }} shape
   * @returns {{ name: string, sql: string }[]}
   */
  triggers: ({ table, keyColumn, docColumn, column, pathText }) => {
    const q = quoteIdentifier;
    const row = `WHERE ${q(keyColumn)} = NEW.${q(keyColumn)}`;
    const holds = CONTAINER_KEY.holds(`NEW.${q(docColumn)}`, pathText);
    const insert = `${table}$${column}$insert`, update = `${table}$${column}$update`;
    return [
      { name: insert,
        sql: `CREATE TRIGGER ${q(insert)} AFTER INSERT ON ${q(table)} WHEN ${holds} BEGIN `
          + `UPDATE ${q(table)} SET ${q(column)} = ${containerText(`NEW.${q(docColumn)}`, pathText)} ${row}; END` },
      { name: update,
        sql: `CREATE TRIGGER ${q(update)} AFTER UPDATE OF ${q(docColumn)} ON ${q(table)} `
          + `WHEN NEW.${q(column)} IS NOT NULL OR ${holds} BEGIN `
          + `UPDATE ${q(table)} SET ${q(column)} = ${CONTAINER_KEY.read(`NEW.${q(docColumn)}`, pathText)} ${row}; END` },
    ];
  },
});

/**
 * The text {@link CONTAINER_KEY} keys a container by: its nodes, each as its
 * quoted path (each member's name decoded and quoted as JSON text quotes it,
 * each element's index in brackets), then its {@link scalarText}, sorted by
 * path. The paths are built from the root down, one level of members at a
 * time, because the path a table-valued function reports spells each name as
 * the document does.
 * @param {string} documentSql @param {string} pathText
 * @returns {string}
 */
function containerText(documentSql, pathText) {
  const n = (/** @type {string} */ column) => `"n".${quoteIdentifier(column)}`;
  return `(WITH RECURSIVE "n"("path", "type", "atom", "value") AS (`
    + `SELECT '', json_type(${documentSql}, ${stringLiteral(pathText)}), NULL, jsonb_extract(${documentSql}, ${stringLiteral(pathText)}) `
    + `UNION ALL SELECT ${n('path')} || (CASE WHEN ${n('type')} = 'array' THEN '[' || "e"."key" || ']' ELSE '.' || json_quote("e"."key") END), `
    + `"e"."type", "e"."atom", "e"."value" FROM "n", jsonb_each(${n('value')}) AS "e" WHERE ${n('type')} IN ('object', 'array')) `
    + `SELECT group_concat(quote(${n('path')}) || ' ' || ${scalarText(n('type'), n('atom'))}, ',' ORDER BY ${n('path')}) FROM "n")`;
}

/**
 * One JSON value as the keys of a unique index spell it where its column
 * cannot: a number as the double the query engine holds, printed exactly
 * (`-0` as `0`), a string as its quoted decoded text, any other value as its
 * JSON type (`true`, `false`, `null`; a container's members
 * {@link containerText} spells). Two scalars spell alike exactly when the
 * engine compares them equal. A value of a kind in `own` spells as `''`.
 * @param {string} typeSql - the value's `json_type`
 * @param {string} atomSql - the value as SQL reads it
 * @param {readonly string[]} [own] - kinds keyed by something else
 * @returns {string}
 */
function scalarText(typeSql, atomSql, own = []) {
  const number = `printf('%!.17g', CAST(${atomSql} AS REAL) + 0.0)`;
  const spelled = [['integer', number], ['real', number], ['text', `quote(${atomSql})`]];
  return `(CASE ${typeSql} ${[...own.map((kind) => [kind, "''"]), ...spelled.filter(([kind]) => !own.includes(kind))]
    .map(([kind, text]) => `WHEN '${kind}' THEN ${text}`).join(' ')} ELSE ${typeSql} END)`;
}

/** The kinds a typed generated column holds as themselves, by its SQL type. */
const NATIVE_KINDS = Object.freeze({ REAL: ['integer', 'real'], INTEGER: ['integer', 'real'], TEXT: ['text'] });

/**
 * The key a unique index adds after a generated column over the member at
 * `pathText`, where the column keys values of two kinds as one: the untyped
 * column holds a JSON boolean as the integer `0` or `1`, so it keys whether
 * the member is a boolean; a typed column holds a value of another kind than
 * its own as its SQL type reads it (`true` and `"1"` as the `REAL` `1.0`,
 * `1` as the `TEXT` `'1'`), so it keys `''` for a value of its own kind and
 * any other value as {@link scalarText} spells it. A value of the column's
 * own kind is keyed by the column as before, and two values the query engine
 * compares equal are one key. `null` for a column of any other type.
 * @param {string} documentSql @param {string} pathText @param {string} columnType
 * @returns {string | null}
 */
function kindKeyTerm(documentSql, pathText, columnType) {
  const type = `json_type(${documentSql}, ${stringLiteral(pathText)})`;
  const sqlType = String(columnType).toUpperCase();
  if (sqlType === 'ANY') return `(${type} IN ('true', 'false'))`;
  const native = NATIVE_KINDS[/** @type {keyof typeof NATIVE_KINDS} */ (sqlType)];
  return native === undefined ? null : scalarText(type, `json_extract(${documentSql}, ${stringLiteral(pathText)})`, native);
}

/** A member read as it is stored: {@link jsonExtract}'s default read. */
const PLAIN_READ = /^\s*\(*\s*jsonb_extract\s*\(\s*"[^"]*"\s*,\s*'((?:[^']|'')*)'\s*\)\s*\)*\s*$/;
/** A member read with its numbers as doubles: {@link jsonExtract}'s `key` read. */
const KEY_READ = /^\s*\(*\s*CASE\s+WHEN\s+json_type\s*\(\s*"[^"]*"\s*,\s*'((?:[^']|'')*)'\s*\)\s+IN\s*\(\s*'integer'\s*,\s*'real'\s*\)\s+THEN\s+CAST\s*\(\s*jsonb_extract\s*\(\s*"[^"]*"\s*,\s*'\1'\s*\)\s+AS\s+REAL\s*\)\s+ELSE\s+jsonb_extract\s*\(\s*"[^"]*"\s*,\s*'\1'\s*\)\s+END\s*\)*\s*$/i;

/**
 * Whether a generated column's expression is the `key` read
 * {@link memberPathOf} recovers a path from: the read of an untyped column
 * over a member whose union lists `number` first, which reads each number as
 * the double the engine compares and any other kind as it is stored.
 * @param {string} expression
 * @returns {boolean}
 */
const memberReadsNumbersFirst = (expression) => KEY_READ.test(String(expression));

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
      const label = text.slice(i + 2, end);
      // the one escape this module writes is a doubled backslash; SQLite
      // decodes any other, so such a label reads a member it did not name
      if (!/^(?:[^\\]|\\\\)*$/.test(label)) return null;
      segments.push({ name: label.replace(/\\\\/g, '\\') });
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
 * The JSON type name of the member at a path — `json_type`, which answers
 * `integer` and `real` apart, as the query layer and a declared interval's
 * CHECK both read it.
 * @param {string} columnSql
 * @param {string} pathText
 * @returns {string}
 */
function jsonTypeName(columnSql, pathText) {
  return `json_type(${columnSql}, ${stringLiteral(pathText)})`;
}

/**
 * How this dialect's interval CHECK reads back through the one interval
 * reader: `json_type(<doc>, '<path>')` names the document column and the
 * path as {@link jsonPathText} writes one, and a bound is an integer by
 * the document's own JSON type. The engine keeps the text verbatim, so
 * there is one spelling whatever the session.
 * @type {import('./check-read.js').IntervalSpelling}
 */
const INTERVAL_SPELLING = Object.freeze({
  ...SQLITE_PREDICATE,
  integers: 'document',
  typeOf: (tokens, at) => {
    const [call, open, column, comma, path, close] = tokens.slice(at, at + 6);
    if (call?.kind !== 'word' || call.value.toLowerCase() !== 'json_type' || open?.value !== '(' || column?.kind !== 'identifier'
      || comma?.value !== ',' || path?.kind !== 'string' || close?.value !== ')') return undefined;
    const segments = parsePathText(path.value);
    return segments === null ? undefined : { column: column.value, segments, end: at + 6 };
  },
});

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
      return segments === null ? null : { member: modelPath(segments) };
    },
    nameOf: (name) => byName[name] ?? null,
    stringOf: (text) => (/^'(?:[^']|'')*'$/.test(text)
      ? text.slice(1, -1).replace(/''/g, "'") : null),
  });
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

/** The owner lease's one row: the owner's id, the holding store's random
 * token, and the expiry in epoch milliseconds. */
const OWNER_COLUMNS = '("slot" INTEGER PRIMARY KEY CHECK ("slot" = 1), "owner" TEXT NOT NULL, '
  + '"holder" TEXT NOT NULL, "expires_at" INTEGER NOT NULL) STRICT';

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
    // nothing in the file carries a function: a registered one exists on
    // the connection that registered it alone
    catalogFunctions: false,
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
  // JSON-valued consumers need the encoded member, including quotes around
  // strings and the original boolean spelling; jsonb_extract returns SQL
  // scalars for these and json() cannot recover their JSON representation.
  // A number a GROUP KEY reads is the double the engine holds, the double
  // nearest to the stored text: an integer text past 2^53 is no JavaScript
  // number a driver can hand back, and a double is what the engine compares.
  // `double` reads a member that holds numbers and nothing else; `key` one
  // that may hold any scalar, and casts only what is a number.
  jsonExtract: (columnSql, pathText, kind) => {
    const member = stringLiteral(pathText);
    switch (kind) {
      case 'json': return `(${columnSql} -> ${member})`;
      case 'double': return `CAST(jsonb_extract(${columnSql}, ${member}) AS REAL)`;
      case 'key':
        return `(CASE WHEN json_type(${columnSql}, ${member}) IN ('integer', 'real') `
          + `THEN CAST(jsonb_extract(${columnSql}, ${member}) AS REAL) ELSE jsonb_extract(${columnSql}, ${member}) END)`;
      default: return `jsonb_extract(${columnSql}, ${member})`;
    }
  },
  // a unique index's key after a column that keys two kinds as one value
  kindKeyTerm,
  containerKey: CONTAINER_KEY,
  // the engine-specific piece of a declared interval's CHECK beside
  // `jsonTypeOf`: each bound held to an integer by ITS JSON type — `IS`,
  // not `=`, because a half span's absent bound reads NULL and a CHECK
  // passes a NULL comparison; the column itself cannot tell, since an
  // INTEGER column reads a JSON boolean as 1 or 0
  integerBounds: ({ docColumnSql, start, end }) =>
    `json_type(${docColumnSql}, ${stringLiteral(start.pathText)}) IS 'integer' AND `
    + `json_type(${docColumnSql}, ${stringLiteral(end.pathText)}) IS 'integer'`,
  intervalSpelling: () => INTERVAL_SPELLING,
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
  // a merge patch sets a member a scalar value names and, with nothing to
  // patch, none: the document is named once
  [MEMBER_WHEN]: (exprSql, memberName, valueSql, whenSql) =>
    `jsonb_patch(${exprSql}, CASE WHEN ${whenSql} `
    + `THEN json_object(${stringLiteral(memberName)}, ${valueSql}) ELSE '{}' END)`,
  jsonRemove: (exprSql, pathText) =>
    `jsonb_remove(${exprSql}, ${stringLiteral(pathText)})`,
  jsonAppend: (exprSql, arrayPathText, valueSql) =>
    `jsonb_insert(${exprSql}, ${stringLiteral(`${arrayPathText}[#]`)}, ${valueSql})`,
  jsonEncode: (paramSql) => `jsonb(${paramSql})`,
  jsonText: (columnSql) => `json(${columnSql})`,
  jsonAgg: (exprSql) => `json_group_array(${exprSql})`,
  jsonTypeOf: jsonTypeName,
  // the same call names a member's JSON type in a declared interval's CHECK
  jsonTypeName,
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
  // Membership in a JSON list bound as ONE parameter: one statement text
  // for every list length, no parameter ceiling, and an index SEARCH on
  // the value when it has one. The list's items are an array's elements
  // or an object's member values — `key IS NOT NULL` keeps a bare scalar
  // out, as the engine's `$x[*]` does — of one kind at a time
  inList: (valueSql, listSql, kind) => `${valueSql} IN (SELECT value FROM json_each(${listSql}) `
    + `WHERE key IS NOT NULL AND type ${kind === 'text' ? "= 'text'" : "IN ('integer', 'real')"})`,
  // the half-open range over the prefix, which an index on the value
  // can seek; `substr(value, 1, n) = p` and `value LIKE 'p%'` both read
  // every row. SQLite's default BINARY collation compares UTF-8 bytes,
  // which orders code points, so the range holds exactly the values
  // that begin with the prefix
  strStartsWith: (valueSql, lowerParamSql, upperParamSql) =>
    `(${valueSql} >= ${lowerParamSql} AND ${valueSql} < ${upperParamSql})`,
  strStartsWithExact: (valueSql, patternA, patternB) =>
    `substr(${valueSql}, 1, length(${patternA})) = ${patternB}`,
  // over the bytes: a text's `length` stops at its first U+0000, so a
  // pattern that begins with one read as empty and a value that holds one
  // was cut short before its suffix was taken. A byte suffix as long as
  // the pattern's bytes starts where a character does (the pattern's
  // first byte leads one; on a UTF-16 file both lengths are whole units);
  // `IS`, because the suffix of an empty blob is NULL, which a `NOT`
  // would keep NULL
  strEndsWith: (valueSql, patternA, patternB, patternC) =>
    `(length(CAST(${patternA} AS BLOB)) = 0 OR substr(CAST(${valueSql} AS BLOB), `
    + `-length(CAST(${patternB} AS BLOB))) IS CAST(${patternC} AS BLOB))`,
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
  // `rows` is COUNT(*) — the count of SOURCE rows, which is not
  // COUNT(value): a measured gap is a row that reported nothing, and
  // the difference between "nobody reported" and "everybody reported a
  // gap" is exactly what the count is for
  groupAggregate: (fn, valueSql) => (valueSql === null
    ? 'COUNT(*)'
    : `${{ sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[fn]}(${valueSql})`),
  // an integer text past 2^53 is stored as an INTEGER the driver refuses to
  // hand back (JD2003) and compares exactly, where the engine holds and
  // compares the double nearest to it
  numberRead: (sql) => `CAST(${sql} AS REAL)`,
  // and so a stored JSON integer is read by its digits, and compared exactly
  integerDigits: true,
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
  memberReadsNumbersFirst,
  expressionOf,
  readGenerated,
  explainQuery: (sql) => `EXPLAIN QUERY PLAN ${sql}`,
  // SQLite's plan is PROSE, one `detail` column per row
  explainLines: (rows) => rows.map((row) => String(row.detail)),
  // `SCAN <table>` with no index behind it is the full read; a join
  // statement's narrative names the ALIAS the emitter gave the table
  // (`t0`, … for a binding, `h0`, … for a related entity a hop reads),
  // which is why an alias shape counts as one too
  isFullScan: (line, tables) =>
    (/^SCAN [th]\d+\b/.test(line) || tables.some((table) => line.startsWith(`SCAN ${table}`)))
    && !line.includes('USING INDEX'),
  usesIndex: (line, index) =>
    line.includes(`USING INDEX ${index}`) || line.includes(`USING COVERING INDEX ${index}`),
  excludedRef: (columnSql) => `excluded.${columnSql}`,
  // node:sqlite binds a JavaScript number as a REAL, which a TEXT column
  // stores as SQLite's REAL-to-TEXT spelling ('7.0' for 7); every numeric
  // key is now bound as its canonical JSON text, and this is how a read
  // still finds a row an earlier write stored the old way — the CAST
  // chain spells it identically whatever the driver bound the number as
  legacyNumericKeyText: (ref) => `CAST(CAST(${ref} AS REAL) AS TEXT)`,
  tx: {
    begin: 'BEGIN',
    // the write lock up front: this IS the store's writer lock, so no
    // second statement follows it (`writerLock` is absent)
    beginImmediate: 'BEGIN IMMEDIATE',
    // one writer at a time, and a reader that would write after another
    // writer committed is refused (SQLITE_BUSY_SNAPSHOT): every
    // transaction is serializable, whatever floor was asked for
    isolationLevels: Object.freeze(['serializable']),
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
  invariantTriggers: sqliteInvariantTriggers,
  // an index condition reads plain columns, its truth values 1 and 0
  rowPredicateFlavor: SQLITE,
  // The invalid path is evaluated only on overflow and carries a distinct
  // marker through SQLite's error boundary, before any source row is written.
  codepoint: (value) => `(${value} COLLATE BINARY)`,
  mutationRowGuard: (count, limit) => `CASE WHEN ${count} > ${limit} `
    + "THEN json_extract('{}', 'jaren-mutation-row-bound') ELSE 1 END",
  physicalRead: (codec, sql) => codec === 'bigint' ? `CAST(${sql} AS TEXT)`
    : codec === 'blob-hex' ? `CASE WHEN ${sql} IS NULL THEN NULL ELSE hex(${sql}) END` : sql,
  physicalTypeMatches: (codec, type) => (codec === 'blob-hex' ? /BLOB/
    : ['integer', 'bigint', 'boolean', 'epoch-ms'].includes(codec) ? /INT/
      : codec === 'number' ? /REAL|FLOA|DOUB/ : /TEXT|CHAR|CLOB/).test(type),
  introspect: {
    version: () => 'SELECT sqlite_version() AS version',
    // the read-back of one configuration pragma: `PRAGMA name` answers
    // one row whose single column carries the value in effect
    pragma: (name) => `PRAGMA ${pragmaWord(name)}`,
    compileOptions: () =>
      'SELECT compile_options AS name FROM pragma_compile_options',
    tableExists: () =>
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    // what a name is — a table, a view — and whether it keeps rowids
    // (`wr` is 1 for WITHOUT ROWID); bound, so any name reads as data
    tableKind: () => 'SELECT schema, type, wr FROM pragma_table_list(?)',
    columns: (table) =>
      `SELECT name, type, hidden, pk, "notnull" AS not_null, dflt_value AS default_value `
      + `FROM pragma_table_xinfo(${stringLiteral(table)}) ORDER BY cid`,
    indexes: (table) =>
      `SELECT name, "unique" AS uniq, origin, partial FROM pragma_index_list(${stringLiteral(table)})`,
    indexColumns: (index) =>
      `SELECT name FROM pragma_index_info(${stringLiteral(index)})`,
    foreignKeysOn: () => 'SELECT foreign_keys AS enabled FROM pragma_foreign_keys',
    dataVersion: () => 'SELECT data_version AS v FROM pragma_data_version',
    foreignKeyList: (table) =>
      `SELECT "table" AS target, "from" AS source_column, "to" AS target_column, `
      + `on_delete, on_update, id, seq, match FROM pragma_foreign_key_list(${stringLiteral(table)}) `
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
    checks: (table) =>
      `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ${stringLiteral(table)}`,
    // the whole declared schema, for shape-equality comparison after a
    // rebuild: every object that carries SQL text, in a stable order
    schemaDump: () =>
      "SELECT type, name, tbl_name AS owner, sql FROM sqlite_schema "
      + "WHERE sql IS NOT NULL ORDER BY type, name",
    objects: () =>
      'SELECT type, name, tbl_name AS owner, sql FROM sqlite_schema '
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  },
  readChecks: sqliteChecks,
  // the owner lease (MODEL-FORMAT §5.1): one row in an engine table,
  // taken in the first-open immediate bracket, renewed on a timer and
  // deleted on close. `create` is the one statement an operator runs for
  // an adopted store, which creates nothing itself
  owner: Object.freeze({
    kind: 'lease',
    table: OWNER_TABLE,
    create: `CREATE TABLE "${OWNER_TABLE}" ${OWNER_COLUMNS}`,
    ensure: `CREATE TABLE IF NOT EXISTS "${OWNER_TABLE}" ${OWNER_COLUMNS}`,
    read: `SELECT "owner", "holder", "expires_at" AS "expiresAt" FROM "${OWNER_TABLE}" WHERE "slot" = 1`,
    take: `INSERT INTO "${OWNER_TABLE}" ("slot", "owner", "holder", "expires_at") VALUES (1, ?, ?, ?) `
      + 'ON CONFLICT ("slot") DO UPDATE SET "owner" = excluded."owner", "holder" = excluded."holder", '
      + '"expires_at" = excluded."expires_at"',
    renew: `UPDATE "${OWNER_TABLE}" SET "expires_at" = ? WHERE "slot" = 1 AND "holder" = ?`,
    release: `DELETE FROM "${OWNER_TABLE}" WHERE "slot" = 1 AND "holder" = ?`,
  }),
});

/** SQLite schema inspection and identity preservation statements. */
export const sqliteTableMigration = Object.freeze({
    binaryCast: (sql) => `CAST(${sql} AS BLOB)`,
    schema: () => "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,7) <> 'sqlite_' ORDER BY type,name",
    tableList: () => 'PRAGMA table_list',
    sequenceExists: () => "SELECT 1 AS present FROM sqlite_schema WHERE name='sqlite_sequence'",
    sequence: () => 'SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name=?',
    raiseSequence: () => 'UPDATE sqlite_sequence SET seq=MAX(seq,CAST(? AS INTEGER)) WHERE name=?',
    seedSequence: () => 'INSERT INTO sqlite_sequence(name,seq) SELECT ?,CAST(? AS INTEGER) WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=?)',
});

/** Infer the storage declaration for a physical codec.
 * @param {string} codec @returns {string} */
export function sqlitePhysicalColumnType(codec) {
  return ['integer', 'bigint', 'boolean', 'epoch-ms'].includes(codec)
    ? 'INTEGER' : codec === 'number' ? 'REAL' : codec === 'blob-hex' ? 'BLOB' : 'TEXT';
}
