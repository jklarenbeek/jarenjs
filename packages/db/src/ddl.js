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

