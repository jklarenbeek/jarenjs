//@ts-check
/**
 * @file Database → model: `introspectModel(connection)` reads a live
 * database's catalog and derives the `jaren-model` document that would
 * produce it, beside a report of everything it could not.
 *
 * Two rules shape the whole module.
 *
 * **It is read-only.** Nothing here issues DDL or DML, opens a
 * transaction or registers a function. A derived model is an ANSWER;
 * applying it is the migration planner's job and the operator's
 * decision, and the two are deliberately not the same act.
 *
 * **It never claims a byte-perfect round trip.** A physical shape
 * carries less than the model that made it — a document's unindexed
 * members are simply not there, a `TEXT` key column cannot say which
 * pointer filled it, `numeric` on PostgreSQL carries both `integer` and
 * `number` — so every gap is a REPORTED row with a stable code and a
 * path, sorted, once. `strict: true` refuses rather than returning a
 * partial model, because a caller that is going to diff the result
 * against a declared model needs to know the difference is real.
 *
 * The neutral IR in the middle is what makes the two engines answer the
 * same question: the dialect's catalog statements hand back tables,
 * columns, indexes and foreign keys in one row shape, and only the
 * dialect knows how to read its own generated-column expression back
 * into a member path.
 */

import { chain, useStatementOnce } from './driver.js';
import { DbCompileError } from './errors.js';
import { readOptionsOrNull } from './options.js';
import { KEY_COLUMN, DOC_COLUMN, SCALAR_CODECS, indexCondition, canonicalOf, kindIndexName, containerKeysOf, kindIndexSql,
  entityIndexTerm } from './ddl.js';
import { columnKindFor } from './scalar-types.js';
import { readPredicate, readIntervalCheck, sqlTokens, SQLITE_PREDICATE } from './dialects/check-read.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { isKeyword } from './sql.js';
import { foldIdentifier } from './invariants.js';
import { MODEL_VERSION, ENGINE_TABLES, IDENTIFIER } from './engine-metadata.js';
import { registeredName, expressionMembers } from './expression.js';
import { memberNames, modelPath, readModelPath, readsAsIndex } from './model-path.js';
import { isJsonObject, setObjectMember } from '@jarenjs/core/object';

/**
 * Every code the loss report uses, with what it means. Closed, and
 * stable: a caller branches on these, and a report row nobody can name
 * is a report nobody reads.
 */
export const INTROSPECT_CODES = Object.freeze({
  'unmapped-table': 'a table whose shape is not one this model format declares',
  'unmapped-view': 'a view, which a model document cannot declare',
  'unmapped-object': 'a trigger or another schema object a model cannot declare',
  'unmapped-column': 'a column that is neither a key, the document, the row identity, '
    + 'nor a generated column over a member path',
  'unmapped-type': 'a column type no schema type maps back from',
  'unmapped-index': 'an index over something the model cannot name — an expression, '
    + 'a partial predicate the condition reader does not read back exactly, or a column that is not mapped',
  'unmapped-constraint': 'a CHECK or a constraint the model has no vocabulary for',
  'lossy-type': 'two schema types share this column type, so the derived one is a choice',
  'key-source': 'the key column cannot say which document member filled it',
  'document-members': 'the document\'s unindexed members are not in the physical shape',
  'ambiguous-relation': 'a foreign key whose relation cannot be inferred from the shape alone',
});

/**
 * One report row.
 * @param {string} code
 * @param {string} object - the physical object it is about
 * @param {string} detail
 * @returns {{ code: string, object: string, detail: string }}
 */
function loss(code, object, detail) {
  return { code, object, detail };
}

/**
 * Read the neutral IR for one table: its columns, its declared indexes
 * with their covered columns in order, and its foreign keys.
 * @param {any} connection
 * @param {string} table
 * @returns {any} value-or-promise
 */
function readTable(connection, table, objects) {
  const dialect = connection.dialect;
  const all = (sql) => useStatementOnce(connection, sql, (statement) => statement.all([]));
  return chain(all(dialect.introspect.columns(table)), (columnRows) =>
    chain(all(dialect.introspect.indexes(table)), (indexRows) =>
      chain(all(dialect.introspect.generated(table)), (generatedRows) =>
        chain(all(dialect.introspect.foreignKeyList(table)), (fkRows) => {
          // a DECLARED index is one the model could have named; the
          // engine's own key index is the primary key, read the same way
          // BY NAME, whatever order the catalog answered in: a physical
          // shape carries no record of the order a model declared its
          // indexes in, and a derivation two engines must agree on
          // cannot inherit one engine's listing order
          const declared = indexRows.filter((row) => String(row.origin) === 'c')
            .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
          const keyIndex = indexRows.find((row) => String(row.origin) === 'pk');
          // the key an expression term holds, as the server deparses it, where the
          // catalog reads one: what an index beside a declared one is read back by
          const termsOf = (/** @type {string} */ name, /** @type {any[]} */ rows) =>
            (!rows.some((row) => row.name == null) || dialect.introspect.indexKeyColumns === undefined ? null
              : chain(all(dialect.introspect.indexKeyColumns(name)), (keys) =>
                keys.map((key) => (typeof key.term === 'string' ? key.term : null))));
          const withColumns = (i, out) => {
            if (i >= declared.length) return out;
            return chain(all(dialect.introspect.indexColumns(String(declared[i].name))),
              (rows) => chain(termsOf(String(declared[i].name), rows), (terms) => withColumns(i + 1, [...out, {
                name: String(declared[i].name),
                unique: Number(declared[i].uniq) !== 0,
                partial: Number(declared[i].partial ?? 0) !== 0,
                columns: rows.map((row) => row.name == null ? null : String(row.name)),
                ...(terms === null ? {} : { terms }),
                sql: objects.find((o) => o.type === 'index' && o.name === String(declared[i].name))?.sql ?? null,
                // an engine that keeps no CREATE text reports the condition and
                // the index's shape from its catalog, as the open reads them
                predicate: declared[i].predicate == null ? null : String(declared[i].predicate),
                plain: declared[i].plain == null || Number(declared[i].plain) === 1,
                conforming: declared[i].conforming == null || String(declared[i].conforming) === 'on',
              }])));
          };
          return chain(withColumns(0, []), (indexes) =>
            chain(keyIndex === undefined
              ? []
              : all(dialect.introspect.indexColumns(String(keyIndex.name))), (keyRows) =>
              chain(dialect.introspect.checks === undefined ? []
                : all(dialect.introspect.checks(table)), (checkRows) => ({
              name: table,
              sql: objects.find((o) => o.type === 'table' && o.name === table)?.sql ?? null,
              primaryKey: columnRows.some((row) => Number(row.pk) > 0)
                ? columnRows.filter((row) => Number(row.pk) > 0)
                  .sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => String(row.name))
                : keyRows.map((row) => String(row.name)),
              columns: columnRows.map((row) => ({
                name: String(row.name),
                type: String(row.type),
                generated: Number(row.hidden) !== 0,
                primaryKeyOrdinal: Number(row.pk ?? 0),
                nullable: Number(row.not_null ?? 0) === 0,
                default: row.default_value ?? null,
                ...(row.schema === undefined ? {} : { native: {
                  schema: String(row.schema), identity: String(row.identity ?? ''),
                  generated: String(row.generated_kind ?? ''), typeKind: String(row.type_kind),
                  typeSchema: String(row.type_schema), typeName: String(row.type_name), collation: row.collation ?? null,
                } }),
              })),
              generated: dialect.readGenerated(generatedRows),
              indexes,
              checks: dialect.readChecks?.(checkRows) ?? [],
              foreignKeys: fkRows.map((row) => ({
                column: String(row.source_column),
                target: String(row.target),
                targetColumn: row.target_column === null || row.target_column === undefined
                  ? null : String(row.target_column),
                onDelete: String(row.on_delete ?? 'NO ACTION').toUpperCase(),
                onUpdate: String(row.on_update ?? 'NO ACTION').toUpperCase(),
                group: row.id ?? null,
                ordinal: Number(row.seq ?? 0),
                match: String(row.match ?? 'NONE'),
              })),
            }))));
        }))));
}

/** The type a member read back through a number-first read is declared in:
 * `number` first, then every other JSON kind, so it admits every value. */
const NUMBER_FIRST = Object.freeze(['number', 'string', 'boolean', 'object', 'array', 'null']);

/** The on-delete words a model declares. */
const MODEL_ACTIONS = Object.freeze(['cascade', 'restrict', 'setNull']);

/**
 * The on-delete word a model declares for the action a catalog reports: the
 * word whose SQL the dialect writes reads back as that action (PostgreSQL
 * writes `restrict` as a deferrable NO ACTION key, and reads it back so).
 * @param {any} dialect @param {string} action @returns {string | undefined}
 */
const onDeleteOf = (dialect, action) => MODEL_ACTIONS.find((word) =>
  dialect.comparableForeignKeyAction(dialect.foreignKeyActionSql(word)) === dialect.comparableForeignKeyAction(action));

/**
 * Refuse an introspection option that is none of its own, or of the wrong type
 * (`JD0013`): a misspelt `strict` read a partial model as the whole one, and a
 * string for `tables` was read as a set of its characters.
 * @param {any} options
 */
function readIntrospectOptions(options) {
  readOptionsOrNull(options, ['strict', 'tables', 'keys', 'expressions'], 'introspect');
  if (options === undefined || options === null) return;
  const refuse = (/** @type {string} */ name, /** @type {string} */ rule) =>
    new DbCompileError('JD0013', `introspect option '${name}' ${rule}`);
  if (options.strict !== undefined && typeof options.strict !== 'boolean') throw refuse('strict', 'is true or false');
  if (options.tables !== undefined && !(Array.isArray(options.tables) && options.tables.every((name) => typeof name === 'string')))
    throw refuse('tables', 'is an array of table names');
  if (options.keys !== undefined && (!isJsonObject(options.keys)))
    throw refuse('keys', 'is an object of document pointers by table');
}

/**
 * Read the whole database into the neutral IR: one entry per table and
 * per view, in catalog order.
 * @param {any} connection
 * @param {{ tables?: readonly string[] }} [options]
 * @returns {any} value-or-promise of `{ tables, views }`
 */
export function readSchema(connection, options = undefined) {
  readIntrospectOptions(options);
  const dialect = connection.dialect;
  const engine = ENGINE_TABLES;
  const wanted = options?.tables === undefined ? null : new Set(options.tables);
  return chain(useStatementOnce(connection, dialect.introspect.tables(), (statement) => statement.all([])), (rows) => {
    const views = [];
    const names = [];
    for (const row of rows) {
      const name = String(row.name);
      if (engine.has(name)) continue;
      if (wanted !== null && !wanted.has(name)) continue;
      if (String(row.type) === 'view') views.push(name);
      else names.push(name);
    }
    const readObjects = dialect.introspect.objects === undefined ? []
      : useStatementOnce(connection, dialect.introspect.objects(), (s) => s.all([]));
    /** An object of an inspected table, its own or the table itself: never
     * the engine's, and within the requested tables. @param {any} row */
    const inspected = (row) => !engine.has(String(row.owner))
      && (wanted === null || wanted.has(String(row.owner)) || wanted.has(String(row.name)));
    return chain(readObjects, (catalog) => {
      const complete = [...catalog];
      for (const row of rows) {
        if (!complete.some((o) => o.type === row.type && o.name === row.name))
          complete.push({ ...row, owner: row.name, sql: null });
      }
      const objects = complete.filter(inspected)
        .map((row) => ({ type: String(row.type), name: String(row.name),
          owner: String(row.owner), sql: row.sql ?? null }));
      const step = (i, out) => (i >= names.length
        ? { tables: out, views, objects }
        : chain(readTable(connection, names[i], objects), (table) => step(i + 1, [...out, table])));
      return chain(step(0, []), (schema) => dialect.introspect.catalog === undefined ? schema
        : useStatementOnce(connection, dialect.introspect.catalog(), (statement) =>
          chain(statement.all([]), (native) => ({ ...schema, catalog: native
            .filter(inspected)
            .map((row) => ({ type: String(row.type), name: String(row.name), owner: String(row.owner),
              schema: String(row.schema), sql: row.sql ?? null,
              metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata })) }))));
    });
  });
}

/**
 * Whether a table's shape is a COLLECTION's: a key column, the document
 * column, whatever row identity the dialect declares, and generated
 * columns over member paths and nothing else.
 * @param {any} dialect
 * @param {any} table
 * @returns {boolean}
 */
function looksLikeCollection(dialect, table) {
  const identity = dialect.identityColumn?.name;
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  if (!byName.has(KEY_COLUMN) || !byName.has(DOC_COLUMN)) return false;
  if (dialect.comparableColumnType(byName.get(DOC_COLUMN).type)
    !== dialect.comparableColumnType(dialect.docColumnType)) return false;
  for (const column of table.columns) {
    if (column.name === KEY_COLUMN || column.name === DOC_COLUMN
      || column.name === identity) continue;
    // a column a unique index keys a container by, beside its member's
    // generated column ({@link containerKeysHeld} reads it exactly)
    if (!column.generated && !(dialect.containerKey !== undefined && column.name.startsWith('kx_')
      && byName.get(`gx_${column.name.slice(3)}`)?.generated === true)) return false;
  }
  return true;
}

/**
 * The container key columns a collection table holds (`ddl.js`
 * `containerKeysOf`), each with the two triggers that write it and the
 * indexes beside a unique index that key it, exactly as a store creates them
 * for the unique indexes over the members the table holds: what a model read
 * back plans again, so none is a loss. A column, trigger or index that is
 * not exactly that is left to be reported.
 * @param {any} dialect
 * @param {any} table
 * @param {Map<string, { segments: import('./dialect.js').JsonPathSegment[] }>} paths - the members by their generated columns
 * @param {{ type: string, name: string, owner: string, sql: string | null }[]} objects - the schema's objects
 * @returns {{ columns: Set<string>, triggers: Set<string>, indexes: Set<string> }}
 */
function containerKeysHeld(dialect, table, paths, objects) {
  const held = { columns: new Set(), triggers: new Set(), indexes: new Set() };
  if (dialect.containerKey === undefined) return held;
  const untyped = dialect.typeFor(undefined, 'generated');
  const comparable = dialect.comparableColumnType;
  const generated = table.columns.flatMap((/** @type {any} */ column) => {
    const entry = paths.get(column.name);
    const pathText = entry === undefined ? null : dialect.jsonPathText(entry.segments);
    return pathText === null ? [] : [{ name: column.name, pathText,
      type: comparable(column.type) === comparable(untyped) ? untyped : column.type }];
  });
  const indexes = table.indexes.flatMap((/** @type {any} */ index) => {
    if (!index.unique || index.partial) return [];
    const columns = kindKeyedColumns(dialect, table, index, paths) ?? index.columns;
    return columns.some((/** @type {string | null} */ column) => column === null || !paths.has(column)) ? []
      : [{ name: index.name, unique: true, columns, declared: {} }];
  });
  const planned = containerKeysOf(dialect, table.name, indexes, generated);
  const same = (/** @type {string | null | undefined} */ have, /** @type {string} */ want) =>
    typeof have === 'string' && comparableDeclaredSql(have) === comparableDeclaredSql(want);
  for (const key of planned.keys) {
    const column = table.columns.find((/** @type {any} */ candidate) => candidate.name === key.column);
    if (column === undefined || column.generated || comparable(column.type) !== comparable(key.type)) continue;
    if (!key.triggers.every((trigger) => same(objects.find((object) => object.type === 'trigger'
      && object.owner === table.name && object.name === trigger.name)?.sql, trigger.sql))) continue;
    held.columns.add(key.column);
    for (const trigger of key.triggers) held.triggers.add(trigger.name);
  }
  for (const index of planned.indexes) {
    if (!index.keys.every((/** @type {any} */ key) => !('read' in key) || held.columns.has(key.column))) continue;
    if (same(table.indexes.find((/** @type {any} */ candidate) => candidate.name === index.name)?.sql, kindIndexSql(dialect, table.name, index)))
      held.indexes.add(index.name);
  }
  return held;
}

/**
 * The indexes a table holds beside its plain path indexes that key another
 * kind of a member of several types (`ddl.js` `kindIndexesOf`): each under
 * the name the plan gives it, unique where its declared index is, with no
 * condition, keying each member either by its column or by exactly the read
 * of the member at one kind. Each member's type gains the kinds read so
 * after its column's, so the model read back plans the same indexes beside
 * it. A declared index that is not unique has them over a single member
 * path its read does not guard alone.
 * @param {any} dialect
 * @param {any} table
 * @param {Map<string, { type: string | string[] | undefined, segments: import('./dialect.js').JsonPathSegment[], open: boolean }>} paths
 *   - the members by their generated columns; a folded type is written back
 * @returns {Set<string>} the names of the indexes read so
 */
function kindIndexesOf(dialect, table, paths) {
  /** @type {Set<string>} */
  const read = new Set();
  if (dialect.readBack?.indexKey === undefined) return read;
  const doc = dialect.quoteIdentifier(DOC_COLUMN);
  for (const index of table.indexes) {
    const entries = index.columns.map((/** @type {string | null} */ column) => (column === null ? undefined : paths.get(column)));
    if (index.partial || entries.length === 0 || entries.some((/** @type {any} */ entry) => entry === undefined)
      || (!index.unique && (entries.length !== 1 || entries[0].open))) continue;
    /** The kind each member of an index beside this one is keyed at, `null` for its column. */
    const matched = [];
    for (const beside of table.indexes) {
      if (beside === index || beside.partial || beside.unique !== index.unique || beside.columns.length !== entries.length) continue;
      const kinds = beside.columns.map((/** @type {string | null} */ column, /** @type {number} */ at) => {
        if (column !== null) return column === index.columns[at] ? null : undefined;
        const entry = entries[at];
        const term = beside.terms?.[at];
        const pathText = dialect.jsonPathText(entry.segments);
        if (typeof term !== 'string' || entry.type === undefined || pathText === null) return undefined;
        // the read under the guard the column carries, or the other spelling of a guarded path
        // (a table whose model a link declared the container the other way)
        const spellings = [entry.open ? entry.segments : undefined,
          ...(dialect.queryGuard(doc, entry.segments) === null ? [] : [entry.open ? undefined : entry.segments])];
        return KIND_TYPES.find(([kind]) => spellings.some((unpinned) => dialect.readBack.indexKey(term,
          dialect.columnRead(doc, { pathText, kind, unpinned }), beside.conforming) === null))?.[0];
      });
      if (kinds.every((/** @type {any} */ kind) => kind !== undefined) && kinds.some((/** @type {any} */ kind) => kind !== null))
        matched.push({ beside, kinds });
    }
    const varied = entries.map((/** @type {any} */ _entry, /** @type {number} */ at) => matched.some(({ kinds }) => kinds[at] !== null));
    /** The kinds each member is read at by an index beside this one. @type {Set<string>[]} */
    const held = entries.map(() => new Set());
    for (const { beside, kinds } of matched) {
      const label = kinds.flatMap((/** @type {any} */ kind, /** @type {number} */ at) => (!varied[at] ? []
        : [kind ?? columnKindFor(typeof entries[at].type === 'string' ? entries[at].type : entries[at].type?.[0])])).join('$');
      if (beside.name !== kindIndexName(dialect, index.name, label)) continue;
      read.add(beside.name);
      kinds.forEach((/** @type {any} */ kind, /** @type {number} */ at) => { if (kind !== null) held[at].add(kind); });
    }
    entries.forEach((/** @type {any} */ entry, /** @type {number} */ at) => {
      for (const [kind, type] of KIND_TYPES) {
        const types = typeof entry.type === 'string' ? [entry.type] : entry.type;
        if (held[at].has(kind) && !types.includes(type) && columnKindFor(types[0]) !== kind) entry.type = [...types, type];
      }
    });
  }
  return read;
}

/**
 * The columns of a unique index that keys, after them, each member's kind
 * where its column alone would key two kinds as one (`ddl.js`
 * `kindKeyTerms`): the index whose CREATE text is the one a store creates
 * over those columns, or the one an earlier release created, with the keys
 * over untyped columns alone. `null` for every other index.
 * @param {any} dialect
 * @param {any} table
 * @param {{ name: string, unique: boolean, columns: (string | null)[], sql: string | null }} index
 * @param {Map<string, { segments: import('./dialect.js').JsonPathSegment[] }>} paths - by column
 * @returns {string[] | null}
 */
function kindKeyedColumns(dialect, table, index, paths) {
  const at = index.columns.indexOf(null);
  if (!index.unique || at <= 0 || dialect.kindKeyTerm === undefined || index.sql === null) return null;
  const columns = /** @type {string[]} */ (index.columns.slice(0, at));
  const untyped = dialect.comparableColumnType(dialect.typeFor(undefined, 'generated'));
  const termsOf = (/** @type {boolean} */ untypedOnly) => columns.flatMap((name) => {
    const entry = paths.get(name);
    const column = table.columns.find((/** @type {any} */ candidate) => candidate.name === name);
    const pathText = entry === undefined ? null : dialect.jsonPathText(entry.segments);
    const term = pathText === null || column === undefined || untypedOnly && dialect.comparableColumnType(column.type) !== untyped ? null
      : dialect.kindKeyTerm(dialect.quoteIdentifier(DOC_COLUMN), pathText, dialect.comparableColumnType(column.type));
    return term === null ? [] : [term];
  });
  const held = comparableDeclaredSql(index.sql);
  return [termsOf(false), termsOf(true)].some((terms) => terms.length > 0
    && held === comparableDeclaredSql(dialect.ddl.createIndex({ name: index.name, table: table.name, columns, unique: true, terms }))) ? columns : null;
}

/** The schema type each kind an index beside a declared one seeks reads back as. */
const KIND_TYPES = /** @type {const} */ ([['text', 'string'], ['number', 'number'], ['boolean', 'boolean'], ['object', 'object'], ['array', 'array']]);

/**
 * Derive one collection. The schema it answers holds exactly the
 * members the physical shape carries — the indexed paths, and the key
 * where one is known — because the rest of the document is not there to
 * be read; that absence is a reported row, not a silence.
 * @param {any} dialect
 * @param {any} table
 * @param {(row: any) => void} report
 * @param {Record<string, string> | undefined} keys
 * @param {Record<string, string>} functionNames - the engine's function names back to the model's
 * @param {{ type: string, name: string, owner: string, sql: string | null }[]} objects - the schema's objects
 * @param {Set<string>} owned - collects the triggers the collection's container keys own
 * @returns {any}
 */
function deriveCollection(dialect, table, report, keys, functionNames, objects, owned) {
  const identity = dialect.identityColumn?.name;
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  const expressions = new Map(table.generated.map((entry) => [entry.name, entry.expression]));

  /** @type {Map<string, { path: string, type: string | string[] | undefined,
   *   segments: import('./dialect.js').JsonPathSegment[], open: boolean }>} */
  const paths = new Map();
  /** @type {Map<string, any>} column -> the declared index expression */
  const computed = new Map();
  /** The columns whose expression reads its member under the dialect's guard. @type {Set<string>} */
  const guarded = new Set();
  /** The columns whose type two schema types share — reported once the
   * declared intervals are known, since a bound column's type is not a choice. */
  const lossy = [];
  for (const column of table.columns) {
    if (!column.generated) continue;
    const expression = expressions.get(column.name);
    const segments = expression === undefined ? null : dialect.memberPathOf(expression);
    const open = expression !== undefined && dialect.memberGuarded?.(expression) === true;
    if (segments === null) {
      // a DECLARED EXPRESSION, then — the other kind of generated column
      // this format writes, and the dialect that wrote its SQL is the
      // one that can read it back
      const declared = expression === undefined || dialect.expressionOf === undefined
        ? null : dialect.expressionOf(expression, functionNames ?? {});
      if (declared !== null) {
        computed.set(column.name, declared);
        if (open) guarded.add(column.name);
        continue;
      }
      report(loss('unmapped-column', `${table.name}.${column.name}`,
        'a generated column whose expression is neither a member path nor a declared '
        + 'index expression this dialect wrote'));
      continue;
    }
    let type = dialect.schemaTypeOf(column.type);
    if (type === undefined && dialect.memberReadsNumbersFirst?.(expression) === true) {
      // the read of a member whose union lists `number` first: the union's
      // other types leave no trace, and a union of every kind admits what
      // any of them did and plans the same read
      type = [...NUMBER_FIRST];
      report(loss('unmapped-type', `${table.name}.${column.name}`,
        `the column type '${column.type}' maps back to no schema type, and its read of the `
        + 'member\'s numbers as doubles is that of a union that lists `number` first, whose other '
        + `types are not recorded, so the member is typed ${JSON.stringify(NUMBER_FIRST)}`));
    }
    else if (type === undefined) {
      report(loss('unmapped-type', `${table.name}.${column.name}`,
        `the column type '${column.type}' maps back to no schema type, so the member `
        + 'is left untyped'));
    }
    else lossy.push(column);
    paths.set(column.name, { path: modelPath(segments), type, segments, open });
  }

  const besides = kindIndexesOf(dialect, table, paths);
  const containers = containerKeysHeld(dialect, table, paths, objects);
  for (const trigger of containers.triggers) owned.add(trigger);
  for (const column of table.columns) {
    if (column.generated || column.name === KEY_COLUMN || column.name === DOC_COLUMN || column.name === identity
      || containers.columns.has(column.name)) continue;
    report(loss('unmapped-column', `${table.name}.${column.name}`,
      'a plain column beside the generated ones that is not a container key a unique index over the members the table holds keys'));
  }

  /** The columns a plain path index covers — what a declaration requires of an interval's bounds. @type {Set<string>} */
  const indexedColumns = new Set();
  const indexes = [];
  for (const index of table.indexes) {
    if (besides.has(index.name) || containers.indexes.has(index.name)) continue;
    const columns = kindKeyedColumns(dialect, table, index, paths) ?? index.columns;
    if (index.partial || columns.some((/** @type {string | null} */ column) => column === null)) {
      report(loss('unmapped-index', `${table.name}.${index.name}`,
        'a partial predicate or expression term cannot be represented by an unconditional member index'));
      continue;
    }
    if (columns.length === 1 && computed.has(columns[0])) {
      const declared = { name: indexName(table.name, index.name),
        expression: computed.get(columns[0]) };
      if (index.unique) declared.unique = true;
      indexes.push(declared);
      continue;
    }
    const covered = columns.map((/** @type {string} */ column) => paths.get(column));
    if (covered.some((/** @type {any} */ entry) => entry === undefined)) {
      report(loss('unmapped-index', `${table.name}.${index.name}`,
        `the index covers (${columns.join(', ')}), which is not a member path set`));
      continue;
    }
    const declared = { name: indexName(table.name, index.name), path: covered.length === 1
      ? covered[0].path : covered.map((/** @type {any} */ entry) => entry.path) };
    if (index.unique) declared.unique = true;
    indexes.push(declared);
    for (const column of columns) indexedColumns.add(column);
  }

  // a declared interval: the one CHECK, under the name the store gives it,
  // over the generated columns of its span's two bounds, each covered by a
  // plain index — read back into the declaration, which types the bounds;
  // every other CHECK is a loss
  const intervals = [];
  /** @type {{ span: import('./dialect.js').JsonPathSegment[], start: string, end: string }[]} */
  const spans = [];
  for (const check of table.checks) {
    const interval = intervalOf(dialect, check, paths, indexedColumns);
    if (typeof interval === 'string') {
      report(loss('unmapped-constraint', `${table.name}.${check.name}`, interval));
      continue;
    }
    intervals.push(interval.declaration);
    spans.push(interval);
  }
  const bounds = new Set(spans.flatMap((span) => [span.start, span.end]));
  for (const column of lossy) if (!bounds.has(column.name)) reportLossyType(dialect, table, column, report);

  // the key: a database-allocated integer says so in its type; a text
  // one cannot say which member filled it, and the caller may
  const keyColumn = byName.get(KEY_COLUMN);
  const keyType = dialect.schemaTypeOf(keyColumn.type);
  const collection = { schema: { type: 'object', properties: {} }, indexes,
    ...(intervals.length === 0 ? {} : { intervals }) };
  const hinted = keys !== undefined && Object.hasOwn(keys, table.name) ? keys[table.name] : undefined;
  if (keyType === 'integer') {
    collection.key = null;
    collection.identity = 'integer';
  }
  else if (hinted !== undefined) {
    collection.key = hinted;
  }
  else {
    collection.key = null;
    collection.identity = 'uuid';
    report(loss('key-source', `${table.name}.${KEY_COLUMN}`,
      'the key column carries no record of which document member filled it; '
      + "identity: 'uuid' was derived, and a key pointer can be supplied by the caller"));
  }

  // the schema: the members the shape carries, and a stated absence for
  // every one it does not
  if (typeof collection.key === 'string' && collection.key.startsWith('/')) {
    placeType(collection.schema, collection.key.slice(1).split('/')
      .filter((member) => member.length > 0).map((name) => ({ name })), keyType);
  }
  // a bound a CHECK holds to an integer is one, whatever its column's type
  for (const [column, entry] of paths)
    placeType(collection.schema, entry.segments, bounds.has(column) ? 'integer' : entry.type, entry.open);
  for (const span of spans) requireBounds(collection.schema, span.span);
  // a member an EXPRESSION reads is in the document too, and the
  // expression's own column says nothing about its type — the schema
  // names it untyped rather than not at all
  for (const [column, expression] of computed) {
    for (const member of expressionMembers(expression)) {
      const segments = memberSegments(member);
      if (segments !== null) placeType(collection.schema, segments, undefined, guarded.has(column));
    }
  }
  if (collection.schema.properties === undefined) collection.schema.properties = {};
  report(loss('document-members', table.name,
    'a document\'s unindexed members leave no trace in the physical shape, so the derived '
    + 'schema holds only the members an index or the key names'));
  if (identity !== undefined && !byName.has(identity)) {
    report(loss('unmapped-table', table.name,
      `the dialect declares the row identity column '${identity}', which this table does not `
      + 'have — the collection was derived, but its order is not the engine\'s'));
  }
  return collection;
}

/**
 * Place a member's declared type at the end of its path, building the
 * skeleton the walk needs to find it again.
 *
 * The physical shape carries the type of every member an index covers,
 * at whatever depth — and `schemaTypeAt` finds it by walking
 * `properties` / `prefixItems` / `items`, so a derived schema that only
 * named the top member would type the column `ANY` on the way back and
 * the round trip would not converge. Nothing else is invented: a node
 * on the way to a typed leaf is an object or an array because the path
 * says so, and a leaf with no type is an empty schema.
 *
 * A member the catalog reads under the dialect's guard (`open`) was declared
 * with a container the schema leaves open, and a step the guard covers (an
 * index, a name that reads as one) leaves the container it meets untyped, so
 * the derived model plans the same guard.
 * @param {any} node - the schema node to place into
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @param {string | string[] | undefined} type
 * @param {boolean} [open]
 */
function placeType(node, segments, type, open = false) {
  let current = node;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if ('index' in segment) {
      if (current.type === undefined && !open) current.type = 'array';
      if (current.prefixItems === undefined) current.prefixItems = [];
      while (current.prefixItems.length <= segment.index) current.prefixItems.push({});
      if (last) {
        if (type !== undefined) current.prefixItems[segment.index] = { type };
        return;
      }
      current = current.prefixItems[segment.index];
      continue;
    }
    if (current.type === undefined && !(open && readsAsIndex(segment.name))) current.type = 'object';
    if (current.properties === undefined) current.properties = {};
    // an own member, whatever the document names it: `__proto__` assigned
    // would rewrite the map's prototype and leave no member
    const existing = Object.hasOwn(current.properties, segment.name) ? current.properties[segment.name] : undefined;
    if (last) {
      // a member already typed by the key keeps that type; two indexes
      // over one member agree by construction (one column serves both)
      if (existing === undefined || existing.type === undefined)
        setObjectMember(current.properties, segment.name, type === undefined ? {} : { type });
      return;
    }
    if (existing === undefined) setObjectMember(current.properties, segment.name, {});
    current = current.properties[segment.name];
  }
}

/**
 * A `$.a.b[0]` path back into typed segments — the shape `placeType`
 * walks. `null` for a path that is not one of names and non-negative
 * indexes.
 * @param {string} path
 * @returns {import('./dialect.js').JsonPathSegment[] | null}
 */
function memberSegments(path) {
  const read = readModelPath(path);
  return 'segments' in read && read.segments.every((segment) => !('index' in segment) || segment.index >= 0) ? read.segments : null;
}

/**
 * Read one collection CHECK as a declared interval — the one template, under
 * the name the store gives a declaration (`<name>_interval`), over the
 * generated columns of its span member's `start` and `end` — or say why it
 * is not one. A CHECK a model would not write again is a loss, never a
 * guess: another shape, another name, bound columns that are not the span's
 * or that no plain index covers (a declaration requires each bound indexed
 * by its path), or (PostgreSQL) one added `NOT VALID`, whose rows were
 * never checked.
 * @param {any} dialect
 * @param {{ name: string, sql?: string, validated?: boolean, conforming?: boolean }} check
 * @param {Map<string, { segments: import('./dialect.js').JsonPathSegment[] }>} paths - the
 *   member path each generated column reads
 * @param {Set<string>} indexed - the columns a plain path index covers
 * @returns {{ declaration: { name: string, path: string, maxDuration?: number },
 *   span: import('./dialect.js').JsonPathSegment[], start: string, end: string } | string}
 */
function intervalOf(dialect, check, paths, indexed) {
  const other = 'a CHECK over physical collection columns does not constrain the document schema';
  if (check.sql === undefined || dialect.intervalSpelling === undefined) return other;
  if (check.validated === false) return 'the CHECK was added NOT VALID, so the rows it holds were never checked against it';
  const read = readIntervalCheck(check.sql, dialect.intervalSpelling(check.conforming !== false));
  if (read === null) return other;
  const stem = /^(.*)_interval$/.exec(check.name)?.[1];
  if (stem === undefined || !IDENTIFIER.test(stem))
    return 'an interval CHECK under a name the store would not give a declaration (<name>_interval)';
  /** @param {string} column @param {string} bound */
  const boundColumn = (column, bound) => {
    const entry = paths.get(column);
    return entry !== undefined && canonicalOf(entry.segments) === canonicalOf([...read.span, { name: bound }]);
  };
  if (read.column !== DOC_COLUMN || !boundColumn(read.start, 'start') || !boundColumn(read.end, 'end'))
    return 'an interval CHECK whose bound columns are not the generated columns of its span member';
  if (!indexed.has(read.start) || !indexed.has(read.end))
    return 'an interval CHECK over a bound column no index covers: a declaration requires each bound indexed by its path';
  /** @type {{ name: string, path: string, maxDuration?: number }} */
  const declaration = { name: stem, path: modelPath(read.span) };
  if (read.maxDuration !== null) declaration.maxDuration = read.maxDuration;
  return { declaration, span: read.span, start: read.start, end: read.end };
}

/**
 * Require a recovered span's two bounds at its schema node — what the CHECK
 * holds for every stored row, and what the declaration's rule reads.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments - the span's path
 */
function requireBounds(schema, segments) {
  let node = schema;
  for (const segment of segments) {
    node = 'index' in segment ? node?.prefixItems?.[segment.index] : node?.properties?.[segment.name];
  }
  if (node !== undefined) node.required = ['start', 'end'];
}

/** The model's own index name, out of the physical `<table>_<name>`. */
function indexName(table, physical) {
  return physical.startsWith(`${table}_`) ? physical.slice(table.length + 1) : physical;
}

/**
 * Derive one ENTITY: the primary key, the mapped scalar columns, the
 * foreign keys as `manyToOne` relations, and the document column for
 * everything else.
 * @param {any} dialect
 * @param {any} table
 * @param {(row: any) => void} report
 * @param {{ child: string, column: string, fk: any }[]} edges - receives each
 *   foreign key: its edge is declared once every entity is derived
 * @param {EntityExpressions} expressions - the host's declarations, by which an
 *   index over an expression reads back
 * @returns {any}
 */
function deriveEntity(dialect, table, report, edges, expressions) {
  const identity = dialect.identityColumn?.name;
  const primaryKey = new Set(table.primaryKey ?? []);
  const fkByColumn = new Map(table.foreignKeys.map((fk) => [fk.column, fk]));
  const uniqueColumns = new Set();
  const indexedColumns = new Set();
  const readable = readableColumns(dialect, table);
  // a one-column index named as a `unique` or `index` property's own, over a
  // column the entity maps, is that property's when it is the very index the
  // flag plans; every other index is an entry of the entity's `indexes`
  const flags = [], others = [];
  for (const index of table.indexes) {
    const [only] = index.columns;
    const flag = !index.partial && index.columns.length === 1 && index.name === `${table.name}_${only}`
      && readable.some((c) => c.physical === only) && plannedDifference(dialect, table, index, undefined, readable) === null;
    (flag ? flags : others).push(index);
  }
  // every name the derived entity plans is one the store accepts: compared
  // with ASCII case folded, as it compares them, in the order it plans them —
  // the table and the engine's own relations, the flags' indexes, the entries
  /** @type {Map<string, string>} */
  const taken = new Map();
  /** The name an earlier object took, or `undefined` once this one takes it. @param {string} name */
  const claim = (name) => {
    const first = taken.get(foldIdentifier(name));
    if (first === undefined) taken.set(foldIdentifier(name), name);
    return first;
  };
  for (const name of [table.name, ...dialect.ownRelationNames(table.name, dialect.identityColumn === undefined ? [] : [dialect.identityColumn])]) claim(name);
  const collision = (/** @type {any} */ index, /** @type {string} */ first) => report(loss('unmapped-index', `${table.name}.${index.name}`,
    `its name is the name of '${first}' with ASCII case folded, as the store compares names, so a model could not declare both`));
  for (const index of flags) {
    const first = claim(index.name);
    if (first === undefined) (index.unique ? uniqueColumns : indexedColumns).add(index.columns[0]);
    else collision(index, first);
  }
  const indexes = [];
  for (const index of others) {
    const declared = entityIndexOf(dialect, table, index, readable, expressions);
    const first = typeof declared === 'string' ? undefined : claim(index.name);
    if (typeof declared === 'string') report(loss('unmapped-index', `${table.name}.${index.name}`, declared));
    else if (first !== undefined) collision(index, first);
    else indexes.push(declared);
  }

  const properties = {};
  const required = [];
  for (const column of table.columns) {
    if (column.name === identity || column.name === DOC_COLUMN) continue;
    if (column.generated) {
      report(loss('unmapped-column', `${table.name}.${column.name}`,
        'a generated column on an entity table is not an entity property'));
      continue;
    }
    // the foreign key column is a typed property like any other: the edge it
    // belongs to is declared beside it, on an entity not derived yet
    const fk = fkByColumn.get(column.name);
    if (fk !== undefined) edges.push({ child: table.name, column: column.name, fk });
    const type = dialect.schemaTypeOf(column.type);
    if (type === undefined) {
      report(loss('unmapped-type', `${table.name}.${column.name}`,
        `the column type '${column.type}' maps back to no schema type`));
    }
    else reportLossyType(dialect, table, column, report);
    const property = type === undefined ? {} : { type };
    const entity = {};
    if (primaryKey.has(column.name)) { entity.key = true; required.push(column.name); }
    if (uniqueColumns.has(column.name)) entity.unique = true;
    else if (indexedColumns.has(column.name)) entity.index = true;
    if (Object.keys(entity).length > 0) property['x-entity'] = entity;
    setObjectMember(properties, column.name, property);
  }
  for (const check of table.checks) {
    const property = Object.hasOwn(properties, check.column) ? properties[check.column] : undefined;
    const family = property?.type === 'integer' ? 'number'
      : property?.type === 'string' ? 'string' : property?.type;
    if (check.values === undefined || property === undefined
      || check.values.some((value) => typeof value !== family
        || (property.type === 'integer' && !Number.isInteger(value)))) {
      report(loss('unmapped-constraint', `${table.name}.${check.name}`,
        'the CHECK is not a complete scalar enum of the mapped column type'));
      continue;
    }
    // Several enum CHECKs constrain the same column by intersection.
    const values = property.enum === undefined ? check.values
      : property.enum.filter((value) => check.values.includes(value));
    if (values.length === 0) {
      report(loss('unmapped-constraint', `${table.name}.${check.name}`,
        'the enum CHECKs have an empty intersection, which a non-empty schema enum cannot declare'));
    }
    else property.enum = values;
  }
  report(loss('document-members', table.name,
    'an entity\'s document column holds every property the mapping did not give a column, '
    + 'and those are not in the physical shape'));
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required.sort();
  return indexes.length > 0 ? { schema, indexes } : { schema };
}

/**
 * The member an edge is declared as on an entity: `plain`, unless a column or
 * another edge already has it, then qualified by the foreign key's column (or
 * the join table's name), so that no member is replaced.
 * @param {any} properties @param {string} plain @param {string} qualifier
 * @returns {string}
 */
function edgeMember(properties, plain, qualifier) {
  let member = plain;
  for (let n = 1; Object.hasOwn(properties, member); n++) member = `${plain}_${qualifier}${n > 1 ? `_${n}` : ''}`;
  return member;
}

/**
 * Declare the relation each foreign key belongs to, now that every entity is
 * derived: the typed foreign-key property stays what it is, and the edge is
 * written beside it, as a model declares one. A key that is unique holds one
 * row of the child per parent, so it is a one-to-one declared on the child; any
 * other is a one-to-many declared on the parent. A foreign key a model cannot
 * declare (it spans several columns, references no single key of a derived
 * entity, carries an action the model has no word for, or is typed unlike the
 * key it references) is reported `unmapped-constraint` and left out.
 * @param {any} dialect @param {Record<string, any>} entities @param {any[]} tables
 * @param {{ child: string, column: string, fk: any }[]} edges
 * @param {(row: any) => void} report
 */
function declareEdges(dialect, entities, tables, edges, report) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  for (const { child, column, fk } of edges) {
    const where = `${child}.${column}`;
    const refuse = (/** @type {string} */ why) => report(loss('unmapped-constraint', where,
      `the foreign key to '${fk.target}' is not declared: ${why}`));
    const composite = fk.ordinal !== 0 || byName.get(child).foreignKeys.some((/** @type {any} */ other) =>
      other !== fk && other.group !== null && other.group === fk.group);
    if (composite) { refuse('it spans several columns'); continue; }
    if ((byName.get(child).primaryKey ?? []).includes(column)) { refuse('its column is the table\'s own key'); continue; }
    if (!Object.hasOwn(entities, fk.target)) { refuse('it references a table that is not an entity of this model'); continue; }
    const parent = entities[fk.target];
    const keys = Object.entries(parent.schema.properties).filter(([, property]) => /** @type {any} */ (property)['x-entity']?.key === true);
    if (keys.length !== 1 || (fk.targetColumn !== null && fk.targetColumn !== keys[0][0])) {
      refuse('it does not reference the single key of the entity'); continue;
    }
    const property = entities[child].schema.properties[column];
    if (property.type === undefined || property.type !== /** @type {any} */ (keys[0][1]).type) {
      refuse(`its column is typed ${property.type ?? 'unlike the key'}, not as the key it references`); continue;
    }
    if (fk.onUpdate !== 'NO ACTION') { refuse(`it has the ON UPDATE action ${fk.onUpdate}`); continue; }
    const onDelete = onDeleteOf(dialect, fk.onDelete);
    if (onDelete === undefined) { refuse(`its ON DELETE action is ${fk.onDelete}, which a model does not declare`); continue; }
    const oneToOne = property['x-entity']?.unique === true;
    const owner = oneToOne ? entities[child] : parent;
    const member = oneToOne
      ? edgeMember(owner.schema.properties, fk.target.toLowerCase(), column)
      : edgeMember(owner.schema.properties, `${child.toLowerCase()}s`, column);
    setObjectMember(owner.schema.properties, member, { 'x-entity': { relation: oneToOne
      ? { to: fk.target, via: column, onDelete } : { to: child, many: true, via: column, onDelete } } });
    report(loss('ambiguous-relation', where,
      `the foreign key was declared as a ${oneToOne ? 'one-to-one' : 'one-to-many'} relation on '${oneToOne ? child : fk.target}' `
      + `as '${member}'; which side a model declared it on, whether the other holds many, and under what name, `
      + 'is not in the physical shape'));
  }
}

/**
 * The columns of an entity table an index or its condition may read: a
 * scalar column the entity maps (a key and a foreign key included), each
 * with the codec its type reads back as. A member of any name has a path:
 * `$.<member>`, or `$["<member>"]` for one that is no identifier.
 * @param {any} dialect @param {any} table
 * @returns {{ name: string, physical: string, codec: string }[]}
 */
function readableColumns(dialect, table) {
  const identity = dialect.identityColumn?.name;
  return table.columns.flatMap((/** @type {any} */ column) => {
    const codec = SCALAR_CODECS.get(dialect.schemaTypeOf(column.type));
    return column.generated || column.name === DOC_COLUMN || column.name === identity
      || codec === undefined ? [] : [{ name: column.name, physical: column.name, codec }];
  });
}

/**
 * The text after a CREATE INDEX statement's top-level `WHERE`, or `null`.
 * @param {string | null} sql @returns {string | null}
 */
function conditionText(sql) {
  if (sql === null) return null;
  let depth = 0;
  for (const token of sqlTokens(sql)) {
    if (token.kind === 'symbol') depth += token.value === '(' ? 1 : token.value === ')' ? -1 : 0;
    else if (depth === 0 && isKeyword(token, 'WHERE')) return sql.slice(token.at + 5);
  }
  return null;
}

/**
 * The `indexes` entry an entity table's declared index derives, or why it
 * cannot (the `unmapped-index` detail). Its terms are columns the entity maps,
 * its name carries the table's prefix, a condition reads back into the query
 * grammar, and the entry plans exactly the index the database holds, compared
 * as every open compares it — the stored CREATE text where the engine keeps
 * one, the catalog's condition and shape where it does not — so a derived
 * index never claims more than the database enforces.
 * An index over one expression key derives an `expression` entry where the
 * dialect reads the key back as a declared function over the string columns
 * the entity maps (MODEL-FORMAT §7A) — which takes the host's declarations.
 * @param {any} dialect @param {any} table @param {any} index
 * @param {{ name: string, physical: string, codec: string }[]} readable
 * @param {EntityExpressions} [expressions]
 * @returns {any} the entry, or the reason as a string
 */
function entityIndexOf(dialect, table, index, readable, expressions = undefined) {
  const name = index.name.slice(table.name.length + 1);
  if (!index.name.startsWith(`${table.name}_`) || !IDENTIFIER.test(name))
    return `the index name does not start with '${table.name}_', the prefix of every index a model declares on the entity`;
  /** @param {string} member */
  const pathOf = (member) => modelPath([{ name: member }]);
  /** @type {string | undefined} */
  let term;
  /** @type {any} */
  let declared;
  if (index.columns.length === 1 && index.columns[0] === null && typeof index.terms?.[0] === 'string') {
    term = /** @type {string} */ (index.terms[0]);
    const strings = readable.filter((column) => column.codec === 'text').map((column) => column.physical);
    const expression = dialect.expressionOf?.(term, expressions?.byName ?? {}, strings) ?? null;
    if (expression === null || !Object.hasOwn(expression, 'call')) {
      return `the index keys ${term}, which does not read back as a declared function over the string columns the entity maps `
        + '(pass the declarations the model was opened with as introspect({ expressions }))';
    }
    declared = { name, expression, ...(index.unique ? { unique: true } : {}) };
  }
  else if (index.columns.some((/** @type {string | null} */ column) => !readable.some((c) => c.physical === column)))
    return `the index covers (${index.columns.map((/** @type {string | null} */ column) => column ?? '<expression>').join(', ')}), `
      + 'which are not all scalar columns the entity maps';
  else declared = { name, path: index.columns.length === 1 ? pathOf(index.columns[0]) : index.columns.map(pathOf),
    ...(index.unique ? { unique: true } : {}) };
  const keepsText = dialect.capabilities?.declaredSqlText === true;
  /** @type {string | undefined} */
  let rendered;
  if (index.partial) {
    const text = keepsText ? conditionText(index.sql) : index.predicate;
    const member = (/** @type {string} */ identifier) => {
      const column = readable.find((c) => c.physical === identifier);
      return column === undefined ? null : { path: pathOf(column.name), codec: column.codec };
    };
    const where = text === null ? null : keepsText ? readPredicate(text, SQLITE_PREDICATE, member)
      : dialect.readBack?.read(text, readable, index.conforming) ?? null;
    if (where === null) return 'the partial predicate is not one the condition reader reads back into the query grammar';
    try { rendered = indexCondition(where, readable, dialect, `/entities/${table.name}/indexes`, (member) => `'${member}' is not mapped`); }
    catch { return 'the partial predicate reads back as a condition the model refuses'; }
    declared.where = where;
  }
  if (term !== undefined) {
    // the key the derived entry plans, compared with the one the catalog holds
    /** @type {string | null} */
    let planned = null;
    try {
      planned = entityIndexTerm({ name, expression: declared.expression,
        reads: expressionMembers(declared.expression).map((path) => /** @type {string[]} */ (memberNames(path))[0]) },
      dialect, expressions?.declarations, `/entities/${table.name}/indexes`);
    }
    catch { planned = null; }
    if (planned === null || dialect.readBack?.indexKey(term, planned, index.conforming) !== null)
      return `the index keys ${term}, which is not the key the derived expression plans`;
    if (!index.plain || (dialect.readBack?.condition(index.predicate, rendered, readable, index.conforming) ?? null) !== null)
      return 'the index is not the plain ascending B-tree, under the condition, that the derived expression plans';
    return declared;
  }
  return plannedDifference(dialect, table, index, rendered, readable) ?? declared;
}

/**
 * The host's index-function declarations as introspection reads an entity's
 * expression index back by them: the engine's function names back to the
 * model's (`byName`), and the declarations themselves.
 * @typedef {{ byName: Record<string, string>, declarations?: Record<string, any> }} EntityExpressions
 */

/**
 * How a declared index differs from the one a model plans over its columns
 * (with the rendered condition, if any), compared as every open compares it —
 * the stored CREATE text where the engine keeps one, the catalog's shape and
 * condition where it does not — or `null` where it is that index.
 * @param {any} dialect @param {any} table @param {any} index
 * @param {string | undefined} rendered - the condition as the model renders it
 * @param {{ name: string, physical: string, codec: string }[]} readable
 * @returns {string | null}
 */
function plannedDifference(dialect, table, index, rendered, readable) {
  if (dialect.capabilities?.declaredSqlText === true) {
    const planned = dialect.ddl.createIndex({ name: index.name, table: table.name, columns: index.columns, unique: index.unique, where: rendered });
    let same = false;
    try { same = index.sql !== null && comparableDeclaredSql(index.sql) === comparableDeclaredSql(planned); }
    catch { same = false; }
    return same ? null : 'the stored index text is not the text the derived index plans (a collation, a key order, or another spelling of its condition)';
  }
  if (!index.plain) return 'the index is not the plain ascending B-tree a model declares (NULLS NOT DISTINCT, a key order, collation or operator class of its own, an INCLUDE column, or a deferred check)';
  return rendered === undefined || dialect.readBack?.condition(index.predicate, rendered, readable, index.conforming) === null
    ? null : 'the stored condition does not compare equal to the one the derived index plans';
}

/**
 * Report (`lossy-type`) a column whose type more than one scalar schema type
 * is stored as: the type it maps back to and every one the dialect itself
 * writes into a column of that type. The derived type is then a choice.
 * @param {any} dialect @param {any} table @param {any} column @param {(row: any) => void} report
 */
function reportLossyType(dialect, table, column, report) {
  const comparable = dialect.comparableColumnType(column.type);
  const derived = dialect.schemaTypeOf(column.type);
  const origins = new Set([derived]);
  for (const type of SCALAR_CODECS.keys()) {
    const stored = dialect.typeFor?.(type, 'generated');
    if (stored !== undefined && dialect.comparableColumnType(stored) === comparable) origins.add(type);
  }
  if (origins.size < 2) return;
  report(loss('lossy-type', `${table.name}.${column.name}`, `the column type '${column.type}' holds `
    + `${[...origins].sort().join(' and ')} members alike, so the derived '${derived}' is a choice`));
}

/**
 * Whether a table is a many-to-many JOIN table: two foreign-key columns,
 * a composite key over exactly those, no document column of its own.
 * @param {any} dialect
 * @param {any} table
 * @returns {boolean}
 */
function looksLikeJoinTable(dialect, table) {
  const identity = dialect.identityColumn?.name;
  const own = table.columns.filter((column) => column.name !== identity);
  if (own.length !== 2) return false;
  if (own.some((column) => column.name === DOC_COLUMN)) return false;
  const keys = new Set(table.foreignKeys.map((fk) => fk.column));
  return own.every((column) => keys.has(column.name));
}

/**
 * Derive a model from a live database.
 *
 * Read-only, whatever the answer: no statement it issues writes, and a
 * refusal in `strict` mode happens after every read and before any
 * model is returned — a caller never gets half of one.
 * @param {any} connection - an open connection (a store's, or a driver's)
 * @param {{ strict?: boolean, tables?: readonly string[],
 *   keys?: Record<string, string> }} [options] - `keys` supplies the
 *   document pointer a text key column cannot record; `tables` narrows
 *   the read to a named set
 * @returns {any} value-or-promise of `{ model, report }`
 */
export function introspectModel(connection, options = undefined) {
  readIntrospectOptions(options);
  const dialect = connection.dialect;
  // the engine's function name back to the model's: the registration
  // this store made where it computes an expression itself, the host's
  // own `sql` name where the engine calls its own. Only the
  // declarations carry the mapping, which is why they are an option
  const byName = {};
  for (const [name, declared] of Object.entries(options?.expressions ?? {})) {
    byName[registeredName(name)] = name;
    if (typeof declared?.sql === 'string') byName[declared.sql] = name;
  }
  return chain(readSchema(connection, options), (schema) => {
    /** @type {{ code: string, object: string, detail: string }[]} */
    const report = [];
    const add = (row) => report.push(row);
    for (const view of schema.views) {
      add(loss('unmapped-view', view,
        'a view is not a shape a model document can declare'));
    }
    /** The triggers a collection's container keys own, which a model read back creates again. @type {Set<string>} */
    const owned = new Set();
    for (const object of schema.objects) {
      if (object.type === 'trigger') add({ ...loss('unmapped-object', object.name,
        'an application-owned trigger program must be explicitly preserved; inspection grants no drop permission'),
      sql: object.sql, owner: object.owner });
    }

    const joinTables = new Set(schema.tables
      .filter((table) => looksLikeJoinTable(dialect, table))
      .map((table) => table.name));

    /** @type {any} */
    const model = { $model: MODEL_VERSION };
    const collections = {};
    const entities = {};
    /** @type {{ child: string, column: string, fk: any }[]} */
    const edges = [];
    for (const table of schema.tables) {
      if (joinTables.has(table.name)) continue;
      // a collection and an entity are named by an identifier: a model that
      // declared any other name would be refused whole (JD0005)
      if (!IDENTIFIER.test(table.name)) {
        add(loss('unmapped-table', table.name,
          'the table\'s name is not an identifier (an ASCII letter or underscore, then ASCII letters, digits '
          + 'and underscores), the only kind a model gives a collection or an entity'));
        continue;
      }
      if (looksLikeCollection(dialect, table)) {
        setObjectMember(collections, table.name, deriveCollection(dialect, table, add, options?.keys, byName, schema.objects, owned));
        continue;
      }
      const hasDocument = table.columns.some((column) => column.name === DOC_COLUMN);
      const hasKey = (table.primaryKey ?? []).length > 0;
      if (!hasDocument && !hasKey) {
        add(loss('unmapped-table', table.name,
          'the table has neither a document column nor a key, so it is neither a collection '
          + 'nor an entity'));
        continue;
      }
      setObjectMember(entities, table.name, deriveEntity(dialect, table, add, edges, { byName, declarations: options?.expressions }));
    }
    declareEdges(dialect, entities, schema.tables, edges, add);
    for (let i = report.length - 1; i >= 0; i--)
      if (report[i].code === 'unmapped-object' && owned.has(report[i].object)) report.splice(i, 1);

    // a join table's edge belongs to the two entities it joins, and it
    // is declared on ONE of them — the shape cannot say which, so it is
    // declared on the alphabetically first and reported
    for (const table of schema.tables) {
      if (!joinTables.has(table.name)) continue;
      const [left, right] = table.foreignKeys.map((fk) => fk.target).sort();
      if (left === undefined || right === undefined
        || !Object.hasOwn(entities, left) || !Object.hasOwn(entities, right)) {
        add(loss('unmapped-table', table.name,
          'the join table points at something this read did not derive as an entity'));
        continue;
      }
      // the edge's name on `left` is its target's, pluralised, unless a column
      // or another edge between the two already has it: then the join table's
      // name tells them apart, so no member is replaced
      const properties = entities[left].schema.properties;
      const member = edgeMember(properties, `${right.toLowerCase()}s`, table.name);
      setObjectMember(properties, member, {
        'x-entity': { relation: { to: right, many: true, through: table.name } },
      });
      add(loss('ambiguous-relation', table.name,
        `a many-to-many edge between '${left}' and '${right}' was declared on '${left}' as `
        + `'${member}'; which side a model declared it on, and under what name, is not in the `
        + 'physical shape'));
    }

    if (Object.keys(collections).length > 0) model.collections = collections;
    if (Object.keys(entities).length > 0) model.entities = entities;

    report.sort((a, b) => (a.code === b.code
      ? (a.object < b.object ? -1 : a.object > b.object ? 1 : 0)
      : (a.code < b.code ? -1 : 1)));

    if (options?.strict === true && report.length > 0) {
      throw new DbCompileError('JD0002',
        `strict introspection refused: the physical shape does not carry ${report.length} `
        + `thing(s) the model would — ${report.map((row) => `${row.code} (${row.object})`)
          .join(', ')}`);
    }
    const inventory = (schema.catalog ?? schema.objects).map((object) => Object.freeze({ ...object,
      disposition: object.type === 'trigger' || object.type === 'view'
        || !['table', 'index'].includes(object.type)
        || report.some((row) => row.object === object.name
          || row.object === `${object.owner}.${object.name}`
          || (row.code === 'unmapped-table' && row.object === object.owner))
        ? 'preserve' : 'derived' }));
    return { model, report: Object.freeze(report.map((row) => Object.freeze(row))),
      inventory: Object.freeze(inventory) };
  });
}
