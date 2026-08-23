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
 *   derivedExpression?: (memberSql: string, column: { derive: string,
 *     precision?: number, component?: string }) => string,
 *   jsonSet: (exprSql: string, pathText: string, valueSql: string) => string,
 *   jsonRemove: (exprSql: string, pathText: string) => string,
 *   jsonAppend: (exprSql: string, arrayPathText: string, valueSql: string) => string,
 *   jsonEncode: (paramSql: string) => string,
 *   jsonText: (columnSql: string) => string,
 *   jsonAgg: (exprSql: string) => string,
 *   jsonTypeOf: (columnSql: string, pathText: string) => string,
 *   valueTypeOf: (paramSql: string) => string,
 *   strStartsWith: (valueSql: string, lowerParamSql: string, upperParamSql: string) => string,
 *   strStartsWithExact: (valueSql: string, patternA: string, patternB: string) => string,
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
 *     journalMode: (mode: string) => string,
 *     foreignKeys: (on: boolean) => string },
 *   introspect: { version: () => string, compileOptions: () => string,
 *     tableExists: () => string, columns: (table: string) => string,
 *     indexes: (table: string) => string,
 *     indexColumns: (index: string) => string,
 *     foreignKeysOn: () => string,
 *     foreignKeyList: (table: string) => string },
 * }} spec
 * @returns {any} the frozen dialect
 */
export function createDialect(spec) {
  const q = spec.quoteIdentifier;
  const p = spec.parameterRef;

  /**
   * One planned column's definition. A path column is a VIRTUAL
   * generated column over the document; a DERIVED column is the same
   * shape over a registered deterministic function, except where the
   * driver cannot index one — there the store writes the value and the
   * column is an ordinary one.
   * @param {string} docColumn
   * @param {{ name: string, type: string, pathText: string,
   *   expression?: string | null, stored?: boolean }} column
   * @returns {string}
   */
  const generatedColumnSql = (docColumn, column) => {
    if (column.stored === true) return `${q(column.name)} ${column.type}`;
    const expression = column.expression
      ?? spec.jsonExtract(q(docColumn), column.pathText);
    return `${q(column.name)} ${column.type} GENERATED ALWAYS AS (${expression}) VIRTUAL`;
  };

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
        ...generated.map((g) => generatedColumnSql(docColumn, g)),
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
      return `ALTER TABLE ${q(table)} ADD COLUMN ${generatedColumnSql(docColumn, column)}`;
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
     * Add one plain (non-generated) column — the additive migration
     * strategy. The column shape matches `createRelationalTable`'s.
     * @param {{ table: string, column: { name: string, type: string,
     *   check?: string, references?: { table: string, column: string,
     *   onDelete: 'cascade' | 'restrict' | 'setNull' } } }} shape
     * @returns {string}
     */
    addColumn({ table, column }) {
      const onDeleteSql = { cascade: 'CASCADE', restrict: 'RESTRICT', setNull: 'SET NULL' };
      let sql = `ALTER TABLE ${q(table)} ADD COLUMN ${q(column.name)} ${column.type}`;
      if (column.check !== undefined) sql += ` CHECK (${column.check})`;
      if (column.references !== undefined) {
        sql += ` REFERENCES ${q(column.references.table)} (${q(column.references.column)})`
          + ` ON DELETE ${onDeleteSql[column.references.onDelete]}`;
      }
      return sql;
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
     * @param {string} table
     * @param {string} from
     * @param {string} to
     * @returns {string}
     */
    renameColumn(table, from, to) {
      return `ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`;
    },
    /**
     * A relational entity table: typed columns (keys, mapped scalars,
     * foreign keys), per-column CHECKs, real REFERENCES clauses with
     * declared on-delete behaviour, and the JSONB document column for
     * everything unmapped. One generator, both document kinds.
     * @param {{ table: string, columns: {
     *   name: string, type: string, notNull?: boolean,
     *   primaryKey?: boolean, check?: string,
     *   references?: { table: string, column: string,
     *     onDelete: 'cascade' | 'restrict' | 'setNull' } }[],
     *   compositeKey?: string[] }} shape
     * @returns {string}
     */
    createRelationalTable({ table, columns, compositeKey }) {
      const onDeleteSql = { cascade: 'CASCADE', restrict: 'RESTRICT', setNull: 'SET NULL' };
      const rendered = columns.map((column) => {
        let sql = `${q(column.name)} ${column.type}`;
        if (column.primaryKey === true) sql += ' PRIMARY KEY';
        if (column.notNull === true) sql += ' NOT NULL';
        if (column.check !== undefined) sql += ` CHECK (${column.check})`;
        if (column.references !== undefined) {
          sql += ` REFERENCES ${q(column.references.table)} (${q(column.references.column)})`
            + ` ON DELETE ${onDeleteSql[column.references.onDelete]}`;
        }
        return sql;
      });
      if (compositeKey !== undefined && compositeKey.length > 0)
        rendered.push(`PRIMARY KEY (${compositeKey.map(q).join(', ')})`);
      return `CREATE TABLE ${q(table)} (${rendered.join(', ')})${spec.tableSuffix}`;
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
    /**
     * A collection insert. `stored` names the derived columns the
     * store computes itself — empty on every driver that can index a
     * registered function, because there the column generates itself.
     * @param {{ table: string, keyColumn: string, docColumn: string,
     *   stored?: string[] }} s
     */
    insert({ table, keyColumn, docColumn, stored }) {
      const extra = stored ?? [];
      const names = [q(keyColumn), q(docColumn), ...extra.map(q)];
      const values = [p(1, 'key'), spec.jsonEncode(p(2, 'doc')),
        ...extra.map((name, i) => p(i + 3, name))];
      return `INSERT INTO ${q(table)} (${names.join(', ')}) VALUES (${values.join(', ')})`;
    },
    /**
     * Insert with a database-allocated key, read back in the same
     * statement.
     * @param {{ table: string, keyColumn: string, docColumn: string,
     *   stored?: string[] }} s
     */
    insertAllocated({ table, keyColumn, docColumn, stored }) {
      const extra = stored ?? [];
      const names = [q(docColumn), ...extra.map(q)];
      const values = [spec.jsonEncode(p(1, 'doc')),
        ...extra.map((name, i) => p(i + 2, name))];
      return `INSERT INTO ${q(table)} (${names.join(', ')}) VALUES (${values.join(', ')}) `
        + `RETURNING ${q(keyColumn)} AS ${q('key')}`;
    },
    /**
     * @param {{ table: string, keyColumn: string, docColumn: string,
     *   stored?: string[] }} s
     */
    upsert({ table, keyColumn, docColumn, stored }) {
      const extra = stored ?? [];
      const names = [q(keyColumn), q(docColumn), ...extra.map(q)];
      const values = [p(1, 'key'), spec.jsonEncode(p(2, 'doc')),
        ...extra.map((name, i) => p(i + 3, name))];
      const assignments = [q(docColumn), ...extra.map(q)]
        .map((column) => `${column} = ${spec.excludedRef(column)}`);
      return `INSERT INTO ${q(table)} (${names.join(', ')}) VALUES (${values.join(', ')}) `
        + `ON CONFLICT (${q(keyColumn)}) DO UPDATE SET ${assignments.join(', ')}`;
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
     * Stored derived columns are rewritten with it — they are computed
     * FROM the document, so leaving them behind would let a query read a
     * value the document no longer carries.
     *
     * `nextParam` is the first FREE parameter slot after the
     * expression's own: the derived values take it and the ones after
     * it, and the key binds LAST. That order is the statement's TEXT
     * order, which is what a positional dialect numbers by — and with
     * no derived columns it degenerates to the key at `nextParam`.
     * @param {{ table: string, keyColumn: string, docColumn: string,
     *   stored?: string[] }} s
     * @param {string} expression - SQL over the document column
     * @param {number} nextParam - 1-based first free parameter slot
     */
    updateDoc({ table, keyColumn, docColumn, stored }, expression, nextParam) {
      const extra = stored ?? [];
      const assignments = [`${q(docColumn)} = ${expression}`,
        ...extra.map((name, i) => `${q(name)} = ${p(nextParam + i, name)}`)];
      return `UPDATE ${q(table)} SET ${assignments.join(', ')} `
        + `WHERE ${q(keyColumn)} = ${p(nextParam + extra.length, 'key')}`;
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
    /**
     * The expression a DERIVED column is generated from: the member at
     * the index path, as JSON text, handed to the deterministic
     * function that computes the cell or the box edge.
     * @param {string} docColumnSql
     * @param {string} pathText
     * @param {{ derive: string, precision?: number, component?: string }} column
     * @returns {string}
     */
    derivedColumn: (docColumnSql, pathText, column) => spec.derivedExpression(
      spec.jsonText(spec.jsonExtract(docColumnSql, pathText)), column),
    jsonSet: spec.jsonSet,
    jsonRemove: spec.jsonRemove,
    jsonAppend: spec.jsonAppend,
    jsonEncode: spec.jsonEncode,
    jsonText: spec.jsonText,
    jsonAgg: spec.jsonAgg,
    jsonTypeOf: spec.jsonTypeOf,
    valueTypeOf: spec.valueTypeOf,
    strStartsWith: spec.strStartsWith,
    strStartsWithExact: spec.strStartsWithExact,
    strEndsWith: spec.strEndsWith,
    strContains: spec.strContains,
    orderNulls: spec.orderNulls,
    rowIdentity: spec.rowIdentity,
    explainQuery: spec.explainQuery,
    excludedRef: spec.excludedRef,
    epochFromRfc3339: spec.epochFromRfc3339,
    tx: Object.freeze({ ...spec.tx }),
    pragma: Object.freeze({ ...spec.pragma }),
    introspect: Object.freeze({ ...spec.introspect }),
    ddl,
    dml,
  });
}
