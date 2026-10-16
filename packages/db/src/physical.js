//@ts-check
/** Explicit column layouts and lossless JSON-facing column codecs. */
import { getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339 } from '@jarenjs/core/dates/rfc3339';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain, useStatementOnce } from './driver.js';
import { isJsonObject } from '@jarenjs/core/object';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { refuseUnknownModelMembers } from './options.js';
import { planTable } from './dialects/sqlite-schema.js';
import { sqlitePhysicalColumnType, sqliteTableMigration } from './dialects/sqlite.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { foldIdentifier } from './invariants.js';
import { sqlTokens } from './dialects/check-read.js';
import { isKeyword } from './sql.js';
import { relationalEmitter } from './relational.js';

const compiledCodecs = new WeakMap();
const STORAGE = { text: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
  json: 'string', date: 'string', datetime: 'string', 'epoch-ms': 'integer', bigint: 'integer', decimal: 'string', 'blob-hex': 'string',
  uuid: 'string', 'local-timestamp': 'string', instant: 'string' };
/** The JSON kind each codec decodes to — what a property typed over its column must admit; `json` decodes any value. */
const DECODED = { text: 'string', integer: 'number', number: 'number', boolean: 'boolean', json: null, date: 'string', datetime: 'string',
  'epoch-ms': 'string', bigint: 'string', decimal: 'string', 'blob-hex': 'string', uuid: 'string', 'local-timestamp': 'string', instant: 'string' };
/** The kind a declared schema type compares as: integers and numbers are one numeric kind.
 * @param {string} type */
const kindOf = (type) => (type === 'integer' ? 'number' : type);
const identifier = (v) => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const PROGRAMS = ['constraints', 'indexes', 'triggers', 'strict', 'withoutRowid'];
/** The closed members of a layout and of one of its columns. */
const LAYOUT_MEMBERS = ['table', 'schema', 'kind', 'keys', 'columns', ...PROGRAMS];
const COLUMN_MEMBERS = ['name', 'codec', 'null', 'default', 'generated', 'type', 'defaultValue', 'collation', 'identity', 'check',
  'generatedExpression', 'stored'];

/** Normalize a declared layout; implicit conversions are never adoption policy.
 * @param {any} physical @param {Map<string, any>} properties @param {string[]} keys
 * @param {string} path
 * @param {Map<string, string[] | undefined>} [types] - each property's declared schema `type`;
 *   a property whose type admits no kind its codec decodes to is refused
 * @returns {any} */
export function normalizePhysical(physical, properties, keys, path, types = new Map()) {
  if (physical === undefined) return null;
  const fail = (reason) => { throw new DbCompileError('JD0005', reason, `${path}/physical`); };
  if (!isJsonObject(physical)) fail('physical must be an object');
  refuseUnknownModelMembers(physical, LAYOUT_MEMBERS, `${path}/physical`, 'physical layout');
  if (!identifier(physical.table)) fail('physical.table must be a nonempty SQL identifier');
  if (physical.schema !== undefined && !identifier(physical.schema)) fail('physical.schema must be a nonempty SQL identifier');
  if (physical.kind !== undefined && !['table', 'view'].includes(physical.kind)) fail('physical.kind is table or view');
  if (physical.kind === 'view' && physical.indexes !== undefined) fail('a view has no indexes to verify: declare them on the table they index');
  if (!isJsonObject(physical.columns)) fail('physical.columns is required');
  const ordered = physical.keys ?? keys;
  if (!Array.isArray(ordered) || ordered.length !== keys.length || new Set(ordered).size !== keys.length
    || ordered.some((key) => !keys.includes(key))) fail('physical.keys must order every declared key exactly once');
  const used = new Set();
  const columns = [];
  const names = Object.keys(physical.columns);
  for (const name of names)
    if (!properties.has(name) || properties.get(name).relation) fail(`column '${name}' is not a stored property`);
  for (const [name, property] of properties)
    if (!property.relation && !Object.hasOwn(physical.columns, name)) fail(`'${name}' needs an explicit supported column codec`);
  const definitions = [];
  for (const name of names) {
    const property = properties.get(name);
    const c = physical.columns[name];
    if (!isJsonObject(c)) fail(`'${name}' needs an explicit supported column codec`);
    refuseUnknownModelMembers(c, COLUMN_MEMBERS, `${path}/physical/columns/${encodeJSONPointerSegment(name)}`, 'physical column');
    if (!Object.hasOwn(STORAGE, c.codec)) fail(`'${name}' needs an explicit supported column codec`);
    // the planner reads the property's type and the gates read what the column stores: a property
    // that disagrees with its codec is answered by the native path where the engine raises
    const declared = types.get(name)?.filter((type) => type !== 'null');
    const decoded = DECODED[c.codec];
    if (declared !== undefined && declared.length > 0 && decoded !== null && !declared.some((type) => kindOf(type) === decoded)) {
      throw new DbCompileError('JD0005',
        `'${name}' is typed ${declared.join(' or ')} but its '${c.codec}' codec decodes a ${decoded}; `
        + 'type the property as what the column holds, or choose the codec that decodes what it declares',
        `${path}/physical/columns/${encodeJSONPointerSegment(name)}/codec`);
    }
    if (!identifier(c.name) || used.has(c.name.toLowerCase())) fail(`'${name}' needs a distinct physical column name`);
    if (!['null', 'absent', 'reject'].includes(c.null)) fail(`'${name}' must declare SQL NULL as null, absent or reject`);
    if (c.type !== undefined && (physical.schema === undefined
      ? c.type !== sqlitePhysicalColumnType(c.codec) : typeof c.type !== 'string' || !c.type || c.type.includes('\0')))
      fail(`'${name}' declares an affinity incompatible with its codec`);
    if (c.stored !== undefined && (typeof c.stored !== 'boolean' || c.generatedExpression === undefined))
      fail(`'${name}' needs an explicit generated expression for stored ownership`);
    if (c.default !== undefined && c.default !== 'database') fail('column default ownership is database');
    if (c.generated !== undefined && typeof c.generated !== 'boolean') fail('generated must be boolean');
    if (property.key && (!['text', 'integer', 'bigint', 'uuid'].includes(c.codec) || c.null !== 'reject')) fail('keys require non-null text, integer, bigint or uuid codecs');
    if (property.column !== undefined) fail('physical codecs replace hybrid column overrides');
    if ((c.default === 'database' || Object.hasOwn(c, 'defaultValue')) && property.default !== undefined && property.default !== 'auto') fail('a default has exactly one owner');
    if (c.generatedExpression !== undefined && c.generated === false) fail('a generated expression requires generated ownership');
    if (physical.schema !== undefined && ['defaultValue', 'collation', 'check', 'generatedExpression', 'stored'].some((key) => c[key] !== undefined))
      fail('native expressions require a reviewed migration');
    used.add(c.name.toLowerCase());
    columns.push({ name, physical: c.name, codec: c.codec, null: c.null, databaseDefault: c.default === 'database' || Object.hasOwn(c, 'defaultValue'),
      generated: c.generated === true || c.generatedExpression !== undefined, storage: STORAGE[c.codec], source: 'column', key: property.key,
      ...(c.type === undefined ? {} : { declaredType: c.type }),
      ...(c.identity === undefined ? {} : { identity: c.identity }) });
    definitions.push({ name: c.name,
      type: c.type ?? sqlitePhysicalColumnType(c.codec),
      nullable: c.null !== 'reject',
      ...(Object.hasOwn(c, 'defaultValue') ? { default: c.defaultValue } : {}),
      ...(c.identity !== undefined || property.default === 'auto' ? { identity: c.identity ?? 'rowid' } : {}),
      ...(c.collation === undefined ? {} : { collation: c.collation }),
      ...(c.check === undefined ? {} : { check: c.check }),
      ...(c.generatedExpression === undefined ? {} : { generated: c.generatedExpression, stored: c.stored === true }),
    });
  }
  const definition = { name: physical.table, columns: definitions,
    primaryKey: ordered.map((key) => physical.columns[key].name),
    ...Object.fromEntries(PROGRAMS
      .filter((key) => physical[key] !== undefined).map((key) => [key, physical[key]])) };
  const planned = physical.schema === undefined && physical.kind !== 'view' ? planTable(definition) : null;
  if (physical.schema !== undefined && PROGRAMS.some((key) => physical[key] !== undefined))
    fail('native programs require a reviewed migration');
  // Database-owned expressions must be explicit before DDL can own them.
  const ddl = physical.schema !== undefined || physical.kind === 'view' || columns.some((c, i) => (c.generated && definitions[i].generated === undefined)
    || (c.databaseDefault && !Object.hasOwn(definitions[i], 'default')))
    ? null : definition;
  // the planned statements: the table, then each index in order, then each trigger
  const declaredIndexes = planned === null ? []
    : (definition.indexes ?? []).map((index, i) => declaredIndex(index, columns, planned.createSql[1 + i]));
  return { table: physical.table, ...(physical.schema === undefined ? {} : { schema: physical.schema }),
    kind: physical.kind ?? 'table', keys: [...ordered], columns, ddl, declaredIndexes };
}

/**
 * A declared index as the open verifies it and a probe reads it: each term's
 * column by physical name and by the member it maps — an expression term, or
 * a column the layout does not map, `null` in both — whether the index is
 * unique and whether it declares a condition, the statement that creates it,
 * whose text SQLite keeps, the condition itself (`where`, the declared `$sql`
 * term) and, where a term is an expression, each term's `$sql` expression
 * (`expressions`, `null` beside a column term), which an engine that deparses
 * renders to compare.
 * @param {any} index @param {any[]} columns - the layout's columns @param {string} sql
 */
function declaredIndex(index, columns, sql) {
  const names = index.terms.map((term) => (term?.by?.$sql === 'column' && typeof term.by.name === 'string' ? term.by.name : null));
  return { name: index.name, unique: index.unique === true, partial: index.where !== undefined, columns: names,
    members: names.map((name) => (name === null ? null : columns.find((column) => column.physical === name)?.name ?? null)), sql,
    ...(index.where === undefined ? {} : { where: index.where }),
    ...(names.includes(null) ? { expressions: index.terms.map((term, i) => (names[i] === null ? term.by : null)) } : {}) };
}

/**
 * A declared condition or expression term as the dialect's relational
 * rendering writes it, or `undefined` where the dialect cannot render it (a
 * function or a literal its vocabulary does not have): what a deparsing
 * engine's stored condition or index key is compared with.
 * @param {any} dialect @param {any} where - the declared `$sql` term @returns {string | undefined}
 */
function renderedCondition(dialect, where) {
  try { return relationalEmitter({ inline: true, dialect }).expr(where); }
  catch (error) {
    if (error instanceof DbCompileError) return undefined;
    throw error;
  }
}

/**
 * The one check of a layout's declared indexes against what the database
 * holds, on every engine: each is present — by name as the engine compares
 * names, ASCII case folded on SQLite, exact on PostgreSQL — as unique and as
 * conditional as declared, keying its column under each plain column term in
 * the declared order (a column an engine carries beside the keys, `INCLUDE`,
 * is a fact, as an undeclared index is). What that shape cannot see — a
 * condition's text, an expression term — is compared as SQLite keeps it, the
 * CREATE text, token by token (`sameIndexText`), so an index the application
 * created in its own spelling verifies and another condition is drift. An
 * engine that deparses keeps no text: its stored condition, and the key it
 * holds under each expression term, are read back
 * (`readBack.layoutConditionDiffers`) and compared with the declared ones as
 * its relational rendering writes them, so a spelling the server reads as the
 * same condition or expression verifies and another is drift; one either
 * side does not read is not compared.
 * @param {any} connection
 * @param {any[]} declared - the layout's `declaredIndexes`
 * @param {any[]} existing - the table's indexes as `readSchema` reports them
 * @param {any[]} columns - the table's columns as `readSchema` reports them, each with its catalog `type`
 * @param {(why: string) => never} fail
 * @returns {any} value-or-promise
 */
function verifyDeclaredIndexes(connection, declared, existing, columns, fail) {
  const dialect = connection.dialect;
  const text = dialect.capabilities.declaredSqlText === true;
  const readBack = text ? undefined : dialect.readBack;
  const typeOf = (/** @type {string} */ name) => columns.find((column) => column.name === name)?.type;
  const fold = dialect.name === 'sqlite' ? foldIdentifier : (/** @type {string} */ name) => name;
  const list = (/** @type {(string | null)[]} */ columns) => columns.map((column) => column ?? '<expression>').join(', ');
  const step = (/** @type {number} */ i) => {
    if (i >= declared.length) return null;
    const index = declared[i];
    const have = existing.find((candidate) => fold(candidate.name) === fold(index.name));
    if (have === undefined) fail(`index '${index.name}' is missing; apply an explicit migration`);
    if (have.unique !== index.unique) fail(`index '${index.name}' is ${have.unique ? '' : 'not '}unique, the model declares it ${index.unique ? '' : 'not '}unique`);
    if (have.partial !== index.partial) fail(`index '${index.name}' ${have.partial ? 'has a condition the model does not declare' : 'has no condition, the model declares one'}`);
    // the columns the index keys: an engine that carries other columns beside them reports the keys apart,
    // each with its key as the server deparses it
    const keyed = dialect.introspect.indexKeyColumns === undefined ? { columns: have.columns, terms: undefined }
      : useStatementOnce(connection, dialect.introspect.indexKeyColumns(have.name), (statement) =>
        chain(statement.all([]), (rows) => ({
          columns: rows.map((row) => (row.name === null || row.name === undefined ? null : String(row.name))),
          terms: rows.map((row) => (typeof row.term === 'string' ? row.term : null)),
        })));
    return chain(keyed, (/** @type {{ columns: (string | null)[], terms: (string | null)[] | undefined }} */ { columns, terms }) => {
      if (columns.length !== index.columns.length || index.columns.some((column, j) => column !== null && column !== columns[j]))
        fail(`index '${index.name}' covers (${list(columns)}) in that order, the model declares (${list(index.columns)})`);
      for (const [j, by] of (readBack === undefined || terms === undefined ? [] : index.expressions ?? []).entries()) {
        const stored = /** @type {(string | null)[]} */ (terms)[j];
        // the server deparses a key without its collation, which is not compared, as a plain term's is not
        const key = by?.$sql === 'collate' ? by.value : by;
        const planned = key === null || stored === null ? undefined : renderedCondition(dialect, key);
        if (planned !== undefined && readBack.layoutConditionDiffers(stored, planned, typeOf, have.conforming !== false))
          fail(`index '${index.name}' keys its term ${j + 1} as\n  ${stored}\nand the model declares\n  ${planned}`);
      }
      if (text && (index.partial || index.columns.includes(null)) && have.sql !== null && have.sql !== undefined) {
        const wanted = comparableDeclaredSql(index.sql), actual = comparableDeclaredSql(String(have.sql));
        if (!sameIndexText(wanted, actual)) fail(`index '${index.name}' is declared as\n  ${actual}\nand the model declares\n  ${wanted}`);
      }
      const planned = readBack !== undefined && index.where !== undefined && typeof have.predicate === 'string'
        ? renderedCondition(dialect, index.where) : undefined;
      if (planned !== undefined && readBack.layoutConditionDiffers(have.predicate, planned, typeOf, have.conforming !== false))
        fail(`index '${index.name}' is declared as\n  WHERE ${have.predicate}\nand the model declares\n  WHERE ${planned}`);
      return step(i + 1);
    });
  };
  return step(0);
}

/**
 * Whether two CREATE INDEX texts spell one index: the same tokens, with
 * identifiers unquoted and ASCII case folded (as SQLite compares them),
 * keywords case folded, and whitespace, comments, an `IF NOT EXISTS` clause
 * and the parentheses around the whole condition set aside — so an index
 * the application created in its own spelling verifies, while another
 * operator, literal, column or list is drift.
 * @param {string} wanted @param {string} actual @returns {boolean}
 */
function sameIndexText(wanted, actual) {
  if (wanted === actual) return true;
  const a = indexTokens(wanted), b = indexTokens(actual);
  return a !== null && b !== null && a.length === b.length && a.every((token, i) => token === b[i]);
}

/** @param {string} sql @returns {string[] | null} the comparable tokens; null where the text does not tokenize */
function indexTokens(sql) {
  const tokens = sqlTokens(sql);
  if (tokens.length === 0) return null;
  const word = (/** @type {number} */ i, /** @type {string} */ value) => isKeyword(tokens[i], value);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (word(i, 'IF') && word(i + 1, 'NOT') && word(i + 2, 'EXISTS')) { i += 2; continue; }
    const { kind, value } = tokens[i];
    // SQLite also quotes an identifier as [name]
    if (kind === 'symbol' && value === '[' && tokens[i + 1]?.kind === 'word' && tokens[i + 2]?.kind === 'symbol' && tokens[i + 2].value === ']') {
      out.push(`i:${foldIdentifier(tokens[i + 1].value)}`); i += 2; continue;
    }
    out.push(kind === 'word' || kind === 'identifier' ? `i:${foldIdentifier(value)}` : kind === 'symbol' ? value : `${kind[0]}:${value}`);
  }
  // the planner parenthesizes the whole condition after the column list; an application need not
  const closing = (/** @type {number} */ open) => {
    for (let i = open, depth = 0; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) return i;
    }
    return -1;
  };
  const columns = out.indexOf('(');
  const where = columns < 0 ? -1 : closing(columns) + 1;
  while (where > 0 && out[where] === 'i:where' && out[where + 1] === '(' && closing(where + 1) === out.length - 1) {
    out.splice(where + 1, 1);
    out.pop();
  }
  return out;
}

/** Compile one codec once, with a JSON-safe public value and a bound SQL value.
 * @param {any} column @returns {{ encode: Function, decode: Function, normalize: Function }} */
export function columnCodec(column) {
  if (compiledCodecs.has(column)) return compiledCodecs.get(column);
  const fail = () => { throw new DbRuntimeError('JD2003', `column '${column.name}' refuses a lossy or invalid ${column.codec} value`); };
  const date = (v, only) => typeof v === 'string' && Number.isFinite(only
    ? getEpochOfDateOnlyRFC3339(v) : getEpochOfDateTimeRFC3339(v));
  const timestamp = (v, instant) => {
    if (typeof v !== 'string') return false;
    const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\.(\d{6})(Z?)$/.exec(v);
    return match !== null && match[1].slice(0, 4) !== '0000' && date(match[1], true)
      && (match[6] === 'Z') === instant
      && (column.fractionDigits === undefined || !/[1-9]/.test(match[5].slice(column.fractionDigits)));
  };
  const convert = (v, reading) => {
    if (v === undefined || v === null) {
      if (!reading && v === null && column.codec === 'json') return 'null';
      if (column.null === 'reject') return fail();
      return reading ? (column.null === 'absent' ? undefined : null) : null;
    }
    switch (column.codec) {
      case 'text': if (typeof v === 'string') return v; break;
      case 'uuid': if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v.toLowerCase(); break;
      case 'integer': if (typeof v === 'number' && Number.isSafeInteger(v)) return v; break;
      case 'number': if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return v; break;
      case 'boolean':
        if (reading && (v === 0 || v === 1 || typeof v === 'boolean')) return v === 1 || v === true;
        if (!reading && typeof v === 'boolean') return v ? 1 : 0;
        break;
      case 'bigint': if (typeof v === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(v)
        && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n) return v; break;
      case 'decimal': if (typeof v === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v)
        && (!column.nativeNumeric || !/^-0(?:\.0+)?$/.test(v))
        && (column.scale === undefined || (v.split('.')[1]?.length ?? 0) === column.scale)) return v; break;
      case 'date': if (date(v, true)) return v; break;
      case 'datetime': if (date(v, false)) return v; break;
      case 'local-timestamp': if (timestamp(v, false)) return v; break;
      case 'instant': if (timestamp(v, true)) return v; break;
      case 'epoch-ms':
        if (reading && typeof v === 'number' && Number.isSafeInteger(v) && Number.isFinite(new Date(v).getTime())) return new Date(v).toISOString();
        if (!reading && date(v, false) && new Date(v).toISOString() === v) return getEpochOfDateTimeRFC3339(v);
        break;
      case 'blob-hex':
        if (typeof v === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(v))
          return reading ? v.toLowerCase() : Uint8Array.from(v.match(/../g) ?? [], (b) => parseInt(b, 16));
        break;
      case 'json':
        try {
          if (reading) return JSON.parse(v);
          canonicalizeJson(v);
          const text = JSON.stringify(v);
          if (text !== undefined && JSON.stringify(JSON.parse(text)) === text) return text;
        }
        catch { return fail(); }
        break;
    }
    return fail();
  };
  const codec = { encode: (v) => convert(v, false), decode: (v) => convert(v, true), normalize: (v) => {
    const encoded = convert(v, false);
    return column.codec === 'blob-hex' && encoded !== null ? v.toLowerCase() : convert(encoded, true);
  } };
  compiledCodecs.set(column, codec);
  return codec;
}

/** SQL selection keeps unsafe integers and byte handles out of application state.
 * @param {any} column @param {any} dialect @param {string} [prefix] @returns {string} */
export function physicalRead(column, dialect, prefix = '') {
  const sql = `${prefix}${dialect.quoteIdentifier(column.physical ?? column.name)}`;
  return dialect.physicalRead(column.codec, sql);
}

/**
 * A parameter compared with an `integer`-codec column, spelled `bigint` on
 * PostgreSQL. The server types an untyped parameter from the column it
 * meets, so an integer past that column's own width (`3000000000` against
 * an `integer`, `40000` against a `smallint`) is refused while the
 * parameter is read, before a row is compared; as a `bigint` it compares
 * through the btree integer family's cross-width operators, so the bare
 * column keeps its index and such a value names no row. Every other column
 * and engine binds the parameter as itself.
 * @param {any} dialect @param {string | undefined} codec @param {string} paramSql
 * @returns {string}
 */
export function integerParameter(dialect, codec, paramSql) {
  return dialect.name === 'postgres' && codec === 'integer' ? `(${paramSql})::bigint` : paramSql;
}

/**
 * Whether a mapped column may carry an order, per codec and engine: the
 * one table an explicit `orderBy` of a load and a keyset term consult.
 * `explicit` — a load may order by the column, because SQL orders it as
 * `execute()` orders the decoded value: text (by code point, whatever
 * collation the column declares), integer, number, boolean, date and
 * datetime where the dialect compares the column natively
 * (`nativeQuery`), and a native uuid column (PostgreSQL), whose order is
 * the code-point order of its lowercase text, under the same nullability
 * rule; bigint, decimal and epoch-ms order by value in SQL and by their
 * decoded string in the engine, and stay refused with every other codec.
 * `keyset` — a continuation resumes exactly: integer, bigint (an exact
 * decimal string), text and uuid. `stored` — the continuation carries the
 * text the table stores, never the decoded value, because the two do not
 * compare alike: SQLite keeps a uuid as text in whatever case the table
 * holds and the entity decodes it to lowercase (a native uuid compares as
 * its decoded lowercase text). Such a term is never `explicit`: `load`
 * and `execute` order the decoded value. The planner's typed-path rule
 * (`entityShape`) admits the same codecs to native predicates and is not
 * widened here: a native uuid compared against a literal of another case
 * would match where the engine does not.
 * @param {any} column - a mapped column, as the open qualified it
 * @param {any} dialect
 * @returns {{ explicit: boolean, keyset: boolean, stored: boolean }}
 */
export function physicalOrderable(column, dialect) {
  const nativeUuid = column.codec === 'uuid' && dialect.name !== 'sqlite';
  const typed = ['text', 'integer', 'number', 'boolean', 'date', 'datetime'].includes(column.codec) && column.nativeQuery !== false;
  return {
    explicit: typed || (nativeUuid && column.null !== 'null'),
    keyset: ['integer', 'bigint', 'text', 'uuid'].includes(column.codec),
    stored: column.codec === 'uuid' && !nativeUuid,
  };
}

/** The fields at which an installed program departs from the planned one.
 * @param {any} want @param {any} have @param {string} [at] @returns {string[]} */
function programDifferences(want, have, at = '') {
  return Object.keys(want).flatMap((key) => {
    const value = want[key];
    if (isJsonObject(value)) return programDifferences(value, have?.[key], `${at}${key}.`);
    return canonicalizeJson(value) === canonicalizeJson(have?.[key] ?? null) ? [] : [`${at}${key}`];
  });
}

/**
 * The one check of a table's rule programs against the plan. Where the server
 * deparses a program (`trigger.program`, PostgreSQL), each planned one is read
 * back field by field from the catalog — a trigger's function is part of its
 * program — and, with `undeclared`, any other trigger on the table is refused,
 * as is a rewrite rule, which changes what a write does as a trigger does;
 * a trigger compared by its text is its caller's to compare. An increment
 * updates its own row from inside its trigger, which runs that trigger again
 * only while recursive triggers are on, and a rule compares text by code
 * point, which SQLite's BINARY collation is only over UTF-8: both are checked
 * wherever a program is planned. `installed: false` checks only those two,
 * for programs about to be created.
 * @param {any} connection
 * @param {string} table
 * @param {any[]} triggers - the planned program items
 * @param {(why: string) => never} fail
 * @param {{ installed?: boolean, undeclared?: boolean }} [options]
 * @returns {any} value-or-promise
 */
export function verifyRulePrograms(connection, table, triggers, fail, { installed = true, undeclared = false } = {}) {
  const dialect = connection.dialect;
  const programs = triggers.filter((trigger) => trigger.type !== 'function' && trigger.program !== undefined);
  const read = !installed || (programs.length === 0 && !undeclared) || dialect.introspect.invariantPrograms === undefined ? null
    : useStatementOnce(connection, dialect.introspect.invariantPrograms(table), (s) => chain(s.all([]), (rows) => {
      const owned = rows.filter((row) => row.owner === table);
      const installed = owned.filter((row) => row.kind !== 'rule');
      for (const trigger of programs) {
        const row = installed.find((r) => r.name === trigger.name);
        const actual = row === undefined ? undefined : typeof row.program === 'string' ? JSON.parse(row.program) : row.program;
        const changed = actual === undefined ? [] : programDifferences(trigger.program, actual);
        if (actual === undefined || changed.length > 0)
          fail(`invariant trigger '${trigger.name}' is missing or changed${changed.length ? ` (${changed.join(', ')})` : ''}; apply an explicit migration`);
      }
      const extra = undeclared ? owned.find((row) => row.kind === 'rule' || !programs.some((trigger) => trigger.name === row.name)) : undefined;
      if (extra !== undefined) {
        const what = extra.kind === 'rule' ? 'rewrite rule' : 'trigger';
        fail(`the database has the ${what} '${extra.name}', which the model does not declare — an undeclared ${what} changes what a write does`);
      }
    }));
  const recursion = !triggers.some((trigger) => trigger.selfUpdate) ? null
    : useStatementOnce(connection, dialect.introspect.pragma('recursive_triggers'), (s) => chain(s.get([]), (row) => {
      if (Number(row?.recursive_triggers) !== 0) fail('an increment rule updates its own row, and recursive_triggers would run its trigger again; switch it off');
    }));
  const encoding = triggers.length === 0 ? null
    : requireCodePointText(connection, 'database rules compare text by code point', fail);
  return chain(recursion, () => chain(encoding, () => read));
}

/** Verify an existing mapped object without executing DDL: its columns, its
 * declared indexes and its rule programs. Unmapped columns and all
 * application-owned programs remain physical facts, never inferred drops.
 * What the catalog declares of a column is recorded on the column itself,
 * which every reader of the mapping shares: whether it can hold NULL
 * (`notNull`), and the database's text encoding (`databaseEncoding`)
 * where the dialect reads the database's own catalog row.
 * @param {any} connection @param {any} mapping @param {any} schema @returns {any} */
export function verifyPhysical(connection, mapping, schema) {
  const fail = (why) => { throw new DbCompileError('JD0002', `physical '${mapping.table}': ${why}`); };
  if (!connection.dialect.physicalTypeMatches) fail('this backend has no qualified physical codecs');
  if (connection.dialect.physicalNamespaceRequired && connection.dialect.schema === undefined)
    fail('physical adoption requires an explicit driver-owned schema');
  if (mapping.schema !== undefined && mapping.schema !== connection.dialect.schema)
    fail('declared schema must equal the driver-owned schema');
  const object = schema.objects.find((o) => o.name === mapping.table && o.type === mapping.kind);
  if (!object) fail(`declared ${mapping.kind} does not exist`);
  for (const trigger of mapping.triggers ?? []) {
    // a deparsing server answers with its own text, read field by field below
    if (trigger.type === 'function' || trigger.program !== undefined) continue;
    const actual = schema.objects.find((o) => o.type === 'trigger' && o.name === trigger.name);
    if (!actual || actual.sql?.trim().replace(/;$/, '') !== trigger.sql.trim().replace(/;$/, '')) fail(`invariant trigger '${trigger.name}' is missing or changed; apply an explicit migration`);
  }
  const programs = verifyRulePrograms(connection, mapping.table, mapping.triggers ?? [], fail);
  const read = mapping.kind === 'view'
    ? useStatementOnce(connection, connection.dialect.introspect.columns(mapping.table), (s) =>
      chain(s.all([]), (columns) => ({ columns: columns.map((c) => ({ ...c, generated: !!c.hidden })), primaryKey: [] })))
    : schema.tables.find((t) => t.name === mapping.table);
  // the database's own row of its catalog, where the dialect reads one
  // (PostgreSQL): its text encoding, default collation and locale provider
  const database = schema.catalog?.find((o) => o.type === 'schema')?.metadata ?? null;
  return chain(programs, () => chain(read, (table) => {
    if (mapping.kind !== 'view' && JSON.stringify(table.primaryKey) !== JSON.stringify(mapping.keys.map((k) => mapping.columns.find((c) => c.name === k).physical))) fail('ordered primary key disagrees');
    for (const column of mapping.columns) {
      const actual = table.columns.find((c) => c.name === column.physical);
      if (!actual) fail(`column '${column.physical}' does not exist`);
      const type = actual.type.toUpperCase();
      if (!connection.dialect.physicalTypeMatches(column.codec, type)) fail(`'${column.physical}' type ${type} cannot guarantee codec ${column.codec}`);
      if (mapping.kind !== 'view' && actual.generated !== column.generated) fail(`'${column.physical}' generated ownership disagrees`);
      // a column the catalog declares NOT NULL compares inside a row value (a
      // keyset seek) whatever null policy the model declares; a text column's
      // stored bytes decode exactly only from a UTF8 database
      column.notNull = actual.nullable === false;
      if (database !== null) column.databaseEncoding = typeof database.encoding === 'string' ? database.encoding : null;
      // the catalog's own row of the column, where the dialect reads one: the
      // schema its collation lives in, which a name alone does not say
      const catalogColumn = schema.catalog?.find((o) => o.type === 'column' && o.owner === mapping.table && o.name === column.physical)?.metadata ?? null;
      connection.dialect.qualifyPhysicalColumn?.(column, actual, mapping.kind, database, catalogColumn);
    }
    return mapping.kind === 'view' ? null : verifyDeclaredIndexes(connection, mapping.declaredIndexes ?? [], table.indexes ?? [], table.columns, fail);
  }));
}

/** Select mapped columns with their physical aliases for the shared row merger.
 * @param {any} mapping @param {any} dialect @param {string} [prefix] @returns {string} */
export function physicalSelection(mapping, dialect, prefix = '') {
  return mapping.columns.map((c) => `${physicalRead(c, dialect, prefix)} AS ${dialect.quoteIdentifier(c.physical ?? c.name)}`).join(', ');
}

/**
 * The text-key read plan — ONE implementation, shared by the physical
 * migration walker and a physical keyset page. A text key is read beside
 * its raw bytes (the dialect's binary cast), and every row proves the key
 * survives the database's text encoding before anything is built on it:
 * both compare and seek by the key, and a key the binding decoded lossily
 * (malformed UTF-8 reads back as U+FFFD) seeks past the wrong rows, or
 * back over the same ones forever.
 *
 * This is the synchronous half: the columns planned, the byte aliases
 * (never a mapped column's name), and the projection that reads them.
 * `null` when no key is text.
 * @param {{ columns: any[] }} mapping
 * @param {any[]} keys - the key columns; the text-codec ones are planned
 * @param {any} dialect
 * @param {string} [prefix] - the table alias the projection qualifies columns with
 * @returns {{ columns: any[], aliases: string[], projection: string } | null}
 */
export function textKeyPlan(mapping, keys, dialect, prefix = '') {
  const columns = keys.filter((column) => column.codec === 'text');
  if (columns.length === 0) return null;
  const names = new Set(mapping.columns.map((column) => String(column.physical ?? column.name).toLowerCase()));
  const aliases = columns.map((_, index) => {
    let name = `__jaren_key_bytes_${index}`;
    while (names.has(name.toLowerCase())) name += '_';
    names.add(name.toLowerCase());
    return name;
  });
  const q = dialect.quoteIdentifier;
  const projection = columns.map((column, index) =>
    `${sqliteTableMigration.binaryCast(`${prefix}${q(column.physical ?? column.name)}`)} AS ${q(aliases[index])}`).join(', ');
  return { columns, aliases, projection };
}

/**
 * The connection's half of the plan: a fatal decoder in the database's own
 * text encoding (UTF-16 files included), and whether the binding keeps a
 * leading BOM when it binds a string back — some native bindings read one
 * correctly and strip it on the way back, and such a key must refuse before
 * it is sought. Two statements, the same answer for the connection's life:
 * a caller memoizes it.
 * @param {any} connection
 * @returns {any} value-or-promise of `{ decoder: TextDecoder, keepsLeadingBom: boolean }`
 */
export function textKeyDecoding(connection) {
  const dialect = connection.dialect;
  return chain(databaseEncoding(connection), (encoding) => {
    const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    const probe = `SELECT ${sqliteTableMigration.binaryCast(dialect.parameterRef(1, 'text'))} AS ${dialect.quoteIdentifier('bytes')}`;
    return useStatementOnce(connection, probe, (bound) => chain(bound.get(['\uFEFFx']), (read) => ({
      decoder, keepsLeadingBom: decoder.decode(read.bytes) === '\uFEFFx',
    })));
  });
}

/**
 * Refuse a SQLite database whose text encoding is not UTF-8, by `fail`: the
 * default BINARY collation compares a text value's stored bytes, which is
 * code point order only over UTF-8 (a UTF-16 file orders by its UTF-16 bytes),
 * and every native text comparison and order assumes it. Nothing for a
 * dialect with no pragma to read (PostgreSQL), whose collation it spells.
 * @param {any} connection
 * @param {string} what - the sentence's subject: what compares text by code point
 * @param {(why: string) => never} fail
 * @returns {any} value-or-promise of nothing
 */
export function requireCodePointText(connection, what, fail) {
  return chain(nonCodePointEncoding(connection), (name) => {
    if (name !== null) fail(`${what}, which a ${name} database does not; use a UTF-8 database`);
  });
}

/**
 * The SQLite database's text encoding when its BINARY order is not code
 * point order (a UTF-16 file), `null` when it is (UTF-8) or the dialect has
 * no pragma to read (PostgreSQL, whose collation it spells): what a native
 * text comparison, order or page must not be trusted over.
 * @param {any} connection
 * @returns {any} value-or-promise of the encoding's name, or `null`
 */
export function nonCodePointEncoding(connection) {
  if (typeof connection.dialect.introspect.pragma !== 'function') return null;
  return chain(databaseEncoding(connection), (name) => (String(name).toUpperCase() === 'UTF-8' ? null : name));
}

/**
 * The SQLite database's text encoding, as `PRAGMA encoding` names it. A
 * build compiled without UTF-16 (`SQLITE_OMIT_UTF16`, as the official
 * wasm build is) answers that pragma with no row at all — and such a
 * build reads only UTF-8 databases, so no row is UTF-8. The one reading
 * of the encoding, for the rule check and the text-key decoder alike.
 * @param {any} connection
 * @returns {any} value-or-promise of the encoding's name
 */
function databaseEncoding(connection) {
  return useStatementOnce(connection, connection.dialect.introspect.pragma('encoding'), (statement) =>
    chain(statement.get([]), (row) => (row === undefined || row === null ? 'UTF-8' : row.encoding)));
}

/**
 * Prove one row's text keys against their bytes and answer the row without
 * the byte columns; a key that cannot round-trip is `refuse(column)`, and a
 * SQL NULL (a nullable order column's) has nothing to prove.
 * @param {any} row
 * @param {{ columns: any[], aliases: string[] }} plan
 * @param {{ decoder: TextDecoder, keepsLeadingBom: boolean }} decoding
 * @param {(column: any) => Error} refuse
 * @returns {any}
 */
export function checkTextKeys(row, plan, decoding, refuse) {
  for (let index = 0; index < plan.columns.length; index++) {
    const column = plan.columns[index];
    // a SQL NULL carries no text to lose: a nullable order column's null
    // orders and seeks by its null branch, never by a decoded value
    if (row[column.physical ?? column.name] === null && row[plan.aliases[index]] === null) continue;
    let decoded;
    try { decoded = decoding.decoder.decode(row[plan.aliases[index]]); }
    catch { /* the refusal below covers a replacement decoding too */ }
    if (decoded === undefined || decoded !== row[column.physical ?? column.name]
      || (!decoding.keepsLeadingBom && decoded.startsWith('\uFEFF'))) throw refuse(column);
  }
  const clean = { ...row };
  for (const alias of plan.aliases) delete clean[alias];
  return clean;
}
