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
 * A dialect answers a CLOSED capability set of its own
 * ({@link DIALECT_CAPABILITIES}), and every one of those answers is
 * SYNTACTIC — what SQL this engine will accept. Deliberately NOT here,
 * because they are behavioural rather than syntactic: whether functions
 * can be registered on THIS connection, whether the library was built
 * with the R\*Tree module, whether change capture exists and in what
 * form. Those are the connection's, probed once at open.
 */

/**
 * A typed member path into the JSON document column: name segments for
 * object members, index segments for array positions. Produced by the
 * DDL planner (from analyzed index paths) and the patch translator
 * (from pointers discriminated against the live document).
 * @typedef {{ name: string } | { index: number }} JsonPathSegment
 */

/**
 * The bound a declared interval keeps each span bound within: the safe
 * integers, which both engines compare exactly and the query engine holds
 * as a number without rounding.
 */
const SAFE_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * The closed set of dialect capabilities, each with the answer a
 * spelling spec that says nothing gets. They are SYNTACTIC — what SQL
 * this engine will accept — as opposed to the connection capabilities
 * {@link module:driver}'s probe reports, which are what a particular
 * library and build can DO.
 *
 * Closed, and defaulted to the conservative answer, for one reason: a
 * misspelled capability must not read as a quiet `false` on the dialect
 * that has the feature, nor as a quiet `true` on the one that does not.
 * {@link createDialect} refuses a name outside this set.
 */
export const DIALECT_CAPABILITIES = Object.freeze({
  /** A binary JSON storage type distinct from text. */
  jsonb: false,
  /** Columns whose value is an expression over another column. */
  generatedColumns: false,
  /** A generated column may be indexed. PostgreSQL 18's VIRTUAL ones
   * may not, which is why storage and indexability are two answers. */
  indexableGeneratedColumns: false,
  /** A column may be declared with no scalar type — SQLite's `ANY`.
   * Where this is false, an indexed path the schema does not type has
   * no honest column type and the planner keeps it in the residual. */
  untypedColumns: false,
  /** `INSERT ... RETURNING`. */
  returning: false,
  /** `INSERT ... ON CONFLICT (key) DO UPDATE`. */
  upsert: false,
  /** `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`. */
  savepoints: false,
  /** A `SAVEPOINT` outside a transaction STARTS one. SQLite's does,
   * which is why a top-level transaction there can be one checkpoint;
   * PostgreSQL refuses a savepoint outside a transaction block, so a
   * top-level transaction has to be `BEGIN` and `COMMIT` there. */
  savepointStartsTransaction: false,
  /** A transaction can take the store's writer lock before its body
   * runs: `tx.beginImmediate` is a distinct statement, or `tx.writerLock`
   * follows `BEGIN`. */
  immediateTransactions: false,
  /** A `GROUP BY` / `ORDER BY` term may name a result alias, so a
   * bucket ladder is written once rather than three times. */
  groupByAlias: false,
  /** `ALTER TABLE` can restructure in place (drop a constraint, retype
   * a column) rather than only add and drop columns. */
  alterTableFull: false,
  /** `CREATE VIRTUAL TABLE` — the second physical realization of a
   * `derive: 'bbox'` column set. */
  virtualTables: false,
  /** Row triggers, which the virtual-table mapping is kept in sync by. */
  triggers: false,
  /** A closed configuration vocabulary applied per connection — the
   * `pragma` group. Where this is false the store applies none and the
   * effective record is empty. */
  pragmas: false,
  /** The engine stores each schema object's CREATE text verbatim, so a
   * declared-text comparison is available to the drift check. Where it
   * is false the drift check is the structural one (columns, indexes,
   * foreign keys) and says so. */
  declaredSqlText: false,
  /** Referential integrity is always enforced, so no per-connection
   * switch is set or verified at open. */
  foreignKeysAlwaysOn: false,
  /** A per-row identity that reproduces INSERTION order — SQLite's
   * `rowid`, or a declared identity column this dialect adds to every
   * table it creates. A collection is a sequence; without one, its
   * order is whatever the engine answers in. */
  rowIdentity: false,
});

/**
 * Merge a spec's declared capabilities onto the closed defaults,
 * refusing a name outside the set.
 * @param {Record<string, any>} declared
 * @returns {Readonly<Record<string, boolean>>}
 */
function normalizeCapabilities(declared) {
  const out = { ...DIALECT_CAPABILITIES };
  for (const [name, value] of Object.entries(declared ?? {})) {
    if (!Object.hasOwn(DIALECT_CAPABILITIES, name)) {
      throw new TypeError(`createDialect: '${name}' is not a dialect capability; the set is `
        + Object.keys(DIALECT_CAPABILITIES).map((n) => `'${n}'`).join(', '));
    }
    out[name] = value === true;
  }
  return Object.freeze(out);
}

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
 *   packedVectorType: string,
 *   quoteIdentifier: (s: string) => string,
 *   parameterRef: (i: number, name: string) => string,
 *   stringLiteral: (s: string) => string,
 *   booleanLiteral: (b: boolean) => string,
 *   typeFor: (schemaType: string | undefined, hint: string) => string,
 *   autoKeyType?: string,
 *   maxIdentifierBytes?: number,
 *   ownRelationNames?: (table: string, columns: { name: string, type: string }[]) => string[],
 *   comparableColumnType?: (declaredType: string) => string,
 *   columnUsableFor?: (declaredType: string | undefined, kind: string) => boolean,
 *   generatedStorage: string,
 *   identityColumn?: { name: string, type: string },
 *   epochFromRfc3339: (valueSql: string) => string,
 *   limitClause: (limit: number, offset?: number) => string,
 *   jsonPathText: (segments: JsonPathSegment[]) => string | null,
 *   jsonExtract: (columnSql: string, pathText: string, kind?: string) => string,
 *   queryGuard?: (documentSql: string, segments: JsonPathSegment[]) => string | null,
 *   rowPredicateFlavor?: any,
 *   readBack?: { conditionReads: (planned: string, columns: any[]) => boolean,
 *     condition: (stored: string | null, planned: string | undefined, columns: any[], conforming: boolean) => string | null,
 *     expressionReads: (planned: string) => boolean,
 *     expression: (stored: string, planned: string, conforming: boolean) => string | null },
 *   isCreateRace?: (error: any) => boolean,
 *   capture?: { check: (options: any) => void, beforeWrite: (connection: any) => any,
 *     afterLog?: (connection: any) => any },
 *   jobs?: any,
 *   replication?: any,
 *   rowLockSuffix?: string,
 *   rowNoKeyLockSuffix?: string,
 *   owner?: { kind: 'lease', table: string, create: string, ensure: string, read: string,
 *     take: string, renew: string, release: string }
 *     | { kind: 'session', acquire: string, release: string },
 *   foreignKeySuffix?: string,
 *   foreignKeyActions?: Record<string, string>,
 *   comparableForeignKeyAction?: (action: string) => string,
 *   derivedExpression?: (memberSql: string, column: { derive: string,
 *     precision?: number, component?: string, dims?: number }) => string,
 *   jsonSet: (exprSql: string, pathText: string, valueSql: string) => string,
 *   jsonRemove: (exprSql: string, pathText: string) => string,
 *   jsonAppend: (exprSql: string, arrayPathText: string, valueSql: string) => string,
 *   jsonEncode: (paramSql: string) => string,
 *   jsonValue?: (columnSql: string) => string,
 *   jsonText: (columnSql: string) => string,
 *   jsonAgg: (exprSql: string) => string,
 *   jsonTypeOf: (columnSql: string, pathText: string) => string,
 *   numericTypeNames: readonly string[],
 *   typedExtract?: boolean,
 *   maxPredicateTerms?: number,
 *   jsonObject: (pairsSql: string) => string,
 *   jsonEmbed: (columnSql: string) => string,
 *   externalEncoding?: 'value' | 'json',
 *   externalCompare?: (valueSql: string, kind: string) => string,
 *   externalRef?: (paramSql: string, kind: string) => string,
 *   valueTypeOf: (paramSql: string) => string,
 *   strStartsWith: (valueSql: string, lowerParamSql: string, upperParamSql: string) => string,
 *   strStartsWithExact: (valueSql: string, patternA: string, patternB: string) => string,
 *   strEndsWith: (valueSql: string, patternA: string, patternB: string, patternC: string) => string,
 *   strContains: (valueSql: string, patternSql: string) => string,
 *   orderNulls: (nullsFirst: boolean) => string,
 *   timeBucket: (instantSql: string, originSql: string, everyA: string,
 *     everyB: string, everyC: string) => string,
 *   groupAggregate: (fn: string, valueSql: string | null) => string,
 *   rowIdentity: () => string,
 *   identityIn: (identitySql: string, paramSqls: string[]) => string,
 *   rtree?: { module: string, columns: readonly string[] },
 *   rtreeDdl?: Record<string, Function>,
 *   explainQuery: (sql: string) => string,
 *   explainLines: (rows: any[]) => string[],
 *   explainEstimate?: (sql: string) => string,
 *   readEstimate?: (rows: any[]) => { rows: number, source: string } | null,
 *   isFullScan: (line: string, tables: readonly string[]) => boolean,
 *   usesIndex: (line: string, index: string) => boolean,
 *   excludedRef: (columnSql: string) => string,
 *   tx: { begin: string, beginImmediate: string, commit: string,
 *     rollback: string, deferForeignKeys?: string,
 *     writerLock?: string, isolationLevels: readonly string[],
 *     beginAt?: (level: string) => string,
 *     savepoint: (n: string) => string, release: (n: string) => string,
 *     rollbackTo: (n: string) => string },
 *   pragma?: { set: (name: string, value: number | string) => string,
 *     foreignKeys: (on: boolean) => string,
 *     foreignKeyCheck: () => string,
 *     walCheckpoint: (mode: string) => string,
 *     integrityCheck: (limit?: number) => string,
 *     optimize: () => string },
 *   schemaTypeOf?: (declaredType: string) => string | undefined,
 *   jsonTypeName: (columnSql: string, pathText: string) => string,
 *   integerBounds: (shape: { docColumnSql: string, start: { sql: string, pathText: string },
 *     end: { sql: string, pathText: string } }) => string,
 *   intervalSpelling: (conforming: boolean) => import('./dialects/check-read.js').IntervalSpelling,
 *   memberPathOf?: (expression: string) => (JsonPathSegment[] | null),
 *   expressionOf?: (expression: string, byName: Record<string, string>) => (any | null),
 *   readGenerated?: (rows: any[]) => { name: string, expression: string }[],
 *   physicalRead?: (codec: string, sql: string) => string,
 *   physicalCompare?: (codec: string, sql: string, column?: any) => string,
 *   physicalValueType?: (codec: string, sql: string) => string,
 *   physicalDifferent?: (codec: string, left: string, right: string) => string,
 *   numberCast?: (sql: string) => string,
 *   distinct?: (left: string, right: string) => string,
 *   mutationRowGuard?: (count: string, limit: number) => string,
 *   boundMutation?: (sql: string, limit: number) => string,
 *   codepoint?: (value: string) => string,
 *   inList?: (valueSql: string, listSql: string, kind: 'text' | 'number') => string,
 *   physicalTypeMatches?: (codec: string, type: string) => boolean,
 *   schema?: string,
 *   relational?: any,
 *   migration?: any,
 *   physicalNamespaceRequired?: boolean,
 *   qualifyPhysicalColumn?: (column: any, actual: any, kind: string, database?: any, catalogColumn?: any) => void,
 *   invariantTriggers?: (mapping: any, all: any, dialect: any) => any[],
 *   readChecks?: (rows: any[]) => { name: string, sql?: string, validated?: boolean, conforming?: boolean,
 *     column?: string, values?: any[] }[],
 *   introspect: { version: () => string, compileOptions: () => string,
 *     pragma: (name: string) => string,
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
  const queryGuard = spec.queryGuard ?? (() => null);
  const foreignKeyActions = spec.foreignKeyActions ?? { cascade: 'CASCADE', restrict: 'RESTRICT', setNull: 'SET NULL' };
  const referenceSql = (reference) => ` REFERENCES ${q(reference.table)} (${q(reference.column)})`
    + ` ON DELETE ${foreignKeyActions[reference.onDelete]}${spec.foreignKeySuffix ?? ''}`;

  /**
   * One planned column's definition. A path column is a VIRTUAL
   * generated column over the document; a DERIVED column is the same
   * shape over a registered deterministic function, except where the
   * driver cannot index one — there the store writes the value and the
   * column is an ordinary one. A packed vector column is ALWAYS that
   * ordinary stored column (its type is `packedVectorType`), on every
   * driver: it never has an expression to spell.
   * @param {string} docColumn
   * @param {{ name: string, type: string, pathText: string,
   *   expression?: string | null, stored?: boolean }} column
   * @returns {string}
   */
  const generatedColumnSql = (docColumn, column) => {
    if (column.stored === true) return `${q(column.name)} ${column.type}`;
    const expression = column.expression
      ?? spec.jsonExtract(q(docColumn), column.pathText, column.kind);
    return `${q(column.name)} ${column.type} GENERATED ALWAYS AS (${expression}) `
      + spec.generatedStorage;
  };

  /**
   * The identity column this dialect adds to every table it creates, or
   * `null`. An engine with no per-row identity of its own declares one
   * here rather than losing the collection's INSERTION order: the store
   * orders by `rowIdentity()` wherever the model says "the sequence",
   * and an engine that answers rows in whatever order an index scan
   * produced is not answering the same question. Declared, so the shape
   * check sees it and introspection can tell it from a model member.
   * @returns {string[]} zero or one column definition
   */
  const identityColumnSql = () => (spec.identityColumn === undefined
    ? []
    : [`${q(spec.identityColumn.name)} ${spec.identityColumn.type}`]);

  const ddl = Object.freeze({
    // the R*Tree mapping's own statements, when this spelling spec
    // carries one; a dialect without `capabilities.virtualTables`
    // composes none of them and the planner never asks
    ...(spec.rtreeDdl ?? {}),
    /**
     * The idempotent form of a CREATE statement this dialect emitted —
     * what the open path runs: two processes racing to create one fresh
     * file both probe "absent", and the loser's CREATE must be a no-op
     * rather than a failure. Only the open path takes it; a migration's
     * planned DDL keeps its exact text. Shape verification still runs on
     * the row the probe found, so an existing table is never silently
     * accepted.
     * @param {string} sql - a statement one of the builders below emitted
     * @returns {string}
     */
    idempotent(sql) {
      return sql.replace(/^CREATE (TABLE|UNIQUE INDEX|INDEX|VIRTUAL TABLE|TRIGGER) /,
        'CREATE $1 IF NOT EXISTS ');
    },
    /**
     * One collection's physical table: a key column, the JSON document
     * column, a virtual generated column per indexed path, and a named
     * CHECK per declared interval.
     * @param {{ table: string, keyColumn: string, keyType: string,
     *   docColumn: string, generated: { name: string, type: string,
     *   pathText: string }[], checks?: { name: string, sql: string }[] }} shape
     * @returns {string}
     */
    createTable({ table, keyColumn, keyType, docColumn, generated, checks = [] }) {
      const columns = [
        `${q(keyColumn)} ${keyType} PRIMARY KEY`,
        `${q(docColumn)} ${spec.docColumnType} NOT NULL`,
        ...identityColumnSql(),
        ...generated.map((g) => generatedColumnSql(docColumn, g)),
        ...checks.map((check) => `CONSTRAINT ${q(check.name)} CHECK (${check.sql})`),
      ];
      return `CREATE TABLE ${q(table)} (${columns.join(', ')})${spec.tableSuffix}`;
    },
    /**
     * The one CHECK a declared interval installs, over two operand
     * expressions for its bounds — the bound columns in a CREATE TABLE,
     * the columns' own generating expressions where an existing table's
     * rows are counted against it. The span member is absent, or it is
     * an object whose two bounds are integers by the engine's own test
     * (a spec entry: the document's JSON type, or the column's presence
     * and wholeness), safe integers, in order, and — with `maxDuration`
     * — no further apart than it. No conjunct is one a NULL satisfies:
     * a half span fails the integer test instead of passing a comparison
     * with NULL, which a CHECK would let through.
     * @param {{ docColumn: string, span: string,
     *   bounds: { start: string, end: string }, start: string, end: string,
     *   maxDuration: number | null }} shape - `span` and `bounds` are path
     *   texts as `jsonPathText` writes them; `start` and `end` the operand SQL
     * @returns {string} the CHECK's expression, without the keyword
     */
    intervalCheck({ docColumn, span, bounds, start, end, maxDuration }) {
      const docColumnSql = q(docColumn);
      const typeOf = spec.jsonTypeName(docColumnSql, span);
      const safe = (/** @type {string} */ operand) => `${operand} BETWEEN ${-SAFE_BOUND} AND ${SAFE_BOUND}`;
      const integers = spec.integerBounds({ docColumnSql,
        start: { sql: start, pathText: bounds.start }, end: { sql: end, pathText: bounds.end } });
      const duration = maxDuration === null || maxDuration === undefined ? '' : ` AND ${end} - ${start} <= ${maxDuration}`;
      return `${typeOf} IS NULL OR (${typeOf} = 'object' AND ${integers} AND ${safe(start)} AND ${safe(end)} `
        + `AND ${start} < ${end}${duration})`;
    },
    /**
     * Add a named CHECK to an existing table — a declared interval arriving
     * through a migration, on an engine that alters a table in place. The
     * engine checks every stored row as it adds the constraint, inside the
     * statement's transaction.
     * @param {{ table: string, name: string, sql: string }} shape - `sql` is
     *   the CHECK's expression, as {@link intervalCheck} renders one
     * @returns {string}
     */
    addCheck({ table, name, sql }) {
      return `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} CHECK (${sql})`;
    },
    /**
     * Drop a named CHECK from an existing table.
     * @param {{ table: string, name: string }} shape
     * @returns {string}
     */
    dropCheck({ table, name }) {
      return `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(name)}`;
    },
    /**
     * An index over columns, partial when it carries `where`: the condition
     * as SQL over the table's own columns, which the row-predicate
     * lowering renders with every literal inlined (an engine keeps no
     * parameter in a schema object).
     * @param {{ name: string, table: string, columns: string[],
     *   unique: boolean, where?: string }} shape
     * @returns {string}
     */
    createIndex({ name, table, columns, unique, where }) {
      return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} `
        + `ON ${q(table)} (${columns.map(q).join(', ')})${where === undefined ? '' : ` WHERE ${where}`}`;
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
      let sql = `ALTER TABLE ${q(table)} ADD COLUMN ${q(column.name)} ${column.type}`;
      if (column.check !== undefined) sql += ` CHECK (${column.check})`;
      if (column.references !== undefined) {
        sql += referenceSql(column.references);
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
      const rendered = columns.map((column) => {
        let sql = `${q(column.name)} ${column.type}`;
        if (column.primaryKey === true) sql += ' PRIMARY KEY';
        if (column.notNull === true) sql += ' NOT NULL';
        if (column.check !== undefined) sql += ` CHECK (${column.check})`;
        if (column.references !== undefined) {
          sql += referenceSql(column.references);
        }
        return sql;
      });
      rendered.push(...identityColumnSql());
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
      const rendered = [...columns.map((column) =>
        `${q(column.name)} ${column.type}${column.primaryKey === true ? ' PRIMARY KEY' : ''}`),
      ...identityColumnSql()];
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
    /**
     * The point read of a read-modify-write, inside the write's own
     * transaction: the row locked for the rest of it where the engine
     * locks rows (`rowLockSuffix`, PostgreSQL's `FOR UPDATE`), the plain
     * read where writers serialize anyway (SQLite, under the transaction's
     * write lock).
     * @param {{ table: string, keyColumn: string, docColumn: string }} s
     */
    getForUpdate(s) {
      return `${dml.get(s)}${spec.rowLockSuffix ?? ''}`;
    },
    /** @param {{ table: string, keyColumn: string }} s */
    del({ table, keyColumn }) {
      return `DELETE FROM ${q(table)} WHERE ${q(keyColumn)} = ${p(1, 'key')}`;
    },
    /**
     * Every spelling under which a TEXT key column may hold one NUMERIC
     * key, with each row's document: its canonical JSON text (bound
     * first) and the text an earlier write stored by binding the number
     * as a floating-point value (bound second, spelled by
     * `legacyNumericKeyText` — `'7.0'` for 7 on SQLite). Present only on
     * a dialect whose files can hold that second spelling.
     * @param {{ table: string, keyColumn: string, docColumn: string }} s
     */
    keySpellings({ table, keyColumn, docColumn }) {
      return `SELECT ${q(keyColumn)} AS ${q('key')}, ${spec.jsonText(q(docColumn))} AS ${q('doc')} `
        + `FROM ${q(table)} WHERE ${q(keyColumn)} IN `
        + `(${p(1, 'key')}, ${spec.legacyNumericKeyText(p(2, 'number'))})`;
    },
    /**
     * Move one row to another key spelling (the convergence of a legacy
     * numeric key onto its canonical text).
     * @param {{ table: string, keyColumn: string }} s
     */
    rekey({ table, keyColumn }) {
      return `UPDATE ${q(table)} SET ${q(keyColumn)} = ${p(1, 'key')} `
        + `WHERE ${q(keyColumn)} = ${p(2, 'from')}`;
    },
    /**
     * The documents of a list of row identities, in identity order —
     * the fetch of a k-nearest plan's candidates after the engine's
     * cut. `count` placeholders; a caller with fewer identities binds
     * `null` for the rest, which the membership test matches to no row.
     * Identity order is the collection's own order, so the engine's
     * stable sort over the fetched documents sees what it would have
     * seen over the whole collection.
     * @param {{ table: string, docColumn: string }} s
     * @param {number} count
     * @returns {string}
     */
    selectByIdentities({ table, docColumn }, count) {
      const rid = spec.rowIdentity();
      const placeholders = [];
      for (let i = 1; i <= count; i++) placeholders.push(p(i, 'rid'));
      return `SELECT ${spec.jsonText(q(docColumn))} AS ${q('doc')} FROM ${q(table)} `
        + `WHERE ${spec.identityIn(rid, placeholders)} ORDER BY ${rid}`;
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
    capabilities: normalizeCapabilities(spec.capabilities),
    docColumnType: spec.docColumnType,
    // the declared type of a `derive: 'vector'` column — the bytes of
    // the packed form, spelled by the dialect like every other type
    packedVectorType: spec.packedVectorType,
    quoteIdentifier: q,
    parameterRef: p,
    stringLiteral: spec.stringLiteral,
    booleanLiteral: spec.booleanLiteral,
    typeFor: spec.typeFor,
    /**
     * The declared type of a key the DATABASE allocates
     * (`identity: 'integer'`), when that is not simply the integer type
     * — an engine whose auto-allocation is a column property rather
     * than a consequence of the key's type spells it here.
     */
    autoKeyType: spec.autoKeyType,
    /**
     * The UTF-8 bytes of an identifier this engine keeps whole — it
     * truncates a longer one silently (PostgreSQL's 63) — so the plan
     * refuses a longer name (`JD0004`) before any SQL names it. `Infinity`
     * where the engine holds a name of any length.
     */
    maxIdentifierBytes: spec.maxIdentifierBytes ?? Infinity,
    /**
     * The relation names the engine gives a table's own objects when the
     * CREATE leaves them unnamed — PostgreSQL's primary-key index
     * `<table>_pkey` and a serial column's sequence `<table>_<column>_seq`
     * — given the columns the table is created with. They share one
     * namespace with the indexes the plan names, so the plan refuses an
     * index under one of them (`JD0004`). None where the engine names none.
     */
    ownRelationNames: spec.ownRelationNames ?? (() => []),
    /**
     * One declared column type reduced to the form the catalog reports
     * it as, so the shape check compares like with like: an auto-key's
     * clause, a collation, a width the engine normalizes away. Applied
     * to BOTH sides of the comparison.
     */
    comparableColumnType: spec.comparableColumnType
      ?? ((declaredType) => String(declaredType).toUpperCase()),
    /**
     * Whether a generated column over a member the schema types
     * `declaredType` can be compared against a value of `kind`
     * (`'text'`, `'number'`, `'boolean'`). On an engine whose columns
     * carry a real SQL type, comparing a `text` column to a number is a
     * type error rather than a false row, so the emitter reads the
     * member out of the document instead — the same answer, unindexed.
     */
    columnUsableFor: spec.columnUsableFor ?? (() => true),
    /** The storage word a generated column is declared with. */
    generatedStorage: spec.generatedStorage,
    /** The identity column added to every created table, or undefined. */
    identityColumn: spec.identityColumn === undefined
      ? undefined : Object.freeze({ ...spec.identityColumn }),
    limitClause: spec.limitClause,
    jsonPathText: spec.jsonPathText,
    jsonExtract: spec.jsonExtract,
    /**
     * The condition under which a QUERY reads the member at `segments`
     * from a document, or `null` when every read is right. An engine
     * whose path text cannot tell a member NAME from an array INDEX
     * answers it (PostgreSQL's `#>` takes the element `0` of an array and
     * the key `0` of an object for both); an engine whose text can,
     * answers `null`. Only query emitters call it and
     * {@link queryDocument}: the generated columns, the migrations and
     * the drift read-back keep spelling paths through {@link jsonExtract}
     * alone.
     */
    queryGuard,
    /**
     * The document expression a QUERY reads the member at `segments`
     * from: the document itself, or, where {@link queryGuard} holds a
     * condition, the document under it — one that fails the guard is no
     * document at all, so every typed form over it reads NULL, absent.
     */
    queryDocument: (documentSql, segments) => {
      const guard = queryGuard(documentSql, segments);
      return guard === null ? documentSql : `(CASE WHEN ${guard} THEN ${documentSql} END)`;
    },
    /**
     * How the row-predicate lowering spells this engine's comparisons, truth
     * values and text literals: what an index condition is rendered with.
     */
    rowPredicateFlavor: spec.rowPredicateFlavor,
    /**
     * What an engine that keeps no CREATE text reads back from its catalog in
     * its place, compared exactly with the plan: an index's condition and a
     * generated column's expression, each a difference to report or `null`;
     * and, at planning, whether a planned one reads back at all — one that
     * does not is refused there rather than met as drift at the next open.
     * Undefined where the engine keeps the text, which the open compares.
     */
    readBack: spec.readBack,
    isCreateRace: spec.isCreateRace,
    capture: spec.capture,
    jobs: spec.jobs,
    replication: spec.replication,
    /** What a read inside a write appends to lock the rows it reads
     * (PostgreSQL's ` FOR UPDATE`); empty where writers serialize anyway. */
    rowLockSuffix: spec.rowLockSuffix ?? '',
    /** What such a read appends for a row the write changes without
     * touching a key column (PostgreSQL's ` FOR NO KEY UPDATE`, the lock that
     * UPDATE itself takes): a writer that only references the row keeps its
     * key-share lock and is not waited for. Empty where writers serialize. */
    rowNoKeyLockSuffix: spec.rowNoKeyLockSuffix ?? '',
    // how a store becomes the single owner of its database, or absent
    owner: spec.owner,
    comparableForeignKeyAction: spec.comparableForeignKeyAction ?? ((action) => action),
    /**
     * A foreign-key action in this engine's SQL spelling: the model's
     * camelCase (`setNull`) through the same map the DDL renders with; a
     * catalog spelling (`SET NULL`, `NO ACTION`) passes through upper-cased.
     * @param {string} action
     * @returns {string}
     */
    foreignKeyActionSql: (action) => foreignKeyActions[action] ?? String(action).toUpperCase(),
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
      spec.jsonText(spec.jsonExtract(docColumnSql, pathText, 'json')), column),
    jsonSet: spec.jsonSet,
    jsonRemove: spec.jsonRemove,
    jsonAppend: spec.jsonAppend,
    jsonEncode: spec.jsonEncode,
    /**
     * A typed COLUMN as the JSON value it holds, for `jsonSet` to write into
     * the document when a migration folds the column into it: a boolean
     * column (1 and 0) as `true` or `false`, every other scalar as the
     * engine's own JSON of the column (`jsonValue`; the bare column where
     * the engine's JSON function reads a SQL value as the JSON value it
     * is). One implementation, so every fold spells a value alike.
     * @param {string} columnSql
     * @param {string} storage - the column's schema type
     * @returns {string}
     */
    columnJson: (columnSql, storage) => (storage === 'boolean'
      ? spec.jsonEncode(`CASE WHEN ${columnSql} = 1 THEN 'true' ELSE 'false' END`)
      : spec.jsonValue === undefined ? columnSql : spec.jsonValue(columnSql)),
    jsonText: spec.jsonText,
    jsonAgg: spec.jsonAgg,
    jsonTypeOf: spec.jsonTypeOf,
    /** A member's JSON type by the engine's own name (SQL NULL for an absent member). */
    jsonTypeName: spec.jsonTypeName,
    /**
     * The spellings {@link jsonTypeOf} answers for a JSON NUMBER. SQLite
     * discriminates the two it stores (`integer`, `real`); an engine with
     * one JSON number type answers one name. Everything else in the
     * vocabulary is shared — `text`, `true`, `false`, `null`, `object`,
     * `array` — because the row decoder reads those names in JavaScript.
     */
    numericTypeNames: Object.freeze([...spec.numericTypeNames]),
    /**
     * Whether {@link jsonExtract} at a kind is TYPED: SQL NULL for an
     * absent member, a stored JSON null and every other JSON type, so a
     * literal or list comparison and a string operator read the value
     * alone and its presence is the type guard. An untyped extraction
     * (SQLite's, which reads whatever the member holds) keeps the
     * `json_type` guards of the truth table beside every comparison;
     * those are load-bearing there. Externals and type tests keep the
     * discriminator on every engine: an external's type is known only
     * when it binds, and a type test asks for the type by name.
     */
    typedExtract: spec.typedExtract === true,
    /**
     * The most leaf predicates one statement carries, or `null` for no
     * bound. A database whose planner prices every term per row and
     * hands a long enough chain to a JIT compile it cannot interrupt
     * sets one; the planner then answers a document past it in the
     * engine, named, and a graph load or a native mutation, which have
     * no engine path, refuse it by name. Counted once the planner has
     * regrouped, so a chain that folds to one membership list is one
     * term however long it is.
     */
    maxPredicateTerms: typeof spec.maxPredicateTerms === 'number' ? spec.maxPredicateTerms : null,
    /** An object built from alternating name/value SQL — the shape a
     * graph load's nested include answers. */
    jsonObject: spec.jsonObject,
    /** The document column as a NESTED JSON value rather than as text:
     * what an enclosing object embeds, as opposed to what a caller
     * reads back. On an engine with one JSON type the two differ. */
    jsonEmbed: spec.jsonEmbed,
    /**
     * How an EXTERNAL operand's value reaches a statement. `'value'`
     * binds it as itself — a dynamically typed engine compares it with
     * whatever the member holds. `'json'` binds its JSON encoding,
     * because a statically typed engine cannot bind one placeholder
     * against a text member in one branch and a numeric member in
     * another: the parameter's own type is fixed when it is bound, and
     * a guard the row would fail does not stop the coercion.
     */
    externalEncoding: spec.externalEncoding ?? 'value',
    /** The MEMBER side of an external comparison, at the branch's kind. */
    externalCompare: spec.externalCompare ?? ((valueSql) => valueSql),
    /** The PARAMETER side of an external comparison, at the same kind. */
    externalRef: spec.externalRef ?? ((paramSql) => paramSql),
    valueTypeOf: spec.valueTypeOf,
    strStartsWith: spec.strStartsWith,
    strStartsWithExact: spec.strStartsWithExact,
    strEndsWith: spec.strEndsWith,
    strContains: spec.strContains,
    orderNulls: spec.orderNulls,
    /**
     * The instant a fixed-width bucket ladder labels one row with:
     * `origin + floor((at - origin) / every) * every`, which reduces to
     * `at` less the non-negative remainder. The parameters appear in
     * TEXT order — the origin once, the width three times — because a
     * positional dialect numbers them by where they are written.
     */
    timeBucket: spec.timeBucket,
    /** One grouped aggregate; `null` counts ROWS rather than values. */
    groupAggregate: spec.groupAggregate,
    rowIdentity: spec.rowIdentity,
    /** Membership of the row identity in a bound list — the fetch of a
     * k-nearest plan's candidates after the engine's cut. */
    identityIn: spec.identityIn,
    /**
     * The R\*Tree spelling: the module name and the virtual table's own
     * column list, in `(id, minx, maxx, miny, maxy)` order. Read only
     * where a `physical: 'rtree'` column set is planned, so a spelling
     * spec that omits it simply cannot carry that mapping.
     */
    rtree: Object.freeze({ ...spec.rtree }),
    /**
     * The schema type a declared column type came from — the inverse of
     * {@link typeFor}, as far as one exists. `undefined` where the
     * column carries no scalar type, and where a mapping is lossy the
     * introspector says so rather than guessing: two schema types that
     * share a column type cannot be told apart on the way back.
     */
    schemaTypeOf: spec.schemaTypeOf,
    /**
     * The member path a GENERATED column's expression reads, recovered
     * from the dialect's own spelling of it. `null` for an expression
     * this dialect did not write — which is a loss the introspector
     * reports rather than a path it invents.
     */
    memberPathOf: spec.memberPathOf,
    /**
     * How this dialect's interval CHECK reads back through the one
     * interval reader, for a session whose string spelling is as given.
     */
    intervalSpelling: spec.intervalSpelling,
    /**
     * The declared index EXPRESSION a generated column's SQL computes,
     * recovered from the dialect's own spelling of it. `byName` maps the
     * engine's function name back to the model's — the same name where
     * the store registered it, the host's `sql` name where the engine
     * has its own. `null` for anything this dialect did not write, which
     * the introspector reports rather than guesses.
     */
    expressionOf: spec.expressionOf,
    /**
     * The `{ name, expression }` pairs behind `introspect.generated`'s
     * rows. Two engines answer that question with different row shapes
     * — one hands back a catalog column, the other the table's whole
     * CREATE text — and the dialect that wrote the expression is the
     * one that can read it.
     */
    readGenerated: spec.readGenerated,
    readChecks: spec.readChecks,
    physicalRead: spec.physicalRead,
    physicalCompare: spec.physicalCompare,
    physicalValueType: spec.physicalValueType,
    physicalDifferent: spec.physicalDifferent,
    numberCast: spec.numberCast ?? ((sql) => `CAST(${sql} AS REAL)`),
    distinct: spec.distinct ?? ((left, right) => `${left} IS NOT ${right}`),
    mutationRowGuard: spec.mutationRowGuard,
    boundMutation: spec.boundMutation,
    codepoint: spec.codepoint,
    /** Membership of a value in a JSON list bound as one parameter, one
     * kind (`'text'` or `'number'`) at a time — the one IN-list spelling
     * every membership test and `cellIn` share. */
    inList: spec.inList,
    physicalTypeMatches: spec.physicalTypeMatches,
    schema: spec.schema,
    relational: spec.relational,
    migration: spec.migration,
    physicalNamespaceRequired: spec.physicalNamespaceRequired,
    qualifyPhysicalColumn: spec.qualifyPhysicalColumn,
    tableName: (name, schema) => schema === undefined ? q(name) : `${q(schema)}.${q(name)}`,
    invariantTriggers: spec.invariantTriggers,
    explainQuery: spec.explainQuery,
    /** The plan narrative, one line per row the engine answered. */
    explainLines: spec.explainLines,
    /**
     * The statement that asks the database's planner for its own row
     * estimate of `sql`, or `null` on an engine with none to give. It runs
     * beside {@link explainQuery}, never in place of it, and
     * {@link readEstimate} reads what it returns.
     */
    explainEstimate: spec.explainEstimate ?? null,
    /**
     * The estimate in the rows `explainEstimate` returned, as `{ rows,
     * source }` where `source` names whose number it is, or `null` for an
     * answer this dialect cannot read: a number is never made up.
     */
    readEstimate: spec.readEstimate ?? null,
    /**
     * Whether one narrative line reports a FULL TABLE SCAN of one of
     * the named tables (or of an alias a join statement gave one). The
     * safe profile's scan refusal is verified against the database's own
     * plan, and only the dialect can read that engine's words.
     */
    isFullScan: spec.isFullScan,
    /** Whether one narrative line reports a seek through the named index. */
    usesIndex: spec.usesIndex,
    excludedRef: spec.excludedRef,
    /** The SQL spelling of the text a NUMBER bound as a floating-point
     * value takes in a TEXT column — SQLite's `'7.0'` for 7, which is
     * what node:sqlite stored before numeric keys were bound as their
     * canonical text — or `null` on a dialect whose files cannot hold
     * such a spelling. */
    legacyNumericKeyText: spec.legacyNumericKeyText ?? null,
    epochFromRfc3339: spec.epochFromRfc3339,
    tx: Object.freeze({ ...spec.tx }),
    pragma: Object.freeze({ ...spec.pragma }),
    introspect: Object.freeze({ ...spec.introspect }),
    ddl,
    dml,
  });
}
