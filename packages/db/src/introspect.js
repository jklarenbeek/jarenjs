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

import { chain } from './driver.js';
import { DbCompileError } from './errors.js';
import { KEY_COLUMN, DOC_COLUMN } from './ddl.js';
import { MODEL_VERSION } from './store.js';
import { ENGINE_TABLES } from './migrate.js';
import { registeredName, expressionMembers } from './expression.js';

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
    + 'a partial predicate, or a column that is not mapped',
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
function readTable(connection, table) {
  const dialect = connection.dialect;
  const all = (sql) => chain(connection.prepare(sql), (statement) => statement.all([]));
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
          const withColumns = (i, out) => {
            if (i >= declared.length) return out;
            return chain(all(dialect.introspect.indexColumns(String(declared[i].name))),
              (rows) => withColumns(i + 1, [...out, {
                name: String(declared[i].name),
                unique: Number(declared[i].uniq) !== 0,
                partial: Number(declared[i].partial ?? 0) !== 0,
                columns: rows.map((row) => row.name == null ? null : String(row.name)),
              }]));
          };
          return chain(withColumns(0, []), (indexes) =>
            chain(keyIndex === undefined
              ? []
              : all(dialect.introspect.indexColumns(String(keyIndex.name))), (keyRows) =>
              chain(dialect.introspect.checks === undefined ? []
                : all(dialect.introspect.checks(table)), (checkRows) => ({
              name: table,
              primaryKey: keyRows.map((row) => String(row.name)),
              columns: columnRows.map((row) => ({
                name: String(row.name),
                type: String(row.type),
                generated: Number(row.hidden) !== 0,
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
              })),
            }))));
        }))));
}

/** The on-delete word a model declares, from the catalog's. */
const ON_DELETE = Object.freeze({
  CASCADE: 'cascade', RESTRICT: 'restrict', 'SET NULL': 'setNull',
});

/**
 * Read the whole database into the neutral IR: one entry per table and
 * per view, in catalog order.
 * @param {any} connection
 * @param {{ tables?: readonly string[] }} [options]
 * @returns {any} value-or-promise of `{ tables, views }`
 */
export function readSchema(connection, options = undefined) {
  const dialect = connection.dialect;
  const engine = ENGINE_TABLES;
  const wanted = options?.tables === undefined ? null : new Set(options.tables);
  return chain(connection.prepare(dialect.introspect.tables()), (statement) =>
    chain(statement.all([]), (rows) => {
      const views = [];
      const names = [];
      for (const row of rows) {
        const name = String(row.name);
        if (engine.has(name)) continue;
        if (wanted !== null && !wanted.has(name)) continue;
        if (String(row.type) === 'view') views.push(name);
        else names.push(name);
      }
      const step = (i, out) => (i >= names.length
        ? { tables: out, views }
        : chain(readTable(connection, names[i]), (table) => step(i + 1, [...out, table])));
      return step(0, []);
    }));
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
    if (!column.generated) return false;
  }
  return true;
}

/**
 * Derive one collection. The schema it answers holds exactly the
 * members the physical shape carries — the indexed paths, and the key
 * where one is known — because the rest of the document is not there to
 * be read; that absence is a reported row, not a silence.
 * @param {any} dialect
 * @param {any} table
 * @param {(row: any) => void} report
 * @param {Record<string, string> | undefined} keys
 * @returns {any}
 */
function deriveCollection(dialect, table, report, keys, functionNames) {
  const identity = dialect.identityColumn?.name;
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  const expressions = new Map(table.generated.map((entry) => [entry.name, entry.expression]));

  /** @type {Map<string, { path: string, type: string | undefined,
   *   segments: import('./dialect.js').JsonPathSegment[] }>} */
  const paths = new Map();
  /** @type {Map<string, any>} column -> the declared index expression */
  const computed = new Map();
  for (const column of table.columns) {
    if (!column.generated) continue;
    const expression = expressions.get(column.name);
    const segments = expression === undefined ? null : dialect.memberPathOf(expression);
    if (segments === null) {
      // a DECLARED EXPRESSION, then — the other kind of generated column
      // this format writes, and the dialect that wrote its SQL is the
      // one that can read it back
      const declared = expression === undefined || dialect.expressionOf === undefined
        ? null : dialect.expressionOf(expression, functionNames ?? {});
      if (declared !== null) {
        computed.set(column.name, declared);
        continue;
      }
      report(loss('unmapped-column', `${table.name}.${column.name}`,
        'a generated column whose expression is neither a member path nor a declared '
        + 'index expression this dialect wrote'));
      continue;
    }
    const type = dialect.schemaTypeOf(column.type);
    if (type === undefined) {
      report(loss('unmapped-type', `${table.name}.${column.name}`,
        `the column type '${column.type}' maps back to no schema type, so the member `
        + 'is left untyped'));
    }
    paths.set(column.name, { path: pathExpression(segments), type, segments });
  }

  const indexes = [];
  for (const index of table.indexes) {
    if (index.partial || index.columns.some((column) => column === null)) {
      report(loss('unmapped-index', `${table.name}.${index.name}`,
        'a partial predicate or expression term cannot be represented by an unconditional member index'));
      continue;
    }
    if (index.columns.length === 1 && computed.has(index.columns[0])) {
      const declared = { name: indexName(table.name, index.name),
        expression: computed.get(index.columns[0]) };
      if (index.unique) declared.unique = true;
      indexes.push(declared);
      continue;
    }
    const covered = index.columns.map((column) => paths.get(column));
    if (covered.some((entry) => entry === undefined)) {
      report(loss('unmapped-index', `${table.name}.${index.name}`,
        `the index covers (${index.columns.join(', ')}), which is not a member path set`));
      continue;
    }
    const declared = { name: indexName(table.name, index.name), path: covered.length === 1
      ? covered[0].path : covered.map((entry) => entry.path) };
    if (index.unique) declared.unique = true;
    indexes.push(declared);
  }

  // the key: a database-allocated integer says so in its type; a text
  // one cannot say which member filled it, and the caller may
  const keyColumn = byName.get(KEY_COLUMN);
  const keyType = dialect.schemaTypeOf(keyColumn.type);
  const collection = { schema: { type: 'object', properties: {} }, indexes };
  const hinted = keys?.[table.name];
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
  for (const entry of paths.values())
    placeType(collection.schema, entry.segments, entry.type);
  // a member an EXPRESSION reads is in the document too, and the
  // expression's own column says nothing about its type — the schema
  // names it untyped rather than not at all
  for (const expression of computed.values()) {
    for (const member of expressionMembers(expression)) {
      const segments = memberSegments(member);
      if (segments !== null) placeType(collection.schema, segments, undefined);
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
 * @param {any} node - the schema node to place into
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @param {string | undefined} type
 */
function placeType(node, segments, type) {
  let current = node;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if ('index' in segment) {
      if (current.type === undefined) current.type = 'array';
      if (current.prefixItems === undefined) current.prefixItems = [];
      while (current.prefixItems.length <= segment.index) current.prefixItems.push({});
      if (last) {
        if (type !== undefined) current.prefixItems[segment.index] = { type };
        return;
      }
      current = current.prefixItems[segment.index];
      continue;
    }
    if (current.type === undefined) current.type = 'object';
    if (current.properties === undefined) current.properties = {};
    if (last) {
      const existing = current.properties[segment.name];
      // a member already typed by the key keeps that type; two indexes
      // over one member agree by construction (one column serves both)
      if (existing === undefined || existing.type === undefined)
        current.properties[segment.name] = type === undefined ? {} : { type };
      return;
    }
    if (current.properties[segment.name] === undefined) current.properties[segment.name] = {};
    current = current.properties[segment.name];
  }
}

/** `$.a.b[0]`, in the spelling a model's index path takes. */
function pathExpression(segments) {
  let text = '$';
  for (const segment of segments) {
    if ('index' in segment) { text += `[${segment.index}]`; continue; }
    text += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.name)
      ? `.${segment.name}` : `[${JSON.stringify(segment.name)}]`;
  }
  return text;
}

/**
 * A `$.a.b[0]` path back into typed segments — the shape `placeType`
 * walks. `null` for a spelling this module did not produce.
 * @param {string} path
 * @returns {import('./dialect.js').JsonPathSegment[] | null}
 */
function memberSegments(path) {
  if (!path.startsWith('$')) return null;
  const segments = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === '.') {
      const match = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(path.slice(i));
      if (match === null) return null;
      segments.push({ name: match[1] });
      i += match[0].length;
      continue;
    }
    if (path[i] === '[') {
      const end = path.indexOf(']', i + 1);
      if (end < 0) return null;
      const body = path.slice(i + 1, end);
      if (/^(?:0|[1-9][0-9]*)$/.test(body)) segments.push({ index: Number(body) });
      else {
        try {
          const name = JSON.parse(body);
          if (typeof name !== 'string') return null;
          segments.push({ name });
        }
        catch { return null; }
      }
      i = end + 1;
      continue;
    }
    return null;
  }
  return segments.length === 0 ? null : segments;
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
 * @param {Set<string>} joinTables
 * @returns {any}
 */
function deriveEntity(dialect, table, report) {
  const identity = dialect.identityColumn?.name;
  const primaryKey = new Set(table.primaryKey ?? []);
  const fkByColumn = new Map(table.foreignKeys.map((fk) => [fk.column, fk]));
  const uniqueColumns = new Set();
  const indexedColumns = new Set();
  for (const index of table.indexes) {
    if (index.partial || index.columns.some((column) => column === null)
      || index.columns.length !== 1) {
      report(loss('unmapped-index', `${table.name}.${index.name}`,
        'a partial, expression or composite entity index is not a property-level declaration'));
      continue;
    }
    (index.unique ? uniqueColumns : indexedColumns).add(index.columns[0]);
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
    const fk = fkByColumn.get(column.name);
    if (fk !== undefined) {
      // the FOREIGN KEY side. Which side declared it — and whether the
      // other holds many — is not in the shape: a `to`/`via` pair is
      // derivable, the inverse is not
      properties[column.name] = { 'x-entity': { relation: {
        to: fk.target,
        via: column.name,
        ...(ON_DELETE[fk.onDelete] === undefined ? {} : { onDelete: ON_DELETE[fk.onDelete] }),
      } } };
      report(loss('ambiguous-relation', `${table.name}.${column.name}`,
        `the foreign key points at '${fk.target}', which is one side of the edge; whether `
        + 'the other side holds many is not in the physical shape'));
      continue;
    }
    const type = dialect.schemaTypeOf(column.type);
    if (type === undefined) {
      report(loss('unmapped-type', `${table.name}.${column.name}`,
        `the column type '${column.type}' maps back to no schema type`));
    }
    const property = type === undefined ? {} : { type };
    const entity = {};
    if (primaryKey.has(column.name)) { entity.key = true; required.push(column.name); }
    if (uniqueColumns.has(column.name)) entity.unique = true;
    else if (indexedColumns.has(column.name)) entity.index = true;
    if (Object.keys(entity).length > 0) property['x-entity'] = entity;
    properties[column.name] = property;
  }
  for (const check of table.checks) {
    const property = properties[check.column];
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
  return { schema };
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

    const joinTables = new Set(schema.tables
      .filter((table) => looksLikeJoinTable(dialect, table))
      .map((table) => table.name));

    /** @type {any} */
    const model = { $model: MODEL_VERSION };
    const collections = {};
    const entities = {};
    for (const table of schema.tables) {
      if (joinTables.has(table.name)) continue;
      if (looksLikeCollection(dialect, table)) {
        collections[table.name] = deriveCollection(dialect, table, add, options?.keys, byName);
        for (const check of table.checks) add(loss('unmapped-constraint', `${table.name}.${check.name}`,
          'a CHECK over physical collection columns does not constrain the document schema'));
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
      entities[table.name] = deriveEntity(dialect, table, add);
    }

    // a join table's edge belongs to the two entities it joins, and it
    // is declared on ONE of them — the shape cannot say which, so it is
    // declared on the alphabetically first and reported
    for (const table of schema.tables) {
      if (!joinTables.has(table.name)) continue;
      const [left, right] = table.foreignKeys.map((fk) => fk.target).sort();
      if (left === undefined || right === undefined
        || entities[left] === undefined || entities[right] === undefined) {
        add(loss('unmapped-table', table.name,
          'the join table points at something this read did not derive as an entity'));
        continue;
      }
      const member = `${right.toLowerCase()}s`;
      entities[left].schema.properties[member] = {
        'x-entity': { relation: { to: right, many: true, through: table.name } },
      };
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
    return { model, report: Object.freeze(report.map((row) => Object.freeze(row))) };
  });
}
