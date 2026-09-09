//@ts-check
/**
 * @file The PostgreSQL dialect — the second spelling of the dialect
 * contract, and the reason the contract exists.
 *
 * It imports no PostgreSQL client and no runtime builtin: it is pure
 * text, exactly like the SQLite dialect beside it, so
 * `@jarenjs/db/postgres` resolves in a browser bundle and type-checks
 * with nothing installed. Transport is the driver's business
 * (`src/drivers/postgres.js`), and the driver is INJECTED — a
 * standards-shaped client or pool the host supplies.
 *
 * The mapping, in one paragraph. Documents are stored `jsonb`. An
 * indexed path becomes a STORED generated column, because PostgreSQL
 * has no indexable virtual one; its type is the schema's, and the
 * expression is guarded by `jsonb_typeof` inside a `CASE` so a document
 * whose member is the wrong JSON type stores `NULL` rather than failing
 * the INSERT — a cast that can raise is not a legal generated-column
 * expression. Text columns and text comparisons carry `COLLATE "C"`,
 * which is byte order, which is what SQLite's default `BINARY`
 * collation is: without it the same prefix range would hold different
 * rows on a database initialised in another locale. Every table this
 * dialect creates carries `rid bigserial`, because PostgreSQL has no
 * per-row identity that survives an UPDATE (`ctid` moves) and a
 * collection is a SEQUENCE — its order is insertion order, and the
 * store orders by `rowIdentity()` wherever the model says so.
 *
 * What it does NOT do, declared rather than approximated: no
 * configuration vocabulary (`pragmas: false` — a PostgreSQL server is
 * configured by its operator, not by a store at open), no stored CREATE
 * text (`declaredSqlText: false` — the drift check is the structural
 * one), no virtual tables and no triggers (so a `physical: 'rtree'`
 * column set maps back onto the B-tree over its four edge columns), no
 * up-front write lock (`BEGIN IMMEDIATE` has no analogue), and no
 * column without a scalar type — which is why a comparison against a
 * member the schema does not type reads the document rather than the
 * column.
 */

import { createDialect } from '../dialect.js';
import { readExpression } from './expression-read.js';

/** PostgreSQL truncates an identifier past this many BYTES, silently
 * and with only a notice — so two long generated names would collide
 * and one index would quietly serve another column's path. */
export const IDENTIFIER_BYTES = 63;

const UTF8 = new TextEncoder();

/**
 * @param {string} name
 * @returns {string}
 */
function quoteIdentifier(name) {
  const text = String(name);
  if (UTF8.encode(text).length > IDENTIFIER_BYTES) {
    throw new TypeError(
      `postgres dialect: the identifier '${text}' is longer than ${IDENTIFIER_BYTES} bytes, `
      + 'which PostgreSQL truncates silently — two names that share a prefix would become one');
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * A member path as the text of a PostgreSQL `text[]`, which is what
 * `#>` and `jsonb_set` navigate by. Every element is quoted and its
 * backslashes and quotes escaped, so a member named `a,b` or `}` is one
 * element rather than two.
 *
 * Two shapes return `null`, and the caller then falls back to a
 * whole-document strategy rather than addressing the wrong member: a
 * NEGATIVE array index (`#>` counts from the front only — `jsonb_set`
 * would accept one, and a path that meant different members to the read
 * and the write would be worse than no path), and a name carrying a NUL,
 * which no PostgreSQL text value can hold.
 * @param {import('../dialect.js').JsonPathSegment[]} segments
 * @returns {string | null}
 */
function jsonPathText(segments) {
  const parts = [];
  for (const segment of segments) {
    if ('index' in segment) {
      if (segment.index < 0) return null;
      parts.push(`"${segment.index}"`);
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000]/.test(segment.name)) return null;
    parts.push(`"${segment.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The same path with one more element on the end — how an append
 * addresses the position after an array's last.
 * @param {string} pathText
 * @param {string} element
 * @returns {string}
 */
function pathWith(pathText, element) {
  const body = pathText.slice(1, -1);
  return `{${body.length === 0 ? '' : `${body},`}${element}}`;
}

/**
 * The declared column type for a schema-declared value type.
 *
 * `numeric` carries BOTH JSON number types. PostgreSQL would take
 * `bigint` for an integer member, and it would be the better index —
 * but a document whose `integer` member holds `3.5` (a schema this
 * store validates against only when a validator is injected) would then
 * fail its INSERT inside a generated column's cast, and a storage
 * decision that can reject a document the model accepts is not a
 * storage decision. The cost is stated: `integer` and `number` are one
 * column type here, and introspection cannot tell them apart.
 *
 * A path the schema does not type has no honest scalar type at all, so
 * it is `jsonb` — indexable, comparable with another `jsonb`, and
 * comparable with nothing else, which is exactly what
 * `capabilities.untypedColumns: false` says.
 * @param {string | undefined} schemaType
 * @param {string} hint - `'key'` or `'generated'`
 * @returns {string}
 */
function typeFor(schemaType, hint) {
  switch (schemaType) {
    case 'string': return 'text COLLATE "C"';
    case 'integer': return 'numeric';
    case 'number': return 'numeric';
    // 1 and 0, not TRUE and FALSE. A boolean MEMBER is 1 or 0 in the
    // SQLite mapping, every shared form that touches one compares it
    // against those integers (a type test, a projected pair's own type
    // name), and a column that answered `true` would make each of those
    // an operator-resolution error rather than a row. The loss is
    // stated: introspection reads this column back as a number.
    case 'boolean': return 'smallint';
    default: return hint === 'key' ? 'text COLLATE "C"' : 'jsonb';
  }
}

/** The catalog's own spelling of a type this dialect declares, so the
 * drift check compares like with like: a collation, an allocation
 * clause and a serial's expansion are all how a type is WRITTEN, not
 * what the catalog reports it as. */
const TYPE_SYNONYMS = Object.freeze({
  BIGSERIAL: 'BIGINT', SERIAL: 'INTEGER', SMALLSERIAL: 'SMALLINT',
  INT8: 'BIGINT', INT4: 'INTEGER', INT2: 'SMALLINT', INT: 'INTEGER',
  FLOAT8: 'DOUBLE PRECISION', FLOAT4: 'REAL', BOOL: 'BOOLEAN',
  'CHARACTER VARYING': 'VARCHAR', DECIMAL: 'NUMERIC',
});

/**
 * @param {string} declaredType
 * @returns {string}
 */
function comparableColumnType(declaredType) {
  const bare = String(declaredType)
    .replace(/\s+COLLATE\s+("[^"]*"|\S+)/i, '')
    .replace(/\s+GENERATED\s+.*$/i, '')
    .replace(/\s+NOT\s+NULL$/i, '')
    .trim()
    .toUpperCase();
  return TYPE_SYNONYMS[bare] ?? bare;
}

/**
 * Whether a column of `declaredType` can be compared with a value of
 * `kind` at all. PostgreSQL resolves an operator by type, so a text
 * column against a numeric parameter is a parse error rather than a row
 * that fails its guard — the emitter reads the member out of the
 * document instead, which answers the same and merely does not seek.
 * @param {string | undefined} declaredType
 * @param {string} kind
 * @returns {boolean}
 */
function columnUsableFor(declaredType, kind) {
  if (kind === 'any') return true;
  switch (declaredType) {
    case 'string': return kind === 'text';
    case 'integer': case 'number': return kind === 'number';
    case 'boolean': return kind === 'boolean';
    default: return false;
  }
}

/**
 * The type discriminator, in the vocabulary the whole store shares —
 * SQLite's, because the row decoder reads these names in JavaScript.
 * `jsonb_typeof` answers six names and this maps the two that differ:
 * a JSON string is `text`, and a JSON boolean is `true` or `false`
 * (which is how a type test spells an equality against one). A JSON
 * number stays `number`, and `numericTypeNames` is what tells the
 * emitter so.
 * @param {string} atSql - SQL for the member, as `jsonb`
 * @returns {string}
 */
function typeOfJsonb(atSql) {
  return `(CASE WHEN jsonb_typeof(${atSql}) = 'string' THEN 'text' `
    + `WHEN jsonb_typeof(${atSql}) = 'boolean' `
    + `THEN (CASE WHEN (${atSql})::boolean THEN 'true' ELSE 'false' END) `
    + `ELSE jsonb_typeof(${atSql}) END)`;
}

/**
 * The member at a path, read as the SQL type a comparison of the given
 * KIND needs. Every typed form is a `CASE` over `jsonb_typeof`, and the
 * guard is INSIDE it for two reasons: a cast that can raise is not a
 * legal generated-column expression, and `AND` does not short-circuit,
 * so a guard beside the cast would not stop it either.
 * @param {string} columnSql
 * @param {string} pathText
 * @param {string} [kind]
 * @returns {string}
 */
function jsonExtract(columnSql, pathText, kind) {
  const at = `(${columnSql} #> ${stringLiteral(pathText)})`;
  switch (kind) {
    case 'text':
      return `((CASE WHEN jsonb_typeof(${at}) = 'string' `
        + `THEN ${columnSql} #>> ${stringLiteral(pathText)} END) COLLATE "C")`;
    case 'number':
      return `(CASE WHEN jsonb_typeof(${at}) = 'number' THEN (${at})::numeric END)`;
    case 'boolean':
      return `(CASE WHEN jsonb_typeof(${at}) = 'boolean' `
        + `THEN (CASE WHEN (${at})::boolean THEN 1 ELSE 0 END) END)`;
    // a projected SCALAR leaf: its text, whatever JSON type it is. The
    // decoder reads the type name beside it and rebuilds the value, so
    // one column that can carry every scalar is what it needs
    case 'scalar':
      return `(${columnSql} #>> ${stringLiteral(pathText)})`;
    default:
      return at;
  }
}

/**
 * The schema type a declared column type came from. Two mappings here
 * are LOSSY on the way back and the introspector's report says so:
 * `numeric` carries both `integer` and `number`, and `smallint` carries
 * a boolean member's 1 and 0. `jsonb` carries no scalar type at all.
 * @param {string} declaredType
 * @returns {string | undefined}
 */
function schemaTypeOf(declaredType) {
  switch (comparableColumnType(declaredType)) {
    case 'TEXT': case 'VARCHAR': case 'CHARACTER': return 'string';
    case 'NUMERIC': case 'DOUBLE PRECISION': case 'REAL': return 'number';
    case 'BIGINT': case 'INTEGER': case 'SMALLINT': return 'integer';
    case 'BOOLEAN': return 'boolean';
    default: return undefined;
  }
}

/** The words a re-rendered expression puts before a parenthesis that
 * are not function calls: `WHEN (`, `AND (`, and their kin. */
const SQL_WORDS = new Set(['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
  'IN', 'IS', 'BETWEEN', 'LIKE', 'COLLATE', 'SELECT', 'WHERE']);

/**
 * One PostgreSQL array literal's elements. The server RE-RENDERS the
 * literal it stored — dropping the quotes a member did not need — so
 * the parse has to take both forms, and a member named `a,b` comes back
 * quoted for exactly that reason.
 * @param {string} body - between the braces
 * @returns {string[] | null}
 */
function parseArrayLiteral(body) {
  const out = [];
  let i = 0;
  if (body.length === 0) return out;
  while (i <= body.length) {
    if (body[i] === '"') {
      let text = '';
      i += 1;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') { text += body[i + 1] ?? ''; i += 2; continue; }
        text += body[i];
        i += 1;
      }
      if (body[i] !== '"') return null;
      out.push(text);
      i += 1;
    }
    else {
      const comma = body.indexOf(',', i);
      const end = comma < 0 ? body.length : comma;
      out.push(body.slice(i, end));
      i = end;
    }
    if (i >= body.length) return out;
    if (body[i] !== ',') return null;
    i += 1;
  }
  return out;
}

/**
 * The member path a generated column's expression reads, recovered from
 * this dialect's own spelling. Every form it writes navigates with
 * `#>` or `#>>` over an array literal, and the FIRST one is the member
 * — the guard reads the same path, and a `CASE` cannot come before it.
 * Anything else answers `null`, and the caller reports the column
 * rather than inventing a path for it.
 * @param {string} expression
 * @returns {import('../dialect.js').JsonPathSegment[] | null}
 */
function memberPathOf(expression) {
  const text = String(expression);
  // and NOTHING else calls: every form `jsonExtract` writes navigates
  // with `#>` under at most a `jsonb_typeof` guard, so an expression
  // that calls anything else is a DECLARED index expression rather than
  // a member read — and reading it as a member would lose the index
  for (const call of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (call[1] === 'jsonb_typeof' || SQL_WORDS.has(call[1].toUpperCase())) continue;
    return null;
  }
  const match = /#>>?\s*'\{((?:[^']|'')*)\}'/.exec(text);
  if (match === null) return null;
  const elements = parseArrayLiteral(match[1].replace(/''/g, "'"));
  if (elements === null || elements.length === 0) return null;
  // an element that spells a whole non-negative integer is an ARRAY
  // INDEX here, exactly as it was on the way in
  return elements.map((element) => (/^(?:0|[1-9][0-9]*)$/.test(element)
    ? { index: Number(element) }
    : { name: element }));
}

/**
 * The declared index EXPRESSION a generated column computes, out of the
 * SQL this dialect wrote for it. Here the engine calls its OWN
 * immutable function, so `byName` maps the host's `sql` name back to the
 * model's — a mapping only the host's declarations carry.
 * @param {string} expression
 * @param {Record<string, string>} byName
 * @returns {any | null}
 */
function expressionOf(expression, byName) {
  return readExpression(expression, {
    memberOf: (text) => {
      // a member read here is `doc #>> '{…}'` and nothing else: the
      // typed forms belong to a plain path index, not to an expression
      if (!/#>>/.test(text)) return null;
      const segments = memberPathOf(text);
      return segments === null ? null : { member: pathOf(segments) };
    },
    nameOf: (name) => byName[name] ?? null,
    stringOf: (text) => (/^'(?:[^']|'')*'(?:::text)?$/.test(text)
      ? text.replace(/::text$/, '').slice(1, -1).replace(/''/g, "'") : null),
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
 * Build the dialect. A function rather than a constant because a host
 * may narrow it — today only the schema search path is worth naming,
 * and the default is the connection's own, which is what a disposable
 * per-run schema needs.
 * @param {{ searchPath?: string }} [options]
 * @returns {any}
 */
export function postgresDialect(options = undefined) {
  // the namespaces a catalog query looks in: the connection's own
  // search path unless the host names one, so a store opened against a
  // disposable schema introspects that schema and not `public`
  const namespaces = options?.searchPath === undefined
    ? 'ANY(current_schemas(false))'
    : stringLiteral(options.searchPath);
  const inNamespace = `n.nspname = ${namespaces}`;

  return createDialect({
    name: 'postgres',
    capabilities: {
      jsonb: true,
      generatedColumns: true,
      // STORED ones are; PostgreSQL 18's VIRTUAL ones are not, which is
      // why this dialect declares STORED and this capability true
      indexableGeneratedColumns: true,
      untypedColumns: false,
      returning: true,
      upsert: true,
      savepoints: true,
      // no `BEGIN IMMEDIATE`: a PostgreSQL transaction takes its locks
      // as it needs them, and a read-then-write body meets a
      // serialization failure rather than a busy database
      immediateTransactions: false,
      // a GROUP BY / ORDER BY term may name an output column
      groupByAlias: true,
      alterTableFull: true,
      virtualTables: false,
      triggers: false,
      pragmas: false,
      declaredSqlText: false,
      foreignKeysAlwaysOn: true,
      // through the declared `rid` column, not through `ctid`
      rowIdentity: true,
    },
    tableSuffix: '',
    // PostgreSQL has no indexable virtual generated column, so an
    // indexed path is materialised
    generatedStorage: 'STORED',
    // the identity every table this dialect creates carries. NOT
    // `GENERATED ALWAYS AS IDENTITY`: PostgreSQL allows one identity
    // column per table, and a collection with a database-allocated
    // integer key needs that slot for its key
    identityColumn: { name: 'rid', type: 'bigserial' },
    autoKeyType: 'bigserial',
    epochFromRfc3339: (valueSql) =>
      `round(EXTRACT(EPOCH FROM (${valueSql})::timestamptz) * 1000)::bigint`,
    docColumnType: 'jsonb',
    // the packed little-endian binary32 form of a `derive: 'vector'`
    // column. Deliberately NOT `vector` from pgvector: a model may not
    // name a vendor type, and the k-nearest cut is the engine's
    packedVectorType: 'bytea',
    quoteIdentifier,
    parameterRef: (i) => `$${i}`,
    stringLiteral,
    booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
    typeFor,
    comparableColumnType,
    columnUsableFor,
    limitClause: (limit, offset) => (offset !== undefined && offset > 0
      ? `LIMIT ${limit === null ? 'ALL' : limit} OFFSET ${offset}`
      : `LIMIT ${limit === null ? 'ALL' : limit}`),
    jsonPathText,
    jsonExtract,
    // Concurrent first opens can both observe an absent relation before
    // either CREATE commits. Ordinary unique violations remain failures.
    isCreateRace: (error) => error?.code === '42P07' || error?.code === '23505'
      && (error.constraint === 'pg_type_typname_nsp_index' && error.table === 'pg_type'
        || error.constraint === 'pg_class_relname_nsp_index' && error.table === 'pg_class'),
    // a DERIVED column's expression names a function the HOST supplies;
    // this dialect creates none and assumes none. Every driver this
    // package ships for PostgreSQL declares
    // `deterministicIndexableFunctions: false`, so the store computes
    // these values and writes them into ordinary columns — which is why
    // asking for the expression is a planner defect, exactly as it is
    // for a vector column on every driver
    derivedExpression: (memberSql, column) => {
      throw new TypeError(
        `postgres dialect: no generated-column expression for derive kind '${column.derive}' `
        + '— a derived column is STORED here, and the store writes its value');
    },
    jsonSet: (exprSql, pathText, valueSql) =>
      `jsonb_set(${exprSql}, ${stringLiteral(pathText)}, ${valueSql}, true)`,
    jsonRemove: (exprSql, pathText) =>
      `(${exprSql} #- ${stringLiteral(pathText)})`,
    // `-1` is the position AFTER the array's last element when
    // `insert_after` is true, which is the append this translates
    jsonAppend: (exprSql, arrayPathText, valueSql) =>
      `jsonb_insert(${exprSql}, ${stringLiteral(pathWith(arrayPathText, '-1'))}, ${valueSql}, true)`,
    jsonEncode: (paramSql) => `(${paramSql})::jsonb`,
    jsonText: (columnSql) => `(${columnSql})::text`,
    jsonEmbed: (columnSql) => `(${columnSql})`,
    jsonAgg: (exprSql) => `jsonb_agg(${exprSql})`,
    jsonObject: (pairsSql) => `jsonb_build_object(${pairsSql})`,
    jsonTypeOf: (columnSql, pathText) =>
      typeOfJsonb(`(${columnSql} #> ${stringLiteral(pathText)})`),
    // one JSON number type, so one name
    numericTypeNames: ['number'],
    // An external's value is bound as its JSON TEXT. A PostgreSQL
    // parameter's type is resolved where it is used, once, for the
    // whole statement — so one placeholder cannot be a text member's
    // operand in one branch and a numeric member's in another, and the
    // guard that keeps a row out of the wrong branch does not keep the
    // COERCION out. Bound as JSON, both branches compare in a space
    // that holds every scalar: text against text under `C`, and number
    // against number in `jsonb`'s own numeric order.
    externalEncoding: 'json',
    externalCompare: (valueSql, kind) =>
      (kind === 'number' ? `to_jsonb(${valueSql})` : valueSql),
    externalRef: (paramSql, kind) => (kind === 'text'
      ? `((((${paramSql})::jsonb) #>> '{}') COLLATE "C")`
      : `((${paramSql})::jsonb)`),
    valueTypeOf: (paramSql) => typeOfJsonb(`((${paramSql})::jsonb)`),
    // the half-open range over the prefix, seekable through a B-tree on
    // a `C`-collated column. Both operands are byte-ordered — the column
    // by its declaration, the extracted member by the `COLLATE` in
    // `jsonExtract` — which is what makes the range hold exactly the
    // values that begin with the prefix
    strStartsWith: (valueSql, lowerParamSql, upperParamSql) =>
      `(${valueSql} >= ${lowerParamSql} AND ${valueSql} < ${upperParamSql})`,
    strStartsWithExact: (valueSql, patternA, patternB) =>
      `substr(${valueSql}, 1, length(${patternA}::text)) = ${patternB}`,
    strEndsWith: (valueSql, patternA, patternB, patternC) =>
      `(length(${patternA}::text) = 0 OR right(${valueSql}, length(${patternB}::text)) = ${patternC})`,
    strContains: (valueSql, patternSql) => `strpos(${valueSql}, ${patternSql}::text) > 0`,
    orderNulls: (nullsFirst) => (nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'),
    // the same fixed ladder, in exact arithmetic: `%` truncates towards
    // zero here as it does in C, so `((x % m) + m) % m` is the
    // non-negative remainder and an instant before 1970 lands in its own
    // bucket rather than the one after it
    timeBucket: (instantSql, originSql, everyA, everyB, everyC) =>
      `(${instantSql} - (((${instantSql} - ${originSql}) % ${everyA} + ${everyB}) % ${everyC}))`,
    groupAggregate: (fn, valueSql) => (valueSql === null
      ? 'COUNT(*)'
      : `${{ sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[fn]}(${valueSql})`),
    rowIdentity: () => '"rid"',
    identityIn: (identitySql, paramSqls) => `${identitySql} IN (${paramSqls.join(', ')})`,
    schemaTypeOf,
    memberPathOf,
    expressionOf,
    // the catalog already answers one row per generated column
    readGenerated: (rows) => rows.map((row) => ({
      name: String(row.name), expression: String(row.expression ?? ''),
    })),
    explainQuery: (sql) => `EXPLAIN ${sql}`,
    // PostgreSQL's plan is prose too, under a column whose name has a
    // space in it
    explainLines: (rows) => rows.map((row) => String(row['QUERY PLAN'] ?? row.plan ?? '')),
    isFullScan: (line, tables) => {
      const match = /\bSeq Scan on (?:\w+\.)?"?([^\s"]+)"?/.exec(line);
      if (match === null) return false;
      // a join statement aliases its tables `t0`, `t1`, …, and the plan
      // names the relation with the alias after it
      return tables.includes(match[1]) || /\bSeq Scan on \S+ t\d+\b/.test(line);
    },
    usesIndex: (line, index) =>
      line.includes(`Index Scan using ${index}`)
      || line.includes(`Index Only Scan using ${index}`)
      || line.includes(`Bitmap Index Scan on ${index}`),
    excludedRef: (columnSql) => `excluded.${columnSql}`,
    tx: {
      begin: 'BEGIN',
      // no up-front write lock exists; the capability says so and the
      // store's `mode: 'immediate'` is the same transaction here
      beginImmediate: 'BEGIN',
      commit: 'COMMIT',
      rollback: 'ROLLBACK',
      savepoint: (n) => `SAVEPOINT ${quoteIdentifier(n)}`,
      release: (n) => `RELEASE SAVEPOINT ${quoteIdentifier(n)}`,
      rollbackTo: (n) => `ROLLBACK TO SAVEPOINT ${quoteIdentifier(n)}`,
    },
    introspect: {
      version: () => "SELECT current_setting('server_version') AS version",
      // the table probe binds its name, so a hostile collection name is
      // a value and never syntax
      tableExists: () =>
        'SELECT c.relname AS name FROM pg_class c '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relkind IN ('r', 'p') AND ${inNamespace} AND c.relname = $1`,
      // `hidden` is non-zero for a GENERATED column, which is the one
      // fact the shape check reads beside the name and the type
      columns: (table) =>
        'SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, '
        + "CASE WHEN a.attgenerated <> '' THEN 1 ELSE 0 END AS hidden "
        + 'FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + 'AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      // `origin` mirrors the vocabulary the shape check filters on:
      // only an index the model DECLARED is compared, and the primary
      // key's is the engine's own
      indexes: (table) =>
        'SELECT ci.relname AS name, CASE WHEN i.indisunique THEN 1 ELSE 0 END AS uniq, '
        + "CASE WHEN i.indisprimary THEN 'pk' ELSE 'c' END AS origin "
        + 'FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid '
        + 'JOIN pg_class ct ON ct.oid = i.indrelid '
        + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
        + `WHERE ct.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + 'ORDER BY ci.relname',
      // in the index's OWN column order: `(a, b)` and `(b, a)` are
      // different indexes, and only one of them serves an `a` prefix
      indexColumns: (index) =>
        'SELECT a.attname AS name FROM pg_index i '
        + 'JOIN pg_class ci ON ci.oid = i.indexrelid '
        + 'JOIN pg_namespace n ON n.oid = ci.relnamespace '
        + 'CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) '
        + 'JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum '
        + `WHERE ci.relname = ${stringLiteral(index)} AND ${inNamespace} ORDER BY k.ord`,
      // every table this store might own; a view is reported rather
      // than derived, and the engine's own schemas are never in scope
      tables: () =>
        "SELECT c.relname AS name, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' "
        + "ELSE 'table' END AS type FROM pg_class c "
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relkind IN ('r', 'p', 'v', 'm') AND ${inNamespace} `
        + 'ORDER BY type, c.relname',
      generated: (table) =>
        'SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expression '
        + 'FROM pg_attrdef d '
        + 'JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum '
        + 'JOIN pg_class c ON c.oid = d.adrelid '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + "AND a.attgenerated <> '' ORDER BY a.attnum",
      foreignKeyList: (table) => {
        const action = (column) => `CASE ${column} `
          + "WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' "
          + "WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END";
        return 'SELECT tt.relname AS target, sa.attname AS source_column, '
          + `ta.attname AS target_column, ${action('c.confdeltype')} AS on_delete, `
          + `${action('c.confupdtype')} AS on_update, k.ord - 1 AS seq `
          + 'FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid '
          + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
          + 'JOIN pg_class tt ON tt.oid = c.confrelid '
          + 'CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(src, tgt, ord) '
          + 'JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.src '
          + 'JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt '
          + `WHERE c.contype = 'f' AND ct.relname = ${stringLiteral(table)} AND ${inNamespace} `
          + 'ORDER BY c.conname, k.ord';
      },
    },
  });
}
