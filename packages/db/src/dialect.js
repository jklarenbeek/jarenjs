//@ts-check
/**
 * @file The dialect seam: the ONLY place SQL text is produced. A
 * dialect is data plus a small emitter — a spelling spec (how to quote
 * an identifier, reference a parameter, extract a JSON member, open a
 * savepoint) composed by {@link createDialect} into the DDL and DML
 * statement builders the store consumes. Nothing outside a dialect
 * concatenates SQL; that costs one indirection now, and without it a
 * second backend is a rewrite.
 *
 * Deliberately NOT in the dialect, because they are behavioural rather
 * than syntactic: whether functions can be registered per connection,
 * whether change capture exists and in what form, and whether tables
 * can be restructured in place. Those are capabilities on the
 * connection.
 */

/**
 * A typed member path into the JSON document column: name segments for
 * object members, index segments for array positions. Produced by the
 * DDL planner (from analyzed index paths) and the patch translator
 * (from pointers discriminated against the live document).
 * @typedef {{ name: string } | { index: number }} JsonPathSegment
 */

/**
 * Compose a dialect from its spelling spec. Every statement the store
 * ever runs is built here from the spec's primitives, so a spec with
 * different quoting or parameter style produces correspondingly
 * different SQL from the same model — the property the test-double
 * dialect pins.
 * @param {{
 *   name: string,
 *   capabilities: Record<string, any>,
 *   tableSuffix: string,
 *   docColumnType: string,
 *   quoteIdentifier: (s: string) => string,
 *   parameterRef: (i: number, name: string) => string,
 *   stringLiteral: (s: string) => string,
 *   booleanLiteral: (b: boolean) => string,
 *   typeFor: (schemaType: string | undefined, hint: string) => string,
 *   limitClause: (limit: number, offset?: number) => string,
 *   jsonPathText: (segments: JsonPathSegment[]) => string | null,
 *   jsonExtract: (columnSql: string, pathText: string) => string,
 *   jsonSet: (exprSql: string, pathText: string, valueSql: string) => string,
 *   jsonRemove: (exprSql: string, pathText: string) => string,
 *   jsonAppend: (exprSql: string, arrayPathText: string, valueSql: string) => string,
 *   jsonEncode: (paramSql: string) => string,
 *   jsonText: (columnSql: string) => string,
 *   jsonAgg: (exprSql: string) => string,
 *   jsonTypeOf: (columnSql: string, pathText: string) => string,
 *   valueTypeOf: (paramSql: string) => string,
 *   strStartsWith: (valueSql: string, patternA: string, patternB: string) => string,
 *   strEndsWith: (valueSql: string, patternA: string, patternB: string, patternC: string) => string,
 *   strContains: (valueSql: string, patternSql: string) => string,
 *   orderNulls: (nullsFirst: boolean) => string,
 *   rowIdentity: () => string,
 *   explainQuery: (sql: string) => string,
 *   excludedRef: (columnSql: string) => string,
 *   tx: { begin: string, beginImmediate: string, commit: string,
 *     rollback: string,
 *     savepoint: (n: string) => string, release: (n: string) => string,
 *     rollbackTo: (n: string) => string },
 *   pragma: { busyTimeout: (ms: number) => string,
 *     journalMode: (mode: string) => string },
 *   introspect: { version: () => string, compileOptions: () => string,
 *     tableExists: () => string, columns: (table: string) => string,
 *     indexes: (table: string) => string,
 *     indexColumns: (index: string) => string },
 * }} spec
 * @returns {any} the frozen dialect
 */
export function createDialect(spec) {
  const q = spec.quoteIdentifier;
  const p = spec.parameterRef;

  const ddl = Object.freeze({
    /**
     * One collection's physical table: a key column, the JSON document
     * column, and a virtual generated column per indexed path.
     * @param {{ table: string, keyColumn: string, keyType: string,
     *   docColumn: string, generated: { name: string, type: string,
     *   pathText: string }[] }} shape
     * @returns {string}
     */
    createTable({ table, keyColumn, keyType, docColumn, generated }) {
      const columns = [
        `${q(keyColumn)} ${keyType} PRIMARY KEY`,
        `${q(docColumn)} ${spec.docColumnType} NOT NULL`,
        ...generated.map((g) =>
          `${q(g.name)} ${g.type} GENERATED ALWAYS AS `
          + `(${spec.jsonExtract(q(docColumn), g.pathText)}) VIRTUAL`),
      ];
      return `CREATE TABLE ${q(table)} (${columns.join(', ')})${spec.tableSuffix}`;
    },
    /**
     * @param {{ name: string, table: string, columns: string[],
     *   unique: boolean }} shape
     * @returns {string}
     */
    createIndex({ name, table, columns, unique }) {
      return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} `
        + `ON ${q(table)} (${columns.map(q).join(', ')})`;
    },
    /**
     * Add one virtual generated column to an existing table (a new
     * indexed path arriving through a migration).
     * @param {{ table: string, docColumn: string,
     *   column: { name: string, type: string, pathText: string } }} shape
     * @returns {string}
     */
    addGeneratedColumn({ table, docColumn, column }) {
      return `ALTER TABLE ${q(table)} ADD COLUMN ${q(column.name)} ${column.type} `
        + `GENERATED ALWAYS AS (${spec.jsonExtract(q(docColumn), column.pathText)}) VIRTUAL`;
    },
    /**
     * @param {string} table
     * @param {string} column
     * @returns {string}
     */
    dropColumn(table, column) {
      return `ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`;
    },
    /**
     * @param {string} name
     * @returns {string}
     */
    dropIndex(name) {
      return `DROP INDEX ${q(name)}`;
    },
    /**
     * @param {string} table
     * @returns {string}
     */
    dropTable(table) {
      return `DROP TABLE ${q(table)}`;
    },
    /**
     * @param {string} from
     * @param {string} to
     * @returns {string}
     */
    renameTable(from, to) {
      return `ALTER TABLE ${q(from)} RENAME TO ${q(to)}`;
    },
    /**
     * A plain (non-collection) table — the migration history table.
     * @param {{ table: string, columns: { name: string, type: string,
     *   primaryKey?: boolean }[] }} shape
     * @returns {string}
     */
    createPlainTable({ table, columns }) {
      const rendered = columns.map((column) =>
        `${q(column.name)} ${column.type}${column.primaryKey === true ? ' PRIMARY KEY' : ''}`);
      return `CREATE TABLE IF NOT EXISTS ${q(table)} (${rendered.join(', ')})${spec.tableSuffix}`;
    },
  });

  const dml = Object.freeze({
    /** @param {{ table: string, keyColumn: string, docColumn: string }} s */
    insert({ table, keyColumn, docColumn }) {
      return `INSERT INTO ${q(table)} (${q(keyColumn)}, ${q(docColumn)}) `
        + `VALUES (${p(1, 'key')}, ${spec.jsonEncode(p(2, 'doc'))})`;
    },
    /**
     * Insert with a database-allocated key, read back in the same
     * statement.
     * @param {{ table: string, keyColumn: string, docColumn: string }} s
     */
    insertAllocated({ table, keyColumn, docColumn }) {
      return `INSERT INTO ${q(table)} (${q(docColumn)}) `
        + `VALUES (${spec.jsonEncode(p(1, 'doc'))}) RETURNING ${q(keyColumn)} AS ${q('key')}`;
    },
    /** @param {{ table: string, keyColumn: string, docColumn: string }} s */
    upsert({ table, keyColumn, docColumn }) {
      return `INSERT INTO ${q(table)} (${q(keyColumn)}, ${q(docColumn)}) `
        + `VALUES (${p(1, 'key')}, ${spec.jsonEncode(p(2, 'doc'))}) `
        + `ON CONFLICT (${q(keyColumn)}) DO UPDATE SET `
        + `${q(docColumn)} = ${spec.excludedRef(q(docColumn))}`;
    },
    /** @param {{ table: string, keyColumn: string, docColumn: string }} s */
    get({ table, keyColumn, docColumn }) {
      return `SELECT ${spec.jsonText(q(docColumn))} AS ${q('doc')} `
        + `FROM ${q(table)} WHERE ${q(keyColumn)} = ${p(1, 'key')}`;
    },
    /** @param {{ table: string, keyColumn: string }} s */
    del({ table, keyColumn }) {
      return `DELETE FROM ${q(table)} WHERE ${q(keyColumn)} = ${p(1, 'key')}`;
    },
    /**
     * Rewrite the document column through a JSON-set expression chain
     * (the translated-patch path) or a bound parameter (the fallback).
     * @param {{ table: string, keyColumn: string, docColumn: string }} s
     * @param {string} expression - SQL over the document column
     * @param {number} keyIndex - 1-based position of the key parameter
     */
    updateDoc({ table, keyColumn, docColumn }, expression, keyIndex) {
      return `UPDATE ${q(table)} SET ${q(docColumn)} = ${expression} `
        + `WHERE ${q(keyColumn)} = ${p(keyIndex, 'key')}`;
    },
  });

  return Object.freeze({
    name: spec.name,
    capabilities: Object.freeze({ ...spec.capabilities }),
    docColumnType: spec.docColumnType,
    quoteIdentifier: q,
    parameterRef: p,
    stringLiteral: spec.stringLiteral,
    booleanLiteral: spec.booleanLiteral,
    typeFor: spec.typeFor,
    limitClause: spec.limitClause,
    jsonPathText: spec.jsonPathText,
    jsonExtract: spec.jsonExtract,
    jsonSet: spec.jsonSet,
    jsonRemove: spec.jsonRemove,
    jsonAppend: spec.jsonAppend,
    jsonEncode: spec.jsonEncode,
    jsonText: spec.jsonText,
    jsonAgg: spec.jsonAgg,
    jsonTypeOf: spec.jsonTypeOf,
    valueTypeOf: spec.valueTypeOf,
    strStartsWith: spec.strStartsWith,
    strEndsWith: spec.strEndsWith,
    strContains: spec.strContains,
    orderNulls: spec.orderNulls,
    rowIdentity: spec.rowIdentity,
    explainQuery: spec.explainQuery,
    excludedRef: spec.excludedRef,
    tx: Object.freeze({ ...spec.tx }),
    pragma: Object.freeze({ ...spec.pragma }),
    introspect: Object.freeze({ ...spec.introspect }),
    ddl,
    dml,
  });
}
