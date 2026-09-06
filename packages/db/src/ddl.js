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
import { BBOX_COMPONENTS, BBOX_INDEX_ORDER, derivedMappingFor } from './derive.js';
import { expressionSql, expressionStem, expressionFunctions } from './expression.js';

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
  return { segments, canonical: canonicalOf(segments) };
}

/**
 * The canonical spelling of a member path — the key every generated
 * column and every promoted reference is matched by. INJECTIVE: a
 * member literally named `a.b` and the nested path `a` → `b` used to
 * spell the same `.a.b`, so an index over one silently served the
 * other and a filter on the flat member answered from the nested
 * value. Names are JSON-quoted, so no two paths share a spelling; the
 * generated column STEM strips the quotes and keeps its old form.
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {string}
 */
export function canonicalOf(segments) {
  return segments
    .map((s) => ('name' in s
      ? (IDENTIFIER.test(s.name) ? `.${s.name}` : `.${JSON.stringify(s.name)}`)
      : `[${s.index}]`))
    .join('');
}

/** A member name that spells itself: anything else is JSON-quoted in
 * the canonical, so `.a.b` (nested) and `."a.b"` (one member) differ. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The schema subschema at a segment path, walked structurally through
 * `properties` / `items` / `prefixItems`. The collection's schema is
 * the type source — that is why the physical mapping needs no
 * engine-side inference. `undefined` where the walk leaves the schema.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {any}
 */
export function schemaNodeAt(schema, segments) {
  let node = schema;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = 'name' in segment
      ? node.properties?.[segment.name]
      : node.prefixItems?.[segment.index] ?? node.items;
  }
  return node === null || typeof node !== 'object' ? undefined : node;
}

/**
 * The declared schema type at a segment path: the first non-`null`
 * member of a union, which is the type a COLUMN takes its storage
 * from. A caller that must know the whole union (a promotion refusing
 * a member that may also be `null`) reads {@link schemaNodeAt}.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {string | undefined}
 */
export function schemaTypeAt(schema, segments) {
  const node = schemaNodeAt(schema, segments);
  if (node === undefined) return undefined;
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) {
    return node.type.find((t) => typeof t === 'string' && t !== 'null');
  }
  return undefined;
}

/** The scalar schema types a derived index cannot be declared over. */
const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

/**
 * The comparison KIND a declared schema type implies — what a column
 * over that member holds, and therefore how its expression has to read
 * the member out of the document. On a dynamically typed engine the
 * kind changes nothing; on one whose columns carry a real SQL type it
 * is the difference between a `text` column and a type error.
 * @param {string | undefined} schemaType
 * @returns {'text' | 'number' | 'boolean' | undefined}
 */
export function columnKindFor(schemaType) {
  switch (schemaType) {
    case 'string': return 'text';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return undefined;
  }
}

/**
 * The shape row for the identity column a dialect adds to every table
 * it creates, or none. It is an ORDINARY column as far as the catalog
 * is concerned — the engine fills it, but nothing generates it from
 * another column — so the drift check sees it exactly as it sees the
 * key and the document.
 * @param {any} dialect
 * @returns {{ name: string, type: string, generated: boolean }[]}
 */
function identityColumnExpected(dialect) {
  return dialect.identityColumn === undefined
    ? []
    : [{ name: dialect.identityColumn.name, type: dialect.identityColumn.type, generated: false }];
}

/**
 * Whether a schema node types its value as `array` and nothing else —
 * `type: 'array'` or `type: ['array']`. A vector column over a member
 * the schema also lets be a string (or does not type at all) is a
 * column that lies: some documents would carry a member the column
 * silently ignores.
 * @param {any} node
 * @returns {boolean}
 */
function typedArrayOnly(node) {
  if (node === undefined) return false;
  if (node.type === 'array') return true;
  return Array.isArray(node.type) && node.type.length === 1 && node.type[0] === 'array';
}

/**
 * A stable generated-column name for a canonical path: readable where
 * the path is tame, disambiguated by suffix where sanitizing collides.
 *
 * A DERIVED index names its columns from the same stem plus what makes
 * the derivation distinct — the kind, and the geohash precision, since
 * two precisions over one path are legitimately two column sets (a
 * coarse bucketing index and a fine proximity one); a vector width
 * likewise. A bbox derivation owns FOUR columns under one stem, so
 * every one of them is claimed before the stem is accepted.
 * @param {string} canonical
 * @param {Map<string, string>} byKey - identity -> column name (or stem)
 * @param {Set<string>} taken
 * @param {{ key?: string, suffix?: string, parts?: readonly string[] }} [options]
 * @returns {string}
 */
function generatedColumnName(canonical, byKey, taken, options = undefined) {
  const key = options?.key ?? canonical;
  const existing = byKey.get(key);
  if (existing !== undefined) return existing;
  const stem = `gx_${canonical.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  const base = options?.suffix === undefined ? stem : `${stem}_${options.suffix}`;
  const parts = options?.parts ?? [''];
  const claims = (/** @type {string} */ candidate) =>
    parts.map((part) => (part === '' ? candidate : `${candidate}_${part}`));
  let name = base;
  for (let i = 2; claims(name).some((claimed) => taken.has(claimed)); i++)
    name = `${base}_${i}`;
  byKey.set(key, name);
  for (const claimed of claims(name)) taken.add(claimed);
  return name;
}

/**
 * The one column a `derive: 'vector'` index contributes: the packed,
 * l2-normalized member as `dialect.packedVectorType`, STORED on every
 * driver (`derivedMappingFor`), with no B-tree over it — nothing seeks
 * a blob of floats; a fetch-and-rank plan reads the whole column — so
 * the index declaration names a column, not an index, and contributes
 * nothing to `expected.indexes`. `dims` is part of the identity for
 * the reason `precision` is: a different width is a different column.
 * @param {any} index - the normalized index declaration
 * @param {any} context
 * @returns {null} — no index covers the column
 */
function vectorColumn(index, context) {
  const {
    collection, dialect, segments, canonical, pathText, columnByCanonical, taken,
    generated, derived,
  } = context;
  const node = schemaNodeAt(collection.schema, segments);
  if (!typedArrayOnly(node)) {
    const typed = node?.type === undefined ? 'not typed' : `typed ${JSON.stringify(node.type)}`;
    throw new DbCompileError('JD0004',
      `index '${index.name}': the path '${index.paths[0]}' is ${typed} by the schema, and a `
      + "vector column needs a member the schema types 'array' and nothing else — a column over "
      + 'a member that may also be a string, an object or null is a column that lies about '
      + 'some documents (declare items: { type: \'number\' } and minItems/maxItems equal to '
      + 'dims beside it)',
      `${index.docPath}/derive`);
  }
  if (typeof dialect.packedVectorType !== 'string') {
    throw new TypeError(
      `ddl: the '${dialect.name}' dialect declares no packedVectorType, so it cannot hold a vector column`);
  }
  const key = `${canonical}|vector|${index.dims}`;
  const name = generatedColumnName(canonical, columnByCanonical, taken,
    { key, suffix: `v${index.dims}` });
  if (!generated.some((column) => column.name === name)) {
    generated.push({
      name,
      type: dialect.packedVectorType,
      pathText,
      canonical,
      derive: 'vector',
      dims: index.dims,
      stored: true,
      expression: null,
    });
    derived.push({ name, derive: 'vector', dims: index.dims, segments });
  }
  return null;
}

/**
 * The columns one derived index contributes, appended to the plan's
 * `generated` (the physical column list) and `derived` (what the write
 * path and the migration backfill need to recompute a value).
 *
 * `derive` changes what is COMPUTED from the member, never how the
 * member is selected — so the schema is still the type source, and a
 * derivation over a path the schema types as a scalar is refused here
 * rather than at the first query that returns nothing.
 * @param {any} index - the normalized index declaration
 * @param {any} context
 * @returns {string[] | null} the column names the index covers, in
 *   order — or `null` when no B-tree covers them (an R\*Tree, or a
 *   vector column)
 */
function deriveColumns(index, context) {
  const {
    collection, table, dialect, mapping, segments, canonical, pathText,
    columnByCanonical, taken, generated, derived, rtreeCapable, virtualTables,
    physicalByKey,
  } = context;
  // the per-kind override: a vector column is stored on every driver
  const stored = derivedMappingFor(index.derive, mapping) === 'stored';
  const declaredType = schemaTypeAt(collection.schema, segments);
  if (declaredType !== undefined && SCALAR_TYPES.has(declaredType)) {
    throw new DbCompileError('JD0004',
      `index '${index.name}': the path '${index.paths[0]}' is typed '${declaredType}' by the schema, and a `
      + `${index.derive} index derives from ${index.derive === 'vector'
        ? 'an array of numbers' : 'a position or a geometry — an array or an object'}`,
      `${index.docPath}/derive`);
  }
  if (index.derive === 'vector') return vectorColumn(index, context);
  const isGeohash = index.derive === 'geohash';
  // the identity that decides column SHARING: two indexes over the same
  // path with the same derivation and the same precision are one column
  // set; two precisions over one path are two, and legitimately so
  const key = `${canonical}|${index.derive}|${index.precision ?? ''}`;
  // `physical` is a property of the COLUMN SET, not of the index: rule 5
  // lets two indexes share one set, and one set has one shape on disk.
  // Two indexes asking for two shapes is a model that cannot be built,
  // and saying so beats silently honouring whichever came first.
  const wanted = isGeohash ? 'columns' : (index.physical ?? 'columns');
  const agreed = physicalByKey.get(key);
  if (agreed !== undefined && agreed !== wanted) {
    throw new DbCompileError('JD0004',
      `the index path '${index.paths[0]}' already has a ${index.derive} column set declared `
      + `physical: '${agreed}', and this index declares '${wanted}' — two indexes over one `
      + 'path share one column set, and a column set has one shape on disk',
      `${index.docPath}/physical`);
  }
  physicalByKey.set(key, wanted);
  const stem = generatedColumnName(canonical, columnByCanonical, taken, {
    key,
    suffix: isGeohash ? `gh${index.precision}` : 'bbox',
    parts: isGeohash ? undefined : BBOX_COMPONENTS,
  });
  const type = dialect.typeFor(isGeohash ? 'string' : 'number', 'generated');
  const components = isGeohash ? [undefined] : BBOX_COMPONENTS;
  const nameOf = (/** @type {string | undefined} */ component) =>
    (component === undefined ? stem : `${stem}_${component}`);
  if (!generated.some((column) => column.name === nameOf(components[0]))) {
    for (const component of components) {
      const column = {
        name: nameOf(component),
        type,
        pathText,
        canonical,
        derive: index.derive,
        precision: index.precision,
        component,
        stored,
      };
      generated.push({
        ...column,
        expression: stored ? null : dialect.derivedColumn(
          dialect.quoteIdentifier(DOC_COLUMN), pathText, column),
      });
      derived.push({
        name: column.name,
        derive: index.derive,
        precision: index.precision,
        component,
        segments,
      });
    }
  }
  if (wanted === 'rtree' && rtreeCapable) {
    // the R*Tree mapping: the four columns stay (the triggers read them,
    // and they are the box's one definition) and the B-tree over them
    // does NOT get built — that is where part of the write cost is
    // repaid, and it is what makes the two shapes differ in `expected`.
    // One virtual table per COLUMN SET, never per index (rule 5).
    if (!virtualTables.some((virtual) => virtual.stem === stem)) {
      const name = `${table}_${stem}_rtree`;
      // (w, e, s, n) — the order the virtual table's
      // (minx, maxx, miny, maxy) carry, and the order the index covers
      const edges = BBOX_INDEX_ORDER.map((component) => ({ name: nameOf(component) }));
      const triggers = dialect.ddl.createSyncTriggers(
        { table, virtualTable: name, prefix: name, edges });
      virtualTables.push({
        stem,
        name,
        columns: [...dialect.rtree.columns].slice(1),
        edges: edges.map((edge) => edge.name),
        createSql: dialect.ddl.createVirtualTable({ name }),
        fillSql: dialect.ddl.fillVirtualTable({ table, virtualTable: name, edges }),
        triggers,
      });
    }
    return null;
  }
  // the index COVERS its columns in (w, e, s, n) order, which is not
  // their declaration order — see BBOX_INDEX_ORDER
  return isGeohash ? [stem] : BBOX_INDEX_ORDER.map((component) => nameOf(component));
}

/**
 * Plan one collection's physical shape: the DDL statements to create
 * it and the structural facts an existing table must match (the
 * `JD0002` comparison set).
 * A derived index (`derive: 'geohash' | 'bbox'`) maps to the same
 * shape through a registered deterministic function, EXCEPT where the
 * driver cannot index one (`capabilities.deterministicIndexableFunctions`
 * is false): there the columns are ordinary ones the store writes. The
 * two mappings produce different declared text on purpose — a database
 * built under one and opened under the other really does disagree, and
 * `verifyShape` says so rather than papering over it. A
 * `derive: 'vector'` column is the stored shape under BOTH mappings
 * (`derivedMappingFor`), so for it the two agree.
 * @param {string} name - The collection name (also the table name)
 * @param {{ schema: any, keySegments: { name: string }[] | null,
 *   identity: string, indexes: { name: string, paths: string[],
 *   unique: boolean, derive?: string | null, precision?: number,
 *   dims?: number, docPath: string }[] }} collection - normalized
 * @param {any} dialect
 * @param {{ derived?: 'virtual' | 'stored', rtree?: boolean }} [options]
 *   - `derived` is the physical mapping for derived columns:
 *   `'virtual'` (a generated column over a registered function) unless
 *   the driver says it cannot index one. `rtree` is whether the driver
 *   carries the R\*Tree module; when it does not, a column set that
 *   declared `physical: 'rtree'` falls back to the B-tree over its
 *   columns and `explain().prefilters[].via` reports which shape ran
 *   (MODEL-FORMAT §4) — a report, not a silent degradation
 * @returns {{
 *   table: string, keyColumn: string, docColumn: string,
 *   keyType: string,
 *   generated: { name: string, type: string, pathText: string,
 *     canonical: string }[],
 *   derived: { name: string, derive: string, precision?: number,
 *     component?: string, dims?: number, segments: any[] }[],
 *   columnByCanonical: Map<string, string>,
 *   createSql: string[],
 *   virtualTables: { stem: string, name: string, columns: string[],
 *     edges: string[], createSql: string, fillSql: string,
 *     triggers: { name: string, sql: string }[] }[],
 *   expected: { columns: { name: string, type: string,
 *     generated: boolean }[], indexes: { name: string, unique: boolean,
 *     columns: string[] }[] },
 * }}
 */
export function planCollection(name, collection, dialect, options = undefined) {
  /** @type {'virtual' | 'stored'} */
  const mapping = options?.derived === 'stored' ? 'stored' : 'virtual';
  const rtreeCapable = options?.rtree !== false;
  const keyType = collection.identity === 'integer'
    // a DATABASE-allocated key: on an engine whose auto-allocation is a
    // column property rather than a consequence of the integer type,
    // that property IS the declared type
    ? (dialect.autoKeyType ?? dialect.typeFor('integer', 'key'))
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
  /** @type {any[]} */
  const derived = [];
  /** @type {{ name: string, unique: boolean, columns: string[] }[]} */
  const indexes = [];
  /** @type {any[]} */
  const virtualTables = [];
  /** @type {Map<string, string>} */
  const physicalByKey = new Map();
  /** @type {{ column: string, canonical: string, functions: string[] }[]} */
  const expressions = [];

  for (const index of collection.indexes) {
    // an EXPRESSION index: one column over the declared computation,
    // shared by every index that declares the same canonical expression
    if (index.expression !== undefined) {
      const known = columnByCanonical.has(index.canonical);
      const columnName = generatedColumnName(expressionStem(index.expression),
        columnByCanonical, taken, { key: index.canonical, suffix: 'x' });
      if (!known) {
        const sql = expressionSql(index.expression, dialect, {
          docColumnSql: dialect.quoteIdentifier(DOC_COLUMN),
          declarations: options?.expressions ?? {},
          registered: options?.registered !== false,
          docPath: `${index.docPath}/expression`,
          segmentsOf: (member) =>
            compileIndexPath(member, `${index.docPath}/expression`).segments,
        });
        generated.push({
          name: columnName,
          // an expression's value is TEXT: one declared function, one
          // spelling of its answer, on every engine that computes it
          type: dialect.typeFor('string', 'generated'),
          kind: 'text',
          pathText: null,
          expression: sql,
          canonical: index.canonical,
        });
        expressions.push({ column: columnName, canonical: index.canonical,
          functions: expressionFunctions(index.expression) });
      }
      indexes.push({
        name: `${name}_${index.name}`,
        unique: index.unique,
        columns: [columnName],
      });
      continue;
    }
    const columns = [];
    let noBtree = false;
    for (let i = 0; i < index.paths.length; i++) {
      const pathDocPath = `${index.docPath}/path`;
      const { segments, canonical } = compileIndexPath(index.paths[i], pathDocPath);
      const pathText = dialect.jsonPathText(segments);
      if (pathText === null) {
        throw new DbCompileError('JD0004',
          `the index path '${index.paths[i]}' names a member the dialect's JSON path grammar cannot carry`,
          pathDocPath);
      }
      if (index.derive) {
        const contributed = deriveColumns(index, {
          collection, table: name, dialect, mapping, segments, canonical, pathText,
          columnByCanonical, taken, generated, derived, rtreeCapable, virtualTables,
          physicalByKey,
        });
        if (contributed === null) noBtree = true;
        else columns.push(...contributed);
        continue;
      }
      const known = columnByCanonical.has(canonical);
      const columnName = generatedColumnName(canonical, columnByCanonical, taken);
      if (!known) {
        const schemaType = schemaTypeAt(collection.schema, segments);
        generated.push({
          name: columnName,
          type: dialect.typeFor(schemaType, 'generated'),
          kind: columnKindFor(schemaType),
          pathText,
          canonical,
        });
      }
      columns.push(columnName);
    }
    // a column set realized as an R*Tree has no B-tree over it: the
    // virtual table IS the index, and the four columns stay only as the
    // box's one definition (the triggers read them). A vector column
    // has none either: it is fetched whole and ranked, never sought
    if (noBtree) continue;
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
    ...virtualTables.flatMap((virtual) =>
      [virtual.createSql, ...virtual.triggers.map((trigger) => trigger.sql)]),
  ];
  // the virtual table and its triggers are named from the column stem,
  // and an index is named from the model's own index name — two
  // namespaces that meet in `sqlite_schema`. A collision would have one
  // object silently standing in for another, so it is refused here
  const objectNames = [name, ...indexes.map((index) => index.name),
    ...virtualTables.flatMap((virtual) =>
      [virtual.name, ...virtual.triggers.map((trigger) => trigger.name)])];
  const seen = new Set();
  for (const objectName of objectNames) {
    if (seen.has(objectName)) {
      throw new DbCompileError('JD0004',
        `collection '${name}' would declare two schema objects named '${objectName}'`,
        collection.docPath ?? `/collections/${name}`);
    }
    seen.add(objectName);
  }

  return {
    table: name,
    keyColumn: KEY_COLUMN,
    docColumn: DOC_COLUMN,
    keyType,
    generated,
    derived,
    /** The declared-expression columns, with the functions each calls:
     * what a store registers before it can so much as SELECT from the
     * table it created. */
    expressions,
    columnByCanonical,
    virtualTables,
    createSql,
    expected: {
      columns: [
        { name: KEY_COLUMN, type: keyType, generated: false },
        { name: DOC_COLUMN, type: dialect.docColumnType, generated: false },
        ...identityColumnExpected(dialect),
        // a STORED derived column is an ordinary one: the flag is what
        // `pragma_table_xinfo` reports, and it is the difference a file
        // moved between the two physical mappings shows up as
        ...generated.map((g) => ({ name: g.name, type: g.type, generated: g.stored !== true })),
      ],
      indexes: indexes
        // the COLUMNS keep their declared order — an index is ordered, and
        // comparing sorted term lists made `(a,b)` and `(b,a)` equal. Only
        // the index list itself is sorted, to compare by name.
        .map((index) => ({
          name: index.name,
          unique: index.unique,
          columns: [...index.columns],
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * Normalize a stored `CREATE` statement for comparison: collapse runs of
 * whitespace, drop whitespace around punctuation, and strip the
 * `IF NOT EXISTS` SQLite does not keep. What survives is every token that
 * carries meaning, so two statements compare equal exactly when they
 * declare the same physical object.
 * @param {string} sql
 * @returns {string}
 */
export function normalizeDeclaredSql(sql) {
  return String(sql)
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/\bIF NOT EXISTS\s+/i, '')
    .trim();
}

/**
 * Split a comma-separated list at TOP-LEVEL commas only, so a
 * `CHECK(x IN (1,2))` or a multi-column constraint stays one item.
 * @param {string} body
 * @returns {string[]}
 */
function splitTopLevel(body) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote !== '') {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * A comparable form of one `CREATE` statement.
 *
 * For a TABLE the column definitions compare as a SET, because
 * `ALTER TABLE … ADD COLUMN` can only append — so a migrated table and a
 * freshly built one legitimately differ in column order, and this store
 * never reads a column positionally. Everything else is exact: each
 * column's full definition (type, `PRIMARY KEY`, `NOT NULL`, `DEFAULT`,
 * `CHECK`, `GENERATED … AS`, `REFERENCES … ON DELETE …`), the table
 * constraints, and the trailing table options (`STRICT`,
 * `WITHOUT ROWID`).
 *
 * For an INDEX the text compares whole, because an index IS its order —
 * `(a,b)` and `(b,a)` serve different lookups — as are its partial
 * predicate and each term's collation and direction.
 * @param {string} sql
 * @returns {string}
 */
export function comparableDeclaredSql(sql) {
  const normalized = normalizeDeclaredSql(sql);
  const open = normalized.indexOf('(');
  const close = normalized.lastIndexOf(')');
  if (!/^CREATE\s+TABLE\b/i.test(normalized) || open < 0 || close < open)
    return normalized;
  const head = normalized.slice(0, open);
  const options = normalized.slice(close + 1).trim();
  const items = splitTopLevel(normalized.slice(open + 1, close));
  // a column definition opens with the quoted column name; anything else
  // (PRIMARY KEY(...), UNIQUE(...), CHECK(...), FOREIGN KEY(...)) is a
  // table constraint, and those are unordered too
  const columns = items.filter((item) => item.startsWith('"')).sort();
  const constraints = items.filter((item) => !item.startsWith('"')).sort();
  return `${head}(${[...columns, ...constraints].join(',')})${options}`;
}

/**
 * The declared-SQL half of verification: compare every schema object the
 * table owns against the statements the plan would have created.
 *
 * The structural pragma comparison above reads column names, types and
 * index membership — real facts, and nowhere near all of them. A table
 * can lose its PRIMARY KEY, its NOT NULL, its STRICT, a CHECK, a default
 * or a generated column's expression; a foreign key can change
 * `ON DELETE SET NULL` to `ON DELETE CASCADE`; a composite index can
 * reverse its terms, gain a partial predicate, or change an index term's
 * collation — and every one of those leaves names and types untouched.
 * They all live in the CREATE text, so this compares that, and a drifted
 * database is refused instead of opened.
 * @param {any} connection
 * @param {any} plan
 * @param {(difference: string) => never} disagree
 * @returns {any} value-or-promise
 */
function verifyDeclaredSql(connection, plan, disagree) {
  const dialect = connection.dialect;
  // An engine that does not keep each object's CREATE text has nothing
  // to compare: the structural check above (columns, their types and
  // generatedness, the indexes and their covered columns in order, and
  // for an entity its foreign-key tuples) is the whole of the drift
  // check there, and `capabilities.declaredSqlText` is what says so
  // rather than a silent pass.
  if (dialect.capabilities.declaredSqlText !== true) return null;
  const planned = new Map();
  // an R*Tree virtual table is NOT owned by the collection table —
  // `declaredSql` is scoped to `tbl_name`, and a virtual table's is
  // itself — so it is checked by its own look below rather than
  // reported as an object the database is missing. Its three triggers
  // ARE the collection's, so drift in both directions falls out of this
  // comparison for free.
  const owned = new Set(plan.virtualTables?.map((virtual) => virtual.name) ?? []);
  for (const sql of plan.createSql) {
    const comparable = comparableDeclaredSql(sql);
    // the object's name is the first quoted identifier in the statement
    const name = /"((?:[^"]|"")*)"/.exec(comparable)?.[1]?.replace(/""/g, '"');
    if (name === undefined || owned.has(name)) continue;
    planned.set(name, comparable);
  }
  /** The virtual tables, each by its own name. */
  const verifyVirtual = (i) => {
    const list = plan.virtualTables ?? [];
    if (i >= list.length) return null;
    const virtual = list[i];
    return chain(connection.prepare(dialect.introspect.declaredSql(virtual.name)),
      (statement) => chain(statement.all([]), (rows) => {
        const row = rows.find((candidate) => String(candidate.name) === virtual.name);
        if (row === undefined) {
          disagree(`the model declares the virtual table '${virtual.name}', `
            + 'which the database does not have');
        }
        const have = comparableDeclaredSql(row.sql);
        const wanted = comparableDeclaredSql(virtual.createSql);
        if (have !== wanted) {
          disagree(`'${virtual.name}' is declared as\n  ${have}\nand the model declares\n  ${wanted}`);
        }
        return verifyVirtual(i + 1);
      }));
  };
  return chain(connection.prepare(dialect.introspect.declaredSql(plan.table)),
    (statement) => chain(statement.all([]), (rows) => {
      /** @type {Map<string, string>} */
      const actual = new Map();
      for (const row of rows) actual.set(String(row.name), comparableDeclaredSql(row.sql));
      for (const [name, wanted] of planned) {
        const have = actual.get(name);
        if (have === undefined)
          disagree(`the model declares '${name}', which the database does not have`);
        if (have !== wanted) {
          disagree(`'${name}' is declared as\n  ${have}\nand the model declares\n  ${wanted}`);
        }
      }
      for (const name of actual.keys()) {
        if (!planned.has(name)) {
          disagree(`the database has '${name}', which the model does not declare — `
            + 'an undeclared index or trigger changes deletion semantics and query plans');
        }
      }
      return verifyVirtual(0);
    }));
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
      // both sides through the dialect's own reduction, so a declared
      // type the catalog reports differently (an auto-key's allocation
      // clause, a width the engine normalizes) compares as itself
      const comparableType = dialect.comparableColumnType;
      const actual = columnRows
        .map((row) => ({
          name: String(row.name),
          type: comparableType(String(row.type)),
          generated: Number(row.hidden) !== 0,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const expected = [...plan.expected.columns]
        .map((c) => ({ ...c, type: comparableType(c.type) }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      if (actual.length !== expected.length) {
        // name what is missing or extra: a count alone sends the reader
        // to a pragma to learn which column a foreign tool dropped
        const actualNames = new Set(actual.map((column) => column.name));
        const expectedNames = new Set(expected.map((column) => column.name));
        const missing = expected.filter((column) => !actualNames.has(column.name));
        const extra = actual.filter((column) => !expectedNames.has(column.name));
        disagree(`${actual.length} columns exist, the model declares ${expected.length}`
          + (missing.length > 0 ? `; missing: ${missing.map((c) => `'${c.name}'`).join(', ')}` : '')
          + (extra.length > 0 ? `; undeclared: ${extra.map((c) => `'${c.name}'`).join(', ')}` : ''));
      }
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
          if (created.length !== wantedIndexes.length) {
            // the COUNT is the fact, but the NAMES are what a reader
            // needs: a file moved between two physical mappings differs
            // by exactly one index, and saying which one is the whole
            // diagnosis
            const have = new Set(created.map((index) => index.name));
            const want = new Set(wantedIndexes.map((index) => index.name));
            const missing = [...want].filter((index) => !have.has(index));
            const extra = [...have].filter((index) => !want.has(index));
            disagree(`${created.length} declared indexes exist, the model declares `
              + `${wantedIndexes.length}`
              + (missing.length > 0
                ? ` — the model declares ${missing.join(', ')}, which the database does not have`
                : '')
              + (extra.length > 0
                ? ` — the database has ${extra.join(', ')}, which the model does not declare`
                : ''));
          }
          const collectColumns = (i) => {
            if (i >= created.length) return null;
            const have = created[i];
            const want = wantedIndexes[i];
            if (have.name !== want.name || have.unique !== want.unique)
              disagree(`index '${have.name}'${have.unique ? ' (unique)' : ''} does not match the declared '${want.name}'`);
            return chain(connection.prepare(dialect.introspect.indexColumns(have.name)), (statement) =>
              chain(statement.all([]), (rows) => {
                // NOT sorted: `(a,b)` and `(b,a)` are different indexes —
                // one serves an `a`-prefix lookup and the other does not,
                // and sorting made them compare equal
                const haveColumns = rows.map((row) => String(row.name));
                if (haveColumns.join(',') !== want.columns.join(','))
                  disagree(`index '${have.name}' covers (${haveColumns.join(', ')}) in that order, the model declares (${want.columns.join(', ')})`);
                return collectColumns(i + 1);
              }));
          };
          return chain(collectColumns(0), () =>
            verifyDeclaredSql(connection, plan, disagree));
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
      .map((column) => ({
        column: column.name,
        references: column.references.table,
        // the ACTION, not just the edge: SET NULL and CASCADE are both
        // "a foreign key exists" and mean opposite things for the row
        onDelete: column.references.onDelete ?? null,
        onUpdate: column.references.onUpdate ?? null,
        targetColumn: column.references.column ?? null,
      })),
    expected: {
      columns: [...columns
        .map((column) => ({ name: column.name, type: column.type, generated: false })),
      ...identityColumnExpected(dialect)]
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
      column: column.name,
      references: column.references.table,
      onDelete: column.references.onDelete ?? null,
      onUpdate: column.references.onUpdate ?? null,
      targetColumn: column.references.column ?? null,
    })),
    expected: {
      columns: [...columns
        .map((column) => ({ name: column.name, type: column.type, generated: false })),
      ...identityColumnExpected(dialect)]
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      indexes: [],
    },
  };
}
