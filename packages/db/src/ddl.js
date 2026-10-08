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

import { explainMapping } from './model.js';
import { analyzeQuery } from '@jarenjs/json/query';
import { DbCompileError } from './errors.js';
import { chain } from './driver.js';
import { BBOX_COMPONENTS, BBOX_INDEX_ORDER, derivedMappingFor } from './derive.js';
import { expressionSql, expressionStem, expressionFunctions } from './expression.js';
import { foldIdentifier } from './invariants.js';
import { verifyRulePrograms } from './physical.js';
import { rowPaths, rowPredicate, storedBoolean } from './dialects/row-predicate.js';
import { planTable } from './dialects/sqlite-schema.js';
import { comparableDeclaredSql } from './schema-sql.js';
export { normalizeDeclaredSql, comparableDeclaredSql } from './schema-sql.js';

const MANAGED_SQL_OPTIONS = Object.freeze({ columnOrder: /** @type {const} */ ('ignore') });

/** The fixed physical column names of the 0.1 mapping. */
export const KEY_COLUMN = 'key';
export const DOC_COLUMN = 'doc';

const UTF8 = new TextEncoder();

/**
 * Refuse (`JD0004`) a name the plan gives a table, a column or an index that
 * the engine cannot hold, at the model member it comes from — before any SQL
 * names it. The dialect owns the bound (`maxIdentifierBytes`: PostgreSQL
 * keeps 63 bytes and truncates a longer name silently, and its dialect would
 * refuse one only as SQL is rendered, with a TypeError that names no member
 * of the model); SQLite holds a name of any length.
 * @param {any} dialect
 * @param {string} name - the planned name
 * @param {string} what - what takes the name, for the reason
 * @param {string} docPath - the model member the name comes from
 */
function refuseLongName(dialect, name, what, docPath) {
  const limit = dialect.maxIdentifierBytes;
  if (!Number.isFinite(limit)) return;
  const bytes = UTF8.encode(name).length;
  if (bytes > limit) {
    throw new DbCompileError('JD0004',
      `${what} would be named '${name}', ${bytes} bytes; the ${dialect.name} engine keeps ${limit} bytes `
      + 'of an identifier and truncates a longer one silently, so two names that share a prefix would be one — '
      + 'shorten the name', docPath);
  }
}

/**
 * The relations an engine creates for a table unasked (`dialect.ownRelationNames`:
 * PostgreSQL's primary-key index `<table>_pkey` and a serial column's sequence
 * `<table>_<column>_seq`, the identity column's included), as schema objects of
 * the plan's namespace. A foreign key or a check constraint is no relation: its
 * name (`<table>_<column>_fkey`, `<table>_<column>_check`) takes none from an
 * index. The names are the engine's as it gives them unclipped — a clipped one
 * needs a table name within a few bytes of the identifier bound.
 * @param {any} dialect
 * @param {string} table
 * @param {{ name: string, type: string }[]} columns - the columns the plan creates the table with
 * @param {string} docPath - the declaration that creates the table
 * @returns {{ name: string, what: string, docPath: string }[]}
 */
function ownObjects(dialect, table, columns, docPath) {
  // once each: a key column that shares the identity column's name names one sequence twice
  return [...new Set(dialect.ownRelationNames(table, dialect.identityColumn === undefined ? columns : [...columns, dialect.identityColumn]))]
    .map((/** @type {string} */ name) => ({ name, docPath,
      what: `the ${dialect.name} engine's own relation '${name}' of table '${table}' (its primary key's index, or a serial column's sequence)` }));
}

/**
 * Refuse (`JD0004`) the second of two schema objects a plan gives one name.
 * Every table, index, virtual table and trigger a model plans, and the
 * relations an engine creates for a table unasked (`ownObjects`), share ONE
 * namespace, compared with ASCII case folded on both engines, as SQLite
 * compares names. Met at open instead, the
 * second object's `CREATE … IF NOT EXISTS` is skipped: an index goes
 * unenforced, or an entity and a collection share one table. Each planner
 * checks its own table's objects; the store checks a model's together.
 * @param {Iterable<{ name: string, what: string, docPath: string, rename?: string }>} objects - in plan order
 * @returns {void}
 */
export function refuseNameCollisions(objects) {
  /** @type {Map<string, { name: string, what: string }>} */
  const seen = new Map();
  for (const object of objects) {
    const key = foldIdentifier(object.name);
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, object); continue; }
    throw new DbCompileError('JD0004',
      `${object.what} would be named '${object.name}', the name of ${first.what}`
      + (first.name === object.name ? '' : ` ('${first.name}': names are compared with ASCII case folded, as SQLite compares them)`)
      + ` — two objects of one database cannot share a name: rename ${object.rename ?? 'one of them'}`, object.docPath);
  }
}

/** How deep a condition may nest: deeper, it is refused where it is planned. */
const CONDITION_DEPTH = 64;

/** How deep a JSON value nests, counted without recursion. @param {any} value @returns {number} */
function depthOf(value) {
  let deepest = 0;
  for (const stack = [[value, 0]]; stack.length > 0;) {
    const [node, depth] = /** @type {[any, number]} */ (stack.pop());
    deepest = Math.max(deepest, depth);
    if (node !== null && typeof node === 'object') for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return deepest;
}

/**
 * An index condition as SQL: the row-predicate lowering's predicate rendering
 * in the dialect's flavor, over the columns the condition may read, each SQL
 * NULL of which is an absent member. Refused like anything else the lowering
 * refuses (`JD0004` at the condition): a condition that is always true or
 * always false as written (it declares nothing an index holds, and PostgreSQL
 * drops a true one), one nested deeper than the open can read back, and one
 * an engine that keeps no CREATE text could not read back exactly from its
 * catalog — the open would otherwise meet it as drift. Introspection renders a
 * condition it read back through this same function before it derives one.
 * @param {any} where - the declared condition
 * @param {{ name: string, physical: string, codec: string }[]} columns - the members it may read
 * @param {any} dialect
 * @param {string} docPath - the condition's pointer
 * @param {(member: string) => string} unreadable - why a member that is none of `columns` cannot be read
 * @param {Set<string>} [reads] - collects the physical columns the condition reads
 * @returns {string}
 */
export function indexCondition(where, columns, dialect, docPath, unreadable, reads = undefined) {
  /** @param {string} reason @returns {never} */
  const fail = (reason) => { throw new DbCompileError('JD0004', `the index condition cannot be lowered: ${reason}`, docPath); };
  const flavor = dialect.rowPredicateFlavor;
  if (flavor === undefined) return fail(`the ${dialect.name} dialect renders no index condition`);
  if (dialect.capabilities.declaredSqlText !== true && dialect.readBack === undefined)
    return fail(`the ${dialect.name} dialect keeps no CREATE text and reads no condition back, so no open could verify it`);
  if (depthOf(where) > CONDITION_DEPTH) return fail(`it nests deeper than ${CONDITION_DEPTH} levels`);
  const paths = rowPaths(columns.map((column) => ({ ...column, null: 'absent' })), dialect.quoteIdentifier);
  /** @param {string} path */
  const resolve = (path) => {
    const read = paths(path);
    if (read.column !== undefined) reads?.add(read.column.physical);
    return read.refused !== undefined || read.column !== undefined ? read : { ...read, refused: unreadable(String(read.name)) };
  };
  const sql = rowPredicate({ rendering: 'predicate', flavor, dialect, resolve, fail }).predicate(where);
  if (sql === flavor.true || sql === flavor.false)
    fail(`it is always ${sql === flavor.true ? 'true' : 'false'} as written, so it declares no condition`);
  if (dialect.readBack !== undefined && !dialect.readBack.conditionReads(sql, columns))
    fail(`the ${dialect.name} engine keeps no CREATE text, and its stored form of ${sql} could not be read back exactly`);
  return sql;
}

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
 *   objects: { name: string, what: string, docPath: string }[],
 *   conditionColumns: { name: string, physical: string, codec: string }[],
 *   expected: { columns: { name: string, type: string,
 *     generated: boolean }[], indexes: { name: string, unique: boolean,
 *     columns: string[], where?: string, reads?: string[] }[] },
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
  /** Where each index's own generated columns start in `generated`. @type {number[]} */
  const firstColumn = [];

  for (const index of collection.indexes) {
    firstColumn.push(generated.length);
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
        declared: index,
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
      declared: index,
    });
  }
  firstColumn.push(generated.length);
  // an index condition reads a top-level member the collection already maps
  // to a generated column of a scalar type that excludes null: both a JSON
  // null and a missing member extract to SQL NULL, which the query engine
  // tells apart, and a member no index reads has no column at all
  const collectionPath = collection.docPath ?? `/collections/${name}`;
  const conditionColumns = [];
  for (const column of generated) {
    const member = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(column.pathText === null ? '' : column.canonical)?.[1];
    const codec = member === undefined || column.derive !== undefined ? undefined : conditionCodec(schemaNodeAt(collection.schema, [{ name: member }]));
    if (codec !== undefined) conditionColumns.push({ name: /** @type {string} */ (member), physical: column.name, codec });
  }
  /** @param {string} member */
  const unreadable = (member) => (columnByCanonical.has(canonicalOf([{ name: member }]))
    ? `'${member}' may hold null or has no one scalar type, and its generated column holds SQL NULL for a null and for a missing member alike, which the query engine tells apart`
    : `'${member}' has no generated column: an index condition reads a member the collection indexes by its path — index '$.${member}' first`);
  for (const index of indexes) {
    if (index.declared.where === undefined) continue;
    /** @type {Set<string>} */
    const reads = new Set();
    index.where = indexCondition(index.declared.where, conditionColumns, dialect, `${index.declared.docPath}/where`, unreadable, reads);
    index.reads = [...reads];
  }
  // every name the table, its columns and its indexes take, at the member
  // each one comes from (see `refuseLongName`)
  refuseLongName(dialect, name, `the table for collection '${name}'`, collection.docPath ?? `/collections/${name}`);
  collection.indexes.forEach((index, i) => {
    for (const column of generated.slice(firstColumn[i], firstColumn[i + 1])) {
      const columnPath = `${index.docPath}/${index.expression === undefined ? 'path' : 'expression'}`;
      refuseLongName(dialect, column.name, `the column for '${index.expression === undefined ? `$${column.canonical}` : index.name}'`, columnPath);
      // an engine that keeps no CREATE text must read the column back exactly at every open
      const planned = dialect.readBack === undefined ? undefined : plannedExpression(dialect, { generated }, column.name);
      if (planned !== undefined && !dialect.readBack.expressionReads(planned)) {
        throw new DbCompileError('JD0004', `the column for '${index.name}' computes ${planned}, which the ${dialect.name} `
          + 'engine keeps no CREATE text of and which could not be read back exactly from its catalog', columnPath);
      }
    }
    if (indexes.some((planned) => planned.name === `${name}_${index.name}`))
      refuseLongName(dialect, `${name}_${index.name}`, `index '${index.name}'`, `${index.docPath}/name`);
  });

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
      ...(index.where === undefined ? {} : { where: index.where }),
    })),
    ...virtualTables.flatMap((virtual) =>
      [virtual.createSql, ...virtual.triggers.map((trigger) => trigger.sql)]),
  ];
  // the table, the relations the engine gives it, its indexes, and the
  // virtual tables and triggers named from a column stem: one namespace
  const objects = [
    { name, what: `the table for collection '${name}'`, docPath: collectionPath, rename: 'the collection' },
    ...ownObjects(dialect, name, [{ name: KEY_COLUMN, type: keyType }, { name: DOC_COLUMN, type: dialect.docColumnType }, ...generated], collectionPath),
    ...indexes.map((index) => ({ name: index.name, what: `index '${index.declared.name}'`, docPath: `${index.declared.docPath}/name`, rename: 'the index' })),
    ...virtualTables.flatMap((virtual) => [virtual, ...virtual.triggers].map((object) => ({ name: object.name,
      what: `the schema object '${object.name}' of a derived index`, docPath: collectionPath }))),
  ];
  refuseNameCollisions(objects);

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
    objects,
    /** The members an index condition may read, by their generated columns. */
    conditionColumns,
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
          // the columns a condition reads, for a migration that changes one of them
          ...(index.where === undefined ? {} : { where: index.where, reads: index.reads }),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * The codec an index condition reads a generated column with: its member's
 * one scalar schema type, which must exclude `null`; none otherwise.
 * @param {any} node - the member's schema
 * @returns {string | undefined}
 */
function conditionCodec(node) {
  const types = node === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
  if (types.length !== 1 || (Array.isArray(node.enum) && node.enum.includes(null))) return undefined;
  return SCALAR_CODECS.get(types[0]);
}

/** The codec a column of each scalar schema type holds. @type {ReadonlyMap<string, string>} */
export const SCALAR_CODECS = new Map([['string', 'text'], ['integer', 'integer'], ['number', 'number'], ['boolean', 'boolean']]);

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
    const comparable = comparableDeclaredSql(sql, MANAGED_SQL_OPTIONS);
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
        const have = comparableDeclaredSql(row.sql, MANAGED_SQL_OPTIONS);
        const wanted = comparableDeclaredSql(virtual.createSql, MANAGED_SQL_OPTIONS);
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
      for (const row of rows) actual.set(String(row.name), comparableDeclaredSql(row.sql, MANAGED_SQL_OPTIONS));
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
 * @param {string} collection - the table's collection or entity
 * @param {string} docPath
 * @param {'collection' | 'entity'} [kind] - what `collection` names, for the refusal
 * @returns {any} value-or-promise
 */
export function verifyShape(connection, plan, collection, docPath, kind = 'collection') {
  const dialect = connection.dialect;
  const disagree = (difference) => {
    throw new DbCompileError('JD0002',
      `${kind} '${collection}': the existing table does not match the declared model (${difference}); reshaping a live database is the migration story, and nothing was altered`,
      docPath);
  };
  // an engine that keeps no CREATE text has its catalog read back what that
  // text would carry — each index's condition and shape, each generated
  // column's expression — through the dialect's exact read-back
  const readBack = dialect.capabilities.declaredSqlText === true ? undefined : dialect.readBack;
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
          computes: row.default_value === null || row.default_value === undefined ? null : String(row.default_value),
          conforming: row.conforming === undefined || row.conforming === null || String(row.conforming) === 'on',
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const expected = [...plan.expected.columns]
        .map((c) => ({ ...c, type: comparableType(c.type),
          ...(c.legacyType === undefined ? {} : { legacyType: comparableType(c.legacyType) }) }))
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
        // a column an earlier release declared otherwise (`legacyType`, a key
        // it left to the caller) is still the declared shape of that table
        if (want.name !== have.name || (want.type !== have.type && want.legacyType !== have.type)
          || want.generated !== have.generated) {
          disagree(`column '${have.name}' is ${have.type}${have.generated ? ' generated' : ''}, `
            + `the model declares '${want.name}' ${want.type}${want.generated ? ' generated' : ''}`);
        }
        // a catalog that reports no expression for a generated column has none to read back
        const planned = readBack !== undefined && have.generated && have.computes !== null
          ? plannedExpression(dialect, plan, have.name) : undefined;
        const difference = planned === undefined ? null
          : readBack.expression(/** @type {string} */ (have.computes), planned, have.conforming);
        if (difference !== null) disagree(`column '${have.name}' ${difference}`);
      }
      return chain(connection.prepare(dialect.introspect.indexes(plan.table)), (indexesStatement) =>
        chain(indexesStatement.all([]), (indexRows) => {
          const created = indexRows
            .filter((row) => String(row.origin) === 'c')
            .map((row) => ({ name: String(row.name), unique: Number(row.uniq) !== 0,
              predicate: row.predicate === null || row.predicate === undefined ? null : String(row.predicate),
              plain: row.plain === undefined || row.plain === null || Number(row.plain) === 1,
              conforming: row.conforming === undefined || row.conforming === null || String(row.conforming) === 'on' }))
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
                // the catalog's shape flag: no NULLS NOT DISTINCT, no key order,
                // collation or operator class of its own, no INCLUDE column (it reads
                // as a key column here and keys nothing), not deferred — each changes
                // what a unique index refuses
                if (!have.plain) disagree(`index '${have.name}' is not the plain ascending B-tree the model declares (NULLS NOT DISTINCT, a key order, collation or operator class of its own, an INCLUDE column, or a deferred check)`);
                const difference = readBack !== undefined
                  ? readBack.condition(have.predicate, want.where, plan.conditionColumns ?? [], have.conforming)
                  : have.predicate === null ? null : `has the condition ${have.predicate}, which the model does not declare`;
                if (difference !== null) disagree(`index '${have.name}' ${difference}`);
                return collectColumns(i + 1);
              }));
          };
          // the table's rule programs: from the catalog where the engine keeps
          // no CREATE text, every other trigger or rewrite rule on the table
          // undeclared drift; a CREATE text comparison covers them below
          return chain(collectColumns(0), () =>
            chain(verifyRulePrograms(connection, plan.table, plan.programs ?? [], disagree,
              { installed: dialect.capabilities.declaredSqlText !== true, undeclared: true }), () =>
              verifyDeclaredSql(connection, plan, disagree)));
        }));
    }));
}

/**
 * The expression a planned generated column is created with — a declared
 * expression, or the dialect's read of the member it indexes — or `undefined`
 * for a column the store writes (a stored or derived one: a derived column
 * computes a function the host names, read by no expression form).
 * @param {any} dialect @param {any} plan @param {string} name - the column
 * @returns {string | undefined}
 */
function plannedExpression(dialect, plan, name) {
  const column = (plan.generated ?? []).find((/** @type {any} */ candidate) => candidate.name === name);
  if (column === undefined || column.stored === true || column.derive !== undefined) return undefined;
  return column.expression ?? dialect.jsonExtract(dialect.quoteIdentifier(DOC_COLUMN), column.pathText, column.kind);
}

/**
 * How a column holding an entity's key is declared — the key column itself
 * or one that references it: the key's storage type, unless the database
 * allocates the key (`default: 'auto'`) on an engine whose allocation is a
 * column property (`dialect.autoKeyType`, PostgreSQL's `bigserial`). Then
 * the key column declares that allocation, and a referencing column the
 * type it amounts to in the catalog, so the foreign key stays
 * implementable. `legacyType` is the other declaration a database this
 * model opens can hold for the column, which `verifyShape` accepts too: for
 * an allocated key, the storage type an earlier release declared with no
 * allocation; for a single integer key the caller supplies, the allocation
 * a database created while the key was still `auto` keeps — explicit keys
 * are written into it just the same.
 * @param {any} keyColumn - the key column's mapping
 * @param {any} dialect
 * @param {boolean} referencing
 * @param {boolean} [single] - whether it is the entity's only key column
 *   (a composite key is never allocated)
 * @returns {{ type: string, legacyType?: string }}
 */
function keyColumnType(keyColumn, dialect, referencing, single = true) {
  const stored = dialect.typeFor(keyColumn.storage, 'generated');
  if (dialect.autoKeyType === undefined || (keyColumn.auto !== true && (!single || keyColumn.storage !== 'integer')))
    return { type: stored };
  const allocated = referencing ? dialect.comparableColumnType(dialect.autoKeyType).toLowerCase() : dialect.autoKeyType;
  return keyColumn.auto === true ? { type: allocated, legacyType: stored } : { type: stored, legacyType: allocated };
}

/**
 * The foreign keys an existing table must carry, from the planned columns:
 * the ACTION, not just the edge — SET NULL and CASCADE are both "a foreign
 * key exists" and mean opposite things for the row.
 * @param {any[]} columns
 */
const expectedForeignKeysOf = (columns) => columns
  .filter((column) => column.references !== undefined)
  .map((column) => ({
    column: column.name,
    references: column.references.table,
    onDelete: column.references.onDelete ?? null,
    onUpdate: column.references.onUpdate ?? null,
    targetColumn: column.references.column ?? null,
  }));

/**
 * The columns an existing table must hold, sorted by name, each with the
 * type an earlier release declared where it differs (see `keyColumnType`).
 * @param {any[]} columns @param {Map<string, string>} legacyTypes @param {any} dialect
 */
const expectedColumnsOf = (columns, legacyTypes, dialect) => [...columns
  .map((column) => ({ name: column.name, type: column.type, generated: false,
    ...(legacyTypes.has(column.name) ? { legacyType: legacyTypes.get(column.name) } : {}) })),
...identityColumnExpected(dialect)]
  .sort((a, b) => (a.name < b.name ? -1 : 1));

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
 *   columnNames: Set<string>, objects?: { name: string, what: string, docPath: string }[],
 *   programs?: any[], conditionColumns?: { name: string, physical: string, codec: string }[] }}
 */
export function planEntity(name, entityMapping, entities, dialect) {
  if (entityMapping.document === false) {
    if (!dialect.invariantTriggers && entityMapping.invariants.some((rule) => rule.enforcement === 'database'))
      throw new DbCompileError('JD0005', 'this dialect cannot verify declared database invariant triggers');
    const declared = entityMapping.ddl && dialect.name === 'sqlite' ? planTable(entityMapping.ddl) : null;
    return { table: entityMapping.table,
      physical: { ...entityMapping, triggers: dialect.invariantTriggers?.(entityMapping, entities, dialect) ?? [] },
      createSql: declared?.createSql ?? [], expected: declared?.expected ?? { columns: [], indexes: [] },
      columnNames: new Set(entityMapping.columns.map((c) => c.physical)) };
  }
  // every name the table, its columns and its indexes take, at the member
  // each one comes from, before any SQL names one (see `refuseLongName`)
  const entityPath = `/entities/${name}`;
  const memberPath = (/** @type {string} */ column) => (entityMapping.columns.some((/** @type {any} */ c) => c.name === column)
    ? `${entityPath}/schema/properties/${column}` : entityPath);
  const viaColumns = entityMapping.foreignKeys.map((/** @type {any} */ fk) => fk.column);
  refuseLongName(dialect, name, `the table for entity '${name}'`, entityPath);
  for (const column of [...entityMapping.columns.map((/** @type {any} */ c) => c.name), ...viaColumns])
    refuseLongName(dialect, column, `the column for '${column}'`, memberPath(column));
  for (const column of [...entityMapping.indexes.map((/** @type {any} */ index) => index.property), ...viaColumns])
    refuseLongName(dialect, `${name}_${column}`, `the index over '${column}'`, memberPath(column));
  const storageType = (storage) => dialect.typeFor(storage, 'generated');
  /** @type {Map<string, string>} */
  const legacyTypes = new Map();
  const singleKey = entityMapping.keys.length === 1;
  /** The declared type of a column holding a key (see `keyColumnType`). */
  const keyHolding = (/** @type {string} */ columnName, /** @type {any} */ keyColumn, /** @type {boolean} */ referencing) => {
    const { type, legacyType } = keyColumnType(keyColumn, dialect, referencing, referencing || singleKey);
    if (legacyType !== undefined) legacyTypes.set(columnName, legacyType);
    return type;
  };
  const renderCheck = (columnName, values) => {
    const rendered = values.map((value) => (typeof value === 'string'
      ? dialect.stringLiteral(value)
      : typeof value === 'boolean' ? storedBoolean(value) : String(value)));
    return `${dialect.quoteIdentifier(columnName)} IN (${rendered.join(', ')})`;
  };

  // a declared `via` property and its foreign key are ONE column: the
  // FK definition claims it, so the scalar list must not repeat it
  const fkNames = new Set(entityMapping.foreignKeys.map((fk) => fk.column));
  const columns = [];
  for (const column of entityMapping.columns) {
    if (fkNames.has(column.name)) continue;
    columns.push({
      name: column.name,
      type: column.key ? keyHolding(column.name, column, false) : storageType(column.storage),
      primaryKey: singleKey && column.key,
      notNull: column.key && !singleKey,
      check: column.check !== undefined ? renderCheck(column.name, column.check) : undefined,
    });
  }
  for (const fk of entityMapping.foreignKeys) {
    columns.push({
      name: fk.column,
      type: keyHolding(fk.column, entities.entities[fk.references].columns.find((/** @type {any} */ column) => column.key), true),
      references: { table: fk.references, column: fk.referencesKey, onDelete: fk.onDelete },
    });
  }
  columns.push({ name: DOC_COLUMN, type: dialect.docColumnType, notNull: true });

  const createSql = [dialect.ddl.createRelationalTable({
    table: name,
    columns,
    compositeKey: singleKey ? undefined : entityMapping.keys,
  })];
  // one index per column, keyed by its name: a declared `index`/`unique`
  // on a foreign-key column and the key's own index are ONE index —
  // planned twice, the second CREATE INDEX failed and a reopen counted
  // two declared indexes against one physical. Unique when either asks
  /** @type {Map<string, boolean>} */
  const indexUnique = new Map();
  for (const index of entityMapping.indexes)
    indexUnique.set(index.property, index.unique);
  for (const fk of entityMapping.foreignKeys) {
    // every foreign key gets an index: unique for a strict one-to-one,
    // plain otherwise — the correlated graph-load subqueries probe the
    // child's via column once per parent
    indexUnique.set(fk.column, (indexUnique.get(fk.column) ?? false) || fk.unique);
  }
  const expectedIndexes = [];
  // the table, the relations the engine gives it, and every index: one namespace
  const objects = [{ name, what: `the table for entity '${name}'`, docPath: entityPath, rename: 'the entity' },
    ...ownObjects(dialect, name, columns, entityPath)];
  for (const [column, unique] of indexUnique) {
    const indexName = `${name}_${column}`;
    objects.push({ name: indexName, what: `the index over '${column}'`, docPath: memberPath(column), rename: `the member '${column}'` });
    createSql.push(dialect.ddl.createIndex({
      name: indexName, table: name, columns: [column], unique,
    }));
    expectedIndexes.push({ name: indexName, unique, columns: [column] });
  }
  // the entity-level indexes: composite, unique or partial, over the columns
  // the table maps; a condition reads them as their columns hold them
  const conditionColumns = conditionColumnsOf(entityMapping, entities);
  /** @param {string} member */
  const unreadable = (member) => {
    const column = entityMapping.columns.find((/** @type {any} */ c) => c.name === member);
    if (column?.source === 'epoch(document)' || fkNames.has(member))
      return `'${member}' holds an epoch (milliseconds) in its column, while a condition compares the member's text — an index condition reads no epoch member`;
    if (entityMapping.document.includes(member))
      return `'${member}' lives in the entity's document: an index condition reads column-mapped members — map it as a column (a top-level scalar property)`;
    return `'${member}' has no column on entity '${name}': an index condition reads column-mapped members`;
  };
  (entityMapping.entityIndexes ?? []).forEach((/** @type {any} */ index, /** @type {number} */ i) => {
    const indexPath = `${entityPath}/indexes/${i}`;
    const indexName = `${name}_${index.name}`;
    refuseLongName(dialect, indexName, `index '${index.name}'`, `${indexPath}/name`);
    const where = index.where === undefined ? undefined : indexCondition(index.where, conditionColumns, dialect, `${indexPath}/where`, unreadable);
    const declared = { name: indexName, unique: index.unique, columns: [...index.columns], ...(where === undefined ? {} : { where }) };
    objects.push({ name: indexName, what: `index '${index.name}'`, docPath: `${indexPath}/name`, rename: 'the index' });
    createSql.push(dialect.ddl.createIndex({ ...declared, table: name }));
    expectedIndexes.push(declared);
  });
  // the database rules' programs, created with the table and verified with it
  const programs = (entityMapping.invariants ?? []).some((/** @type {any} */ rule) => rule.enforcement === 'database')
    ? rulePrograms(name, entityMapping, entities, dialect, columns, conditionColumns) : [];
  for (const program of programs) createSql.push(program.sql);
  for (const program of new Set(programs.map((/** @type {any} */ item) => item.name)))
    objects.push({ name: program, what: `the rule program '${program}'`, docPath: `${entityPath}/invariants`, rename: 'the entity' });
  refuseNameCollisions(objects);

  return {
    table: name,
    createSql,
    columnNames: new Set(columns.map((column) => column.name)),
    expectedForeignKeys: expectedForeignKeysOf(columns),
    objects,
    /** The programs of the entity's database rules, in install order (their SQL ends `createSql`). */
    programs,
    /** The members an index condition may read, by their columns. */
    conditionColumns,
    expected: {
      columns: expectedColumnsOf(columns, legacyTypes, dialect),
      indexes: expectedIndexes.sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
}

/**
 * The columns of an entity table an index condition may read, each with the
 * codec of what it holds: a mapped scalar and a foreign key's column, never an
 * epoch (milliseconds, where the condition would compare the member's text).
 * @param {any} entityMapping @param {any} entities - the full mapping
 * @returns {{ name: string, physical: string, codec: string }[]}
 */
function conditionColumnsOf(entityMapping, entities) {
  // a foreign key's column holds the referenced key as that key is stored
  /** @type {Map<string, any>} */
  const referenced = new Map(entityMapping.foreignKeys.map((/** @type {any} */ fk) => [fk.column,
    entities.entities[fk.references].columns.find((/** @type {any} */ column) => column.key)]));
  /** @type {{ name: string, physical: string, codec: string }[]} */
  const columns = [];
  for (const column of [...entityMapping.columns.filter((/** @type {any} */ c) => !referenced.has(c.name)),
    ...[...referenced].map(([name, key]) => ({ name, storage: key.storage, source: key.source }))]) {
    if (column.source === 'epoch(document)') continue;
    columns.push({ name: column.name, physical: column.name, codec: /** @type {string} */ (SCALAR_CODECS.get(column.storage)) });
  }
  return columns;
}

/**
 * The programs of a store-owned entity's database rules: the dialect's
 * lowering over the columns an index condition may read (a scalar member's,
 * a foreign key's; never an epoch's), each with the type the table declares
 * it with (`stored`), so a rule reads it as the table holds it. A key column
 * holds no SQL NULL; any other's SQL NULL is a missing member. A rule's change
 * test counts the document column beside them.
 * @param {string} name @param {any} entityMapping @param {any} entities - the full mapping @param {any} dialect
 * @param {{ name: string, type: string }[]} declared - the table's planned columns
 * @param {{ name: string, physical: string, codec: string }[]} readable - the columns a rule may read
 * @returns {any[]}
 */
function rulePrograms(name, entityMapping, entities, dialect, declared, readable) {
  if (typeof dialect.invariantTriggers !== 'function')
    throw new DbCompileError('JD0005', 'this dialect cannot verify declared database invariant triggers');
  const typeOf = new Map(declared.map((column) => [column.name, column.type]));
  const columns = readable.map((column) => ({ ...column, null: entityMapping.keys.includes(column.name) ? 'reject' : 'absent',
    generated: false, stored: typeOf.get(column.physical) }));
  const documentColumn = { name: DOC_COLUMN, physical: DOC_COLUMN, codec: 'json', null: 'reject', generated: false, stored: dialect.docColumnType };
  return dialect.invariantTriggers({ table: name, keys: entityMapping.keys, columns, documentColumn, document: false,
    version: entityMapping.version, invariants: entityMapping.invariants }, entities, dialect);
}

/**
 * Plan a many-to-many join table.
 * @param {string} tableName
 * @param {any} join - `explainMapping(model).joinTables[tableName]`
 * @param {any} entities - the full mapping
 * @param {any} dialect
 * @returns {{ table: string, createSql: string[], expected: any,
 *   objects: { name: string, what: string, docPath: string }[] }}
 */
export function planJoinTable(tableName, join, entities, dialect) {
  // the join table and its columns are named from the two entities
  // (see `refuseLongName`)
  refuseLongName(dialect, tableName, `the join table of '${join.left.entity}' and '${join.right.entity}'`, `/entities/${join.left.entity}`);
  for (const side of [join.left, join.right])
    refuseLongName(dialect, side.column, `the join column for '${side.entity}'`, `/entities/${side.entity}`);
  /** @type {Map<string, string>} */
  const legacyTypes = new Map();
  /** The endpoint column referencing `side`'s key (see `keyColumnType`). @param {any} side */
  const endpoint = (side) => {
    const { type, legacyType } = keyColumnType(
      entities.entities[side.entity].columns.find((/** @type {any} */ column) => column.key), dialect, true);
    if (legacyType !== undefined) legacyTypes.set(side.column, legacyType);
    return {
      name: side.column,
      type,
      references: { table: side.entity, column: side.referencesKey, onDelete: 'cascade' },
    };
  };
  const columns = [endpoint(join.left), endpoint(join.right)];
  const docPath = `/entities/${join.left.entity}`;
  const objects = [{ name: tableName, what: `the join table of '${join.left.entity}' and '${join.right.entity}'`, docPath,
    rename: 'the join table' }, ...ownObjects(dialect, tableName, columns, docPath)];
  refuseNameCollisions(objects);
  return {
    table: tableName,
    createSql: [dialect.ddl.createRelationalTable({
      table: tableName,
      columns,
      compositeKey: [join.left.column, join.right.column],
    })],
    objects,
    expectedForeignKeys: expectedForeignKeysOf(columns),
    expected: {
      columns: expectedColumnsOf(columns, legacyTypes, dialect),
      indexes: [],
    },
  };
}

/** Plan explicit database-enforced persistence rules; never applies them. A
 * store-owned entity's programs are the ones its table is created and
 * verified with. A name too long for PostgreSQL becomes a short hash of its
 * table, so two tables can meet in one name: the plan refuses that rather
 * than install one table's program over the other's.
 * @param {any} model @param {{ dialect: any }} options @returns {any[]} */
export function planInvariants(model, options) {
  const mapping = explainMapping(model);
  const dialect = options.dialect;
  if (typeof dialect.invariantTriggers !== 'function') throw new DbCompileError('JD0005', 'this dialect cannot lower database invariants');
  const items = Object.entries(mapping.entities).flatMap(([name, entity]) => (entity.document === false
    ? dialect.invariantTriggers(entity, mapping, dialect) : planEntity(name, entity, mapping, dialect).programs ?? []));
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const item of items) {
    const name = `${item.type} ${item.name}`;
    const owner = owners.get(name);
    if (owner !== undefined) throw new DbCompileError('JD0005', owner === item.owner
      ? `database invariant: two entities map table '${owner}' and both declare database rules; declare them on one`
      : `database invariant: tables '${owner}' and '${item.owner}' name one ${item.type} '${item.name}'; rename one table`);
    owners.set(name, item.owner);
  }
  return items;
}
