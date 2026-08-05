//@ts-check
/**
 * @file DDL planning: a normalized collection becomes one physical
 * table — a key column, a JSON document column, a virtual generated
 * column per indexed path, and the declared indexes — with every byte
 * of SQL rendered by the dialect.
 *
 * Index paths are JSONPath expressions analyzed through the engine's
 * PUBLISHED AST (`analyzeQuery`): a path is indexable exactly when the
 * analysis says it is singular and every segment is a plain member or
 * index selection. That reuses the one grammar authority instead of
 * re-parsing, and it fails loudly (`JD0004`) on everything else —
 * wildcards, slices, filters, descendants, functions — rather than
 * silently indexing the wrong thing.
 */

import { analyzeQuery } from '@jarenjs/json/query';
import { DbCompileError } from './errors.js';
import { chain } from './driver.js';

/** The fixed physical column names of the 0.1 mapping. */
export const KEY_COLUMN = 'key';
export const DOC_COLUMN = 'doc';

/**
 * Analyze one index path expression down to typed segments.
 * @param {string} expression - A JSONPath expression (`$.email`)
 * @param {string} docPath - Model-document pointer for diagnostics
 * @returns {{ segments: import('./dialect.js').JsonPathSegment[],
 *   canonical: string }}
 */
export function compileIndexPath(expression, docPath) {
  let analysis;
  try {
    analysis = analyzeQuery(expression);
  }
  catch (cause) {
    throw new DbCompileError('JD0004',
      `the index path '${expression}' is not a valid query expression`,
      docPath, /** @type {Error} */ (cause));
  }
  const root = analysis.root;
  if (root.kind !== 'path' || root.name !== '$' || root.external === true) {
    throw new DbCompileError('JD0004',
      `the index path '${expression}' must address the stored document through '$'`,
      docPath);
  }
  if (root.singular !== true) {
    throw new DbCompileError('JD0004',
      `the index path '${expression}' is not singular — wildcards, slices, filters and descendants are not indexable`,
      docPath);
  }
  /** @type {import('./dialect.js').JsonPathSegment[]} */
  const segments = [];
  for (const segment of root.segments) {
    const selector = segment.selectors[0];
    if (segment.descendant === true || segment.selectors.length !== 1
      || (selector.kind !== 'name' && selector.kind !== 'index')) {
      throw new DbCompileError('JD0004',
        `the index path '${expression}' uses a selector that does not pick one member`,
        docPath);
    }
    segments.push(selector.kind === 'name'
      ? { name: selector.name }
      : { index: selector.index });
  }
  if (segments.length === 0) {
    throw new DbCompileError('JD0004',
      `the index path '${expression}' selects the whole document — index a member`,
      docPath);
  }
  const canonical = segments
    .map((s) => ('name' in s ? `.${s.name}` : `[${s.index}]`))
    .join('');
  return { segments, canonical };
}

/**
 * The declared schema type at a segment path, walked structurally
 * through `properties` / `items` / `prefixItems`. The collection's
 * schema is the type source — that is why the physical mapping needs
 * no engine-side inference.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {string | undefined}
 */
export function schemaTypeAt(schema, segments) {
  let node = schema;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = 'name' in segment
      ? node.properties?.[segment.name]
      : node.prefixItems?.[segment.index] ?? node.items;
  }
  if (node === null || typeof node !== 'object') return undefined;
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) {
    return node.type.find((t) => typeof t === 'string' && t !== 'null');
  }
  return undefined;
}

/**
 * A stable generated-column name for a canonical path: readable where
 * the path is tame, disambiguated by suffix where sanitizing collides.
 * @param {string} canonical
 * @param {Map<string, string>} byCanonical - canonical -> column name
 * @param {Set<string>} taken
 * @returns {string}
 */
function generatedColumnName(canonical, byCanonical, taken) {
  const existing = byCanonical.get(canonical);
  if (existing !== undefined) return existing;
  const base = `gx_${canonical.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  byCanonical.set(canonical, name);
  taken.add(name);
  return name;
}

/**
 * Plan one collection's physical shape: the DDL statements to create
 * it and the structural facts an existing table must match (the
 * `JD0002` comparison set).
 * @param {string} name - The collection name (also the table name)
 * @param {{ schema: any, keySegments: { name: string }[] | null,
 *   identity: string, indexes: { name: string, paths: string[],
 *   unique: boolean, docPath: string }[] }} collection - normalized
 * @param {any} dialect
 * @returns {{
 *   table: string, keyColumn: string, docColumn: string,
 *   keyType: string,
 *   generated: { name: string, type: string, pathText: string,
 *     canonical: string }[],
 *   columnByCanonical: Map<string, string>,
 *   createSql: string[],
 *   expected: { columns: { name: string, type: string,
 *     generated: boolean }[], indexes: { name: string, unique: boolean,
 *     columns: string[] }[] },
 * }}
 */
export function planCollection(name, collection, dialect) {
  const keyType = collection.identity === 'integer'
    ? dialect.typeFor('integer', 'key')
    : collection.identity === 'uuid'
      ? dialect.typeFor('string', 'key')
      : dialect.typeFor(
        schemaTypeAt(collection.schema, collection.keySegments ?? []), 'key');

  /** @type {Map<string, string>} */
  const columnByCanonical = new Map();
  /** @type {Set<string>} */
  const taken = new Set([KEY_COLUMN, DOC_COLUMN]);
  /** @type {{ name: string, type: string, pathText: string, canonical: string }[]} */
  const generated = [];
  /** @type {{ name: string, unique: boolean, columns: string[] }[]} */
  const indexes = [];

  for (const index of collection.indexes) {
    const columns = [];
    for (let i = 0; i < index.paths.length; i++) {
      const pathDocPath = `${index.docPath}/path`;
      const { segments, canonical } = compileIndexPath(index.paths[i], pathDocPath);
      const pathText = dialect.jsonPathText(segments);
      if (pathText === null) {
        throw new DbCompileError('JD0004',
          `the index path '${index.paths[i]}' names a member the dialect's JSON path grammar cannot carry`,
          pathDocPath);
      }
      const known = columnByCanonical.has(canonical);
      const columnName = generatedColumnName(canonical, columnByCanonical, taken);
      if (!known) {
        generated.push({
          name: columnName,
          type: dialect.typeFor(schemaTypeAt(collection.schema, segments), 'generated'),
          pathText,
          canonical,
        });
      }
      columns.push(columnName);
    }
    indexes.push({
      name: `${name}_${index.name}`,
      unique: index.unique,
      columns,
    });
  }

  const tableShape = {
    table: name,
    keyColumn: KEY_COLUMN,
    keyType,
    docColumn: DOC_COLUMN,
    generated,
  };
  const createSql = [
    dialect.ddl.createTable(tableShape),
    ...indexes.map((index) => dialect.ddl.createIndex({
      name: index.name,
      table: name,
      columns: index.columns,
      unique: index.unique,
    })),
  ];

  return {
    table: name,
    keyColumn: KEY_COLUMN,
    docColumn: DOC_COLUMN,
    keyType,
    generated,
    columnByCanonical,
    createSql,
    expected: {
      columns: [
        { name: KEY_COLUMN, type: keyType, generated: false },
        { name: DOC_COLUMN, type: dialect.docColumnType, generated: false },
        ...generated.map((g) => ({ name: g.name, type: g.type, generated: true })),
      ],
      indexes: indexes
        .map((index) => ({
          name: index.name,
          unique: index.unique,
          columns: [...index.columns].sort(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * Verify an existing table against the planned shape; any difference
 * is `JD0002` and nothing is altered. Shared by the store's open path
 * and the migration engine's shadow validation.
 * @param {any} connection
 * @param {any} plan
 * @param {string} collection
 * @param {string} docPath
 * @returns {any} value-or-promise
 */
export function verifyShape(connection, plan, collection, docPath) {
  const dialect = connection.dialect;
  const disagree = (difference) => {
    throw new DbCompileError('JD0002',
      `collection '${collection}': the existing table does not match the declared model (${difference}); reshaping a live database is the migration story, and nothing was altered`,
      docPath);
  };
  return chain(connection.prepare(dialect.introspect.columns(plan.table)), (columnsStatement) =>
    chain(columnsStatement.all([]), (columnRows) => {
      const actual = columnRows
        .map((row) => ({
          name: String(row.name),
          type: String(row.type).toUpperCase(),
          generated: Number(row.hidden) !== 0,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const expected = [...plan.expected.columns]
        .map((c) => ({ ...c, type: c.type.toUpperCase() }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      if (actual.length !== expected.length)
        disagree(`${actual.length} columns exist, the model declares ${expected.length}`);
      for (let i = 0; i < expected.length; i++) {
        const want = expected[i];
        const have = actual[i];
        if (want.name !== have.name || want.type !== have.type
          || want.generated !== have.generated) {
          disagree(`column '${have.name}' is ${have.type}${have.generated ? ' generated' : ''}, `
            + `the model declares '${want.name}' ${want.type}${want.generated ? ' generated' : ''}`);
        }
      }
      return chain(connection.prepare(dialect.introspect.indexes(plan.table)), (indexesStatement) =>
        chain(indexesStatement.all([]), (indexRows) => {
          const created = indexRows
            .filter((row) => String(row.origin) === 'c')
            .map((row) => ({ name: String(row.name), unique: Number(row.uniq) !== 0 }))
            .sort((a, b) => (a.name < b.name ? -1 : 1));
          const wantedIndexes = plan.expected.indexes;
          if (created.length !== wantedIndexes.length)
            disagree(`${created.length} declared indexes exist, the model declares ${wantedIndexes.length}`);
          const collectColumns = (i) => {
            if (i >= created.length) return null;
            const have = created[i];
            const want = wantedIndexes[i];
            if (have.name !== want.name || have.unique !== want.unique)
              disagree(`index '${have.name}'${have.unique ? ' (unique)' : ''} does not match the declared '${want.name}'`);
            return chain(connection.prepare(dialect.introspect.indexColumns(have.name)), (statement) =>
              chain(statement.all([]), (rows) => {
                const haveColumns = rows.map((row) => String(row.name)).sort();
                if (haveColumns.join(',') !== want.columns.join(','))
                  disagree(`index '${have.name}' covers (${haveColumns.join(', ')}), the model declares (${want.columns.join(', ')})`);
                return collectColumns(i + 1);
              }));
          };
          return collectColumns(0);
        }));
    }));
}


/**
 * Plan one ENTITY's physical shape from the mapping data
 * `explainMapping` derived: the relational table (typed columns,
 * checks, foreign keys, the JSONB document column), its indexes, and
 * the structural facts an existing table must match. One verify path
 * serves both document kinds.
 * @param {string} name
 * @param {any} entityMapping - `explainMapping(model).entities[name]`
 * @param {any} entities - the full `explainMapping` result (key types
 *   come from the referenced entity's columns)
 * @param {any} dialect
 * @returns {{ table: string, createSql: string[], expected: any,
 *   columnNames: Set<string> }}
 */
export function planEntity(name, entityMapping, entities, dialect) {
  const storageType = (storage) => dialect.typeFor(storage, 'generated');
  const keyType = (entityName) => {
    const target = entities.entities[entityName];
    const keyColumn = target.columns.find((column) => column.key);
    return storageType(keyColumn.storage);
  };
  const renderCheck = (columnName, values) => {
    const rendered = values.map((value) => (typeof value === 'string'
      ? dialect.stringLiteral(value)
      : typeof value === 'boolean' ? dialect.booleanLiteral(value) : String(value)));
    return `${dialect.quoteIdentifier(columnName)} IN (${rendered.join(', ')})`;
  };

  const singleKey = entityMapping.keys.length === 1;
  // a declared `via` property and its foreign key are ONE column: the
  // FK definition claims it, so the scalar list must not repeat it
  const fkNames = new Set(entityMapping.foreignKeys.map((fk) => fk.column));
  const columns = [];
  for (const column of entityMapping.columns) {
    if (fkNames.has(column.name)) continue;
    columns.push({
      name: column.name,
      type: storageType(column.storage),
      primaryKey: singleKey && column.key,
      notNull: column.key && !singleKey,
      check: column.check !== undefined ? renderCheck(column.name, column.check) : undefined,
    });
  }
  for (const fk of entityMapping.foreignKeys) {
    columns.push({
      name: fk.column,
      type: keyType(fk.references),
      references: { table: fk.references, column: fk.referencesKey, onDelete: fk.onDelete },
    });
  }
  columns.push({ name: DOC_COLUMN, type: dialect.docColumnType, notNull: true });

  const createSql = [dialect.ddl.createRelationalTable({
    table: name,
    columns,
    compositeKey: singleKey ? undefined : entityMapping.keys,
  })];
  const expectedIndexes = [];
  for (const index of entityMapping.indexes) {
    const indexName = `${name}_${index.property}`;
    createSql.push(dialect.ddl.createIndex({
      name: indexName, table: name, columns: [index.property], unique: index.unique,
    }));
    expectedIndexes.push({ name: indexName, unique: index.unique, columns: [index.property] });
  }
  for (const fk of entityMapping.foreignKeys) {
    // every foreign key gets an index: unique for a strict one-to-one,
    // plain otherwise — the correlated graph-load subqueries probe the
    // child's via column once per parent
    const indexName = `${name}_${fk.column}`;
    createSql.push(dialect.ddl.createIndex({
      name: indexName, table: name, columns: [fk.column], unique: fk.unique,
    }));
    expectedIndexes.push({ name: indexName, unique: fk.unique, columns: [fk.column] });
  }

  return {
    table: name,
    createSql,
    columnNames: new Set(columns.map((column) => column.name)),
    expectedForeignKeys: columns
      .filter((column) => column.references !== undefined)
      .map((column) => ({ column: column.name, references: column.references.table })),
    expected: {
      columns: columns
        .map((column) => ({ name: column.name, type: column.type, generated: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      indexes: expectedIndexes.sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * Plan a many-to-many join table.
 * @param {string} tableName
 * @param {any} join - `explainMapping(model).joinTables[tableName]`
 * @param {any} entities - the full mapping
 * @param {any} dialect
 * @returns {{ table: string, createSql: string[], expected: any }}
 */
export function planJoinTable(tableName, join, entities, dialect) {
  const keyType = (entityName) => {
    const target = entities.entities[entityName];
    const keyColumn = target.columns.find((column) => column.key);
    return dialect.typeFor(keyColumn.storage, 'generated');
  };
  const columns = [
    {
      name: join.left.column,
      type: keyType(join.left.entity),
      references: { table: join.left.entity, column: join.left.referencesKey, onDelete: 'cascade' },
    },
    {
      name: join.right.column,
      type: keyType(join.right.entity),
      references: { table: join.right.entity, column: join.right.referencesKey, onDelete: 'cascade' },
    },
  ];
  return {
    table: tableName,
    createSql: [dialect.ddl.createRelationalTable({
      table: tableName,
      columns,
      compositeKey: [join.left.column, join.right.column],
    })],
    expectedForeignKeys: columns.map((column) => ({
      column: column.name, references: column.references.table,
    })),
    expected: {
      columns: columns
        .map((column) => ({ name: column.name, type: column.type, generated: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      indexes: [],
    },
  };
}
