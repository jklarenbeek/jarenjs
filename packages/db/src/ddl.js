//@ts-check
/**
 * @file DDL planning: a normalized collection becomes one physical
 * table — a key column, a JSON document column, a virtual generated
 * column per indexed path, and the declared indexes — with every byte
 * of SQL rendered by the dialect.
 *
 * Index paths are JSONPath expressions analyzed through the engine's
 * PUBLISHED AST (`analyzeQuery`, read once for every model path by
 * `readModelPath`): a path is indexable exactly when the analysis says
 * it is singular and every segment is a plain member or index
 * selection. That reuses the one grammar authority instead of
 * re-parsing, and it fails loudly (`JD0004`) on everything else —
 * wildcards, slices, filters, descendants, functions — rather than
 * silently indexing the wrong thing.
 */

import { explainMapping } from './model.js';
import { hashContent, utf8ByteLength } from '@jarenjs/core/string';
import { IDENTIFIER, ENGINE_TABLES } from './engine-metadata.js';
import { DbCompileError } from './errors.js';
import { chain } from './driver.js';
import { BBOX_COMPONENTS, BBOX_INDEX_ORDER, derivedMappingFor } from './derive.js';
import { expressionSql, expressionStem, expressionFunctions, normalizeExpression } from './expression.js';
import { foldIdentifier } from './invariants.js';
import { SCALAR_TYPES, columnKindFor } from './scalar-types.js';
import { verifyRulePrograms } from './physical.js';
import { rowPaths, rowPredicate, storedBoolean } from './dialects/row-predicate.js';
import { planTable } from './dialects/sqlite-schema.js';
import { readIntervalCheck, readsConforming } from './dialects/check-read.js';
import { comparableDeclaredSql } from './schema-sql.js';
import { memberNames, modelPath, readModelPath, readsAsIndex } from './model-path.js';
export { normalizeDeclaredSql, comparableDeclaredSql } from './schema-sql.js';

const MANAGED_SQL_OPTIONS = Object.freeze({ columnOrder: /** @type {const} */ ('ignore') });

/** The fixed physical column names of the 0.1 mapping. */
export const KEY_COLUMN = 'key';
export const DOC_COLUMN = 'doc';

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
  const bytes = utf8ByteLength(name);
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

/** The engine's own tables (migration history, change ledger, job queue, owner lease): names no object of a model may take. */
const RESERVED = [...ENGINE_TABLES].map((name) => /** @type {[string, { name: string, what: string, reserved: true }]} */ (
  [foldIdentifier(name), { name, what: `the engine's own table '${name}'`, reserved: true }]));

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
  /** @type {Map<string, { name: string, what: string, reserved?: true }>} */
  const seen = new Map(RESERVED);
  for (const object of objects) {
    const key = foldIdentifier(object.name);
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, object); continue; }
    throw new DbCompileError('JD0004',
      `${object.what} would be named '${object.name}', the name of ${first.what}`
      + (first.name === object.name ? '' : ` ('${first.name}': names are compared with ASCII case folded, as SQLite compares them)`)
      + ` — two objects of one database cannot share a name: rename ${object.rename ?? (first.reserved ? 'it' : 'one of them')}`, object.docPath);
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
  const read = readModelPath(expression);
  if ('segments' in read) return { segments: read.segments, canonical: canonicalOf(read.segments) };
  const reasons = {
    invalid: 'is not a valid query expression',
    root: "must address the stored document through '$'",
    singular: 'is not singular — wildcards, slices, filters and descendants are not indexable',
    selector: 'uses a selector that does not pick one member',
    whole: 'selects the whole document — index a member',
  };
  throw new DbCompileError('JD0004', `the index path '${expression}' ${reasons[read.refused]}`, docPath, read.cause);
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

/**
 * The one top-level member a canonical spelling names ({@link canonicalOf}),
 * or `undefined` for a nested path or an element.
 * @param {string} canonical
 * @returns {string | undefined}
 */
function topMemberOf(canonical) {
  const name = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(canonical)?.[1];
  if (name !== undefined || !canonical.startsWith('."')) return name;
  try {
    const quoted = JSON.parse(canonical.slice(1));
    return typeof quoted === 'string' && canonicalOf([{ name: quoted }]) === canonical ? quoted : undefined;
  }
  catch { return undefined; }
}

/**
 * The subschema of one array element. A negative index counts from the end,
 * so against a tuple (`prefixItems`) it lands on a prefix item in a short
 * array and on an item past the prefix in a long one: no schema places it.
 * @param {any} node
 * @param {number} index
 * @returns {any}
 */
function elementAt(node, index) {
  if (index < 0) return Array.isArray(node.prefixItems) ? undefined : node.items;
  return node.prefixItems?.[index] ?? node.items;
}

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
    node = 'name' in segment ? node.properties?.[segment.name] : elementAt(node, segment.index);
  }
  return node === null || typeof node !== 'object' ? undefined : node;
}

/**
 * Whether a step of a path meets a container the schema does not declare
 * as the kind the step means, where a path engine may read the step off
 * the other kind: an index off the key of that number in an object, a
 * member name that reads as an index ({@link readsAsIndex}) off an array's
 * element. A declared `type` that excludes the other kind pins the
 * container. A container with no `type` is not pinned — `properties`
 * binds objects alone and `items` arrays alone, so a value of the other
 * kind conforms — and neither is a path that leaves the schema.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {boolean}
 */
export function unpinnedStep(schema, segments) {
  return segments.some((segment, at) => {
    const index = 'index' in segment;
    if (!index && !readsAsIndex(segment.name)) return false;
    const declared = schemaNodeAt(schema, segments.slice(0, at))?.type;
    const kinds = typeof declared === 'string' ? [declared] : declared;
    return !Array.isArray(kinds) || kinds.includes(index ? 'object' : 'array');
  });
}

/**
 * The segments of a path whose definition must read its member under the
 * dialect's guard, where the dialect guards one of its steps, or
 * `undefined`: the schema leaves a container of such a step open
 * ({@link unpinnedStep}), or the catalog would read a member name of it
 * back as an index ({@link nameReadsBackAsIndex}); under the guard the name
 * reads back as the name it was declared as, whatever container the schema
 * declares. A path whose containers the schema declares and that has no
 * such name reads unguarded, which is every byte an earlier release wrote
 * for it.
 * @param {any} schema
 * @param {any} dialect
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {import('./dialect.js').JsonPathSegment[] | undefined}
 */
function guardedPath(schema, dialect, segments) {
  return (unpinnedStep(schema, segments) || nameReadsBackAsIndex(dialect, segments))
    && dialect.queryGuard(dialect.quoteIdentifier(DOC_COLUMN), segments) !== null ? segments : undefined;
}

/**
 * Whether the dialect's catalog reads a path's unguarded definition back
 * with one of its member names as an array index: PostgreSQL's path text
 * spells the name `'0'` as it spells the index `0` (`#> '{s,0}'`), and its
 * read-back takes such an element for the index ({@link memberPathOf} of
 * the dialect); SQLite spells the two apart.
 * @param {any} dialect
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @returns {boolean}
 */
function nameReadsBackAsIndex(dialect, segments) {
  const text = dialect.jsonPathText(segments);
  const read = text === null ? null : dialect.memberPathOf?.(dialect.jsonExtract(dialect.quoteIdentifier(DOC_COLUMN), text)) ?? null;
  return read !== null && read.length === segments.length
    && segments.some((segment, at) => 'name' in segment && 'index' in read[at]);
}

/**
 * The declared schema type at a segment path: the first non-`null`
 * member of a union. A COLUMN takes its storage from
 * {@link columnSchemaTypeAt}, which answers none where a union lists
 * several types. A caller that must know the whole union (a promotion
 * refusing a member that may also be `null`) reads {@link schemaNodeAt}.
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

/**
 * Whether a schema node admits integers and `null` alone, each within
 * ±(2^53 − 1), by its own `type` and bounds: a `maximum` at or below
 * 2^53 − 1 or an `exclusiveMaximum` at or below 2^53, and the mirror below.
 * A validator reads a document's number as the double its digits round to,
 * and any integer past those bounds rounds to a double the bound refuses,
 * so every conforming document holds a safe integer here, each its own
 * double. A bound elsewhere (`allOf`, `$ref`) proves nothing.
 * @param {any} node
 * @returns {boolean}
 */
export function boundsSafeIntegers(node) {
  const types = typeof node?.type === 'string' ? [node.type] : Array.isArray(node?.type) ? node.type : [];
  const kinds = types.filter((/** @type {unknown} */ type) => type !== 'null');
  if (kinds.length !== 1 || kinds[0] !== 'integer') return false;
  const safe = Number.MAX_SAFE_INTEGER;
  const below = (typeof node.maximum === 'number' && node.maximum <= safe)
    || (typeof node.exclusiveMaximum === 'number' && node.exclusiveMaximum <= safe + 1);
  const above = (typeof node.minimum === 'number' && node.minimum >= -safe)
    || (typeof node.exclusiveMinimum === 'number' && node.exclusiveMinimum >= -(safe + 1));
  return below && above;
}

/**
 * The schema type a path's generated column takes its storage from: the
 * member's declared type, except where the engine's columns can hold any
 * value (`capabilities.untypedColumns`) and the member's union lists several
 * types besides `null` (`['number', 'string']`, `['integer', 'number']`,
 * `['string', 'object']`). A column of the first type would refuse a
 * conforming document that holds another (a STRICT table refuses `'b'` in a
 * REAL column) or rewrite its value (`2` is the text `'2'` in a TEXT one),
 * so such a member is `undefined` here and the column is the engine's
 * untyped one. An engine whose generated column cannot refuse a value
 * (PostgreSQL reads a member of another JSON type as NULL) keeps the first
 * type.
 * @param {any} schema
 * @param {import('./dialect.js').JsonPathSegment[]} segments
 * @param {any} dialect
 * @returns {string | undefined}
 */
function columnSchemaTypeAt(schema, segments, dialect) {
  if (dialect.capabilities.untypedColumns === true) {
    const declared = schemaNodeAt(schema, segments)?.type;
    if (Array.isArray(declared)
      && new Set(declared.filter((type) => typeof type === 'string' && type !== 'null')).size > 1) return undefined;
  }
  return schemaTypeAt(schema, segments);
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
 *   intervals: { name: string, constraint: string, span: { segments: any[], canonical: string,
 *     pathText: string, bounds: { start: string, end: string } }, start: string, end: string,
 *     maxDuration: number | null, sql: string, docPath: string }[],
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
  /** The `integer` columns whose member the schema bounds within ±(2^53 − 1). @type {Set<string>} */
  const safeIntegerColumns = new Set();

  for (const index of collection.indexes) {
    firstColumn.push(generated.length);
    // an EXPRESSION index: one column over the declared computation,
    // shared by every index that declares the same canonical expression
    if (index.expression !== undefined) {
      const known = columnByCanonical.has(index.canonical);
      const columnName = generatedColumnName(expressionStem(index.expression),
        columnByCanonical, taken, { key: index.canonical, suffix: 'x' });
      if (!known) {
        const sqlWith = (/** @type {(segments: any) => any} */ unpinnedOf) => expressionSql(index.expression, dialect, {
          docColumnSql: dialect.quoteIdentifier(DOC_COLUMN),
          declarations: options?.expressions ?? {},
          registered: options?.registered !== false,
          docPath: `${index.docPath}/expression`,
          segmentsOf: (member) =>
            compileIndexPath(member, `${index.docPath}/expression`).segments,
          unpinnedOf,
        });
        const sql = sqlWith((segments) => guardedPath(collection.schema, dialect, segments));
        // the other spelling a table holds: guarded where this one is not, and the reverse
        const alternate = sql === sqlWith(() => undefined)
          ? sqlWith((segments) => (dialect.queryGuard(dialect.quoteIdentifier(DOC_COLUMN), segments) === null ? undefined : segments))
          : sqlWith(() => undefined);
        generated.push({
          name: columnName,
          // an expression's value is TEXT: one declared function, one
          // spelling of its answer, on every engine that computes it
          type: dialect.typeFor('string', 'generated'),
          kind: 'text',
          pathText: null,
          expression: sql,
          ...(alternate === sql ? {} : { alternate }),
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
        const schemaType = columnSchemaTypeAt(collection.schema, segments, dialect);
        const firstType = schemaTypeAt(collection.schema, segments);
        const column = unionColumn({
          name: columnName,
          type: dialect.typeFor(schemaType, 'generated'),
          kind: columnKindFor(schemaType),
          pathText,
          canonical,
        }, { schema: collection.schema, segments, schemaType, firstType, dialect,
          held: options?.legacyColumns?.get(columnName) });
        const unpinned = guardedPath(collection.schema, dialect, segments);
        const doc = dialect.quoteIdentifier(DOC_COLUMN);
        // a path the dialect guards has a second spelling, the one a table holds whose model
        // declared the container the other way (or an earlier release created it)
        const alternate = unpinned !== undefined ? dialect.columnRead(doc, column)
          : dialect.queryGuard(doc, segments) === null ? undefined
            : dialect.columnRead(doc, { ...column, unpinned: segments });
        generated.push({ ...column, ...(unpinned === undefined ? {} : { unpinned }),
          ...(alternate === undefined ? {} : { alternate }) });
        if (column.type === dialect.typeFor('integer', 'generated') && boundsSafeIntegers(schemaNodeAt(collection.schema, segments)))
          safeIntegerColumns.add(columnName);
      }
      columns.push(columnName);
    }
    // a column set realized as an R*Tree has no B-tree over it: the
    // virtual table IS the index, and the four columns stay only as the
    // box's one definition (the triggers read them). A vector column
    // has none either: it is fetched whole and ranked, never sought
    if (noBtree) continue;
    const terms = index.derive ? [] : kindKeyTerms(dialect, index.unique, columns, generated);
    const earlier = index.derive ? [] : kindKeyTerms(dialect, index.unique, columns, generated, true);
    indexes.push({
      name: `${name}_${index.name}`,
      unique: index.unique,
      columns,
      ...(terms.length === 0 ? {} : { terms }),
      ...(earlier.length === 0 || earlier.length === terms.length ? {} : { earlierTerms: earlier }),
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
    const member = column.pathText === null ? undefined : topMemberOf(column.canonical);
    const codec = member === undefined || column.derive !== undefined ? undefined : conditionCodec(schemaNodeAt(collection.schema, [{ name: member }]));
    if (codec !== undefined) conditionColumns.push({ name: /** @type {string} */ (member), physical: column.name, codec });
  }
  /** @param {string} member */
  const unreadable = (member) => (columnByCanonical.has(canonicalOf([{ name: member }]))
    ? `'${member}' may hold null or has no one scalar type, and its generated column holds SQL NULL for a null and for a missing member alike, which the query engine tells apart`
    : `'${member}' has no generated column: an index condition reads a member the collection indexes by its path — index '${modelPath([{ name: member }])}' first`);
  for (const index of indexes) {
    if (index.declared.where === undefined) continue;
    /** @type {Set<string>} */
    const reads = new Set();
    index.where = indexCondition(index.declared.where, conditionColumns, dialect, `${index.declared.docPath}/where`, unreadable, reads);
    index.reads = [...reads];
  }
  // a declared interval: the two bound columns the collection's plain
  // indexes give its span member (held at normalization), and the one
  // CHECK that makes every stored span a half-open one for every writer
  const intervals = (collection.intervals ?? []).map((interval) => {
    const pathText = dialect.jsonPathText(interval.segments);
    const boundText = (/** @type {string} */ bound) => dialect.jsonPathText([...interval.segments, { name: bound }]);
    const bounds = { start: boundText('start'), end: boundText('end') };
    const start = columnByCanonical.get(interval.start.canonical);
    const end = columnByCanonical.get(interval.end.canonical);
    if (pathText === null || bounds.start === null || bounds.end === null || start === undefined || end === undefined) {
      throw new DbCompileError('JD0004',
        `the interval path '${interval.path}' names a member the dialect's JSON path grammar cannot carry`,
        `${interval.docPath}/path`);
    }
    const unpinned = guardedPath(collection.schema, dialect, interval.segments);
    const checkWith = (/** @type {any} */ guard) => dialect.ddl.intervalCheck({ docColumn: DOC_COLUMN, span: pathText, bounds,
      start: dialect.quoteIdentifier(start), end: dialect.quoteIdentifier(end), maxDuration: interval.maxDuration,
      ...(guard === undefined ? {} : { unpinned: guard }) });
    const sql = checkWith(unpinned);
    // a CHECK over a path the dialect guards is read either way: with the guard where the schema leaves a
    // container open and without it where it declares one, and a change of that alone is no change
    const alternate = dialect.queryGuard(dialect.quoteIdentifier(DOC_COLUMN), interval.segments) === null
      ? undefined : checkWith(unpinned === undefined ? interval.segments : undefined);
    return { name: interval.name, constraint: interval.constraint,
      span: { segments: interval.segments, canonical: interval.canonical, pathText, bounds,
        ...(unpinned === undefined ? {} : { unpinned }) },
      start, end, maxDuration: interval.maxDuration, sql, ...(alternate === undefined ? {} : { alternate }),
      docPath: interval.docPath };
  });
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
    checks: intervals.map((interval) => ({ name: interval.constraint, sql: interval.sql })),
  };
  const containers = containerKeysOf(dialect, name, indexes, generated);
  const kindIndexes = [...kindIndexesOf(collection.schema, dialect, indexes, generated), ...containers.indexes];
  const containerKeys = containers.keys;
  const createSql = [
    dialect.ddl.createTable({ ...tableShape, plain: containerKeys.map((key) => ({ name: key.column, type: key.type })) }),
    ...indexes.map((index) => dialect.ddl.createIndex({
      name: index.name,
      table: name,
      columns: index.columns,
      unique: index.unique,
      ...(index.where === undefined ? {} : { where: index.where }),
      ...(index.terms === undefined ? {} : { terms: index.terms }),
    })),
    ...kindIndexes.map((index) => kindIndexSql(dialect, name, index)),
    ...containerKeys.flatMap((key) => key.triggers.map((trigger) => trigger.sql)),
    ...virtualTables.flatMap((virtual) =>
      [virtual.createSql, ...virtual.triggers.map((trigger) => trigger.sql)]),
  ];
  // the table, the relations the engine gives it, its indexes, and the
  // virtual tables and triggers named from a column stem: one namespace
  const objects = [
    { name, what: `the table for collection '${name}'`, docPath: collectionPath, rename: 'the collection' },
    ...ownObjects(dialect, name, [{ name: KEY_COLUMN, type: keyType }, { name: DOC_COLUMN, type: dialect.docColumnType }, ...generated,
      ...containerKeys.map((key) => ({ name: key.column, type: key.type }))], collectionPath),
    ...indexes.map((index) => ({ name: index.name, what: `index '${index.declared.name}'`, docPath: `${index.declared.docPath}/name`, rename: 'the index' })),
    ...kindIndexes.map((index) => ({ name: index.name, what: `the ${index.kind} index beside '${index.declared.name}'`,
      docPath: `${index.declared.docPath}/name`, rename: 'the index' })),
    ...containerKeys.flatMap((key) => key.triggers.map((trigger) => ({ name: trigger.name,
      what: `the trigger that writes the container key '${key.column}'`, docPath: collectionPath }))),
    ...virtualTables.flatMap((virtual) => [virtual, ...virtual.triggers].map((object) => ({ name: object.name,
      what: `the schema object '${object.name}' of a derived index`, docPath: collectionPath }))),
  ];
  refuseNameCollisions(objects);

  // a column a table holds in a type that cannot answer the member's first
  // kind is read through the document
  for (const column of generated) if (column.unreadable === true) columnByCanonical.delete(column.canonical);

  const plan = {
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
    /** The generated columns that hold their member as the document does,
     * whatever its JSON type: an untyped column over a member of several
     * types. A column a table holds in one of the member's types is not one
     * (see {@link adoptLegacyColumns}). */
    anyKindColumns: new Set(generated.filter((g) => g.legacyTypes !== undefined).map((g) => g.name)),
    /** The generated columns that hold a number as the double the engine
     * holds: one declared as a `number` member's column is, and so is one
     * whose read casts a number to it (`kind: 'key'`, a number-first union) —
     * on an engine whose number column holds a double, never one that holds
     * the digits a writer spelled (`decimalDigits`). A comparison with an
     * integer past 2^53, and an ordering, read such a column bare. */
    doubleColumns: new Set(dialect.decimalDigits ? [] : generated.filter((g) => g.kind === 'key'
      || g.type === dialect.typeFor('number', 'generated')).map((g) => g.name)),
    /** The generated `integer` columns whose member the schema bounds within
     * ±(2^53 − 1) ({@link boundsSafeIntegers}): two integers such a column
     * holds are two doubles, so an ordering reads it bare and keeps its
     * index order, as it reads a {@link doubleColumns} one — on an engine
     * whose column holds a number as an integer or a double, never one that
     * holds the digits a writer spelled (`decimalDigits`), where `5` and a
     * conforming `5.00000000000000000001` are two values and one double. */
    safeIntegerColumns: dialect.decimalDigits ? new Set() : safeIntegerColumns,
    /** The generated columns a B-tree index keys, each with whether it
     * leads one that holds every row (no condition, `'leads'`) or keys it
     * otherwise (`'follows'`): an ordering that reads such an integer column
     * bare probes it for a number past ±(2^53 − 1) from the end of the index
     * it leads, else through the statement's own filter; a column no index
     * keys is sorted either way, and is not probed. */
    indexedColumns: indexedColumnsOf(indexes),
    /** The indexes beside a declared index over a member of several kinds
     * that key its other kinds ({@link kindIndexesOf}): each one's name, its
     * declared index's (`of`), the kinds (`kind`, `text` or `text$boolean`),
     * whether it is unique, its keys (a column or the member read at a kind)
     * and its condition. Kept apart from `expected.indexes`, since a key is
     * read back as an expression; a table an earlier release created goes
     * without them and opens as it is. */
    kindIndexes,
    /** The plain columns a unique index keys a container by on an engine whose
     * generated column holds it as written ({@link containerKeysOf}): each
     * one's name (`column`), the generated column of its member (`of`), the
     * member's path, the two triggers that write it and its `read` over the
     * document. A table an earlier release created goes without them, their
     * triggers and the indexes over them, and opens as it is. */
    containerKeys,
    /** The generated columns that read their member off the document under
     * the dialect's guard (a path that leaves a container open), as the
     * table holds them: a table this plan creates holds every one, and the
     * open of an existing table keeps only those whose definition it reads
     * back as planned ({@link verifyShape}). A query reads such a column
     * where it would otherwise read the guarded document. */
    guardedColumns: new Set(generated.filter((g) => g.unpinned !== undefined).map((g) => g.name)),
    virtualTables,
    createSql,
    objects,
    /** The members an index condition may read, by their generated columns. */
    conditionColumns,
    /** The declared intervals: each one's bound columns and the CHECK it installs. */
    intervals,
    expected: {
      columns: [
        { name: KEY_COLUMN, type: keyType, generated: false },
        { name: DOC_COLUMN, type: dialect.docColumnType, generated: false },
        ...identityColumnExpected(dialect),
        // a STORED derived column is an ordinary one: the flag is what
        // `pragma_table_xinfo` reports, and it is the difference a file
        // moved between the two physical mappings shows up as
        ...generated.map((g) => ({ name: g.name, type: g.type, generated: g.stored !== true })),
        ...containerKeys.map((key) => ({ name: key.column, type: key.type, generated: false })),
      ],
      indexes: indexes
        // the COLUMNS keep their declared order — an index is ordered, and
        // comparing sorted term lists made `(a,b)` and `(b,a)` equal. Only
        // the index list itself is sorted, to compare by name.
        .map((index) => ({
          name: index.name,
          unique: index.unique,
          columns: [...index.columns],
          // the kind keys after the columns ({@link kindKeyTerms}); a table an
          // earlier release created holds the index without them, or with those
          // over untyped columns alone (`earlierTerms`)
          ...(index.terms === undefined ? {} : { terms: [...index.terms] }),
          ...(index.earlierTerms === undefined ? {} : { earlierTerms: [...index.earlierTerms] }),
          // the columns a condition reads, for a migration that changes one of them
          ...(index.where === undefined ? {} : { where: index.where, reads: index.reads }),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
  };
  // the same plan for a table that holds some columns in one of their
  // member's types; not enumerable, so a plan still clones and compares
  Object.defineProperty(plan, 'replan', {
    value: (/** @type {Map<string, string>} */ legacyColumns) =>
      planCollection(name, collection, dialect, { ...options, legacyColumns }),
  });
  return plan;
}

/**
 * A collection's plan as a table holds it that goes without some of its
 * container key columns ({@link containerKeysOf}) — one an earlier release
 * created: without them, their triggers and the indexes that key them. The
 * plan itself where the table holds every one.
 * @param {any} dialect
 * @param {any} plan - from {@link planCollection}
 * @param {Set<string>} absent - the container key columns the table lacks
 * @returns {any}
 */
export function withoutContainerKeys(dialect, plan, absent) {
  const keys = plan.containerKeys ?? [];
  if (!keys.some((/** @type {any} */ key) => absent.has(key.column))) return plan;
  const kept = keys.filter((/** @type {any} */ key) => !absent.has(key.column));
  const lacks = (/** @type {any} */ index) => index.keys.some((/** @type {any} */ key) => 'column' in key && absent.has(key.column));
  const dropped = new Set([
    ...keys.filter((/** @type {any} */ key) => absent.has(key.column)).flatMap((/** @type {any} */ key) => key.triggers.map((/** @type {any} */ trigger) => trigger.sql)),
    ...plan.kindIndexes.filter(lacks).map((/** @type {any} */ index) => kindIndexSql(dialect, plan.table, index)),
  ]);
  const table = dialect.ddl.createTable({ table: plan.table, keyColumn: plan.keyColumn, keyType: plan.keyType, docColumn: plan.docColumn,
    generated: plan.generated, plain: kept.map((/** @type {any} */ key) => ({ name: key.column, type: key.type })),
    checks: (plan.intervals ?? []).map((/** @type {any} */ interval) => ({ name: interval.constraint, sql: interval.sql })) });
  const held = { ...plan, containerKeys: kept, kindIndexes: plan.kindIndexes.filter((/** @type {any} */ index) => !lacks(index)),
    createSql: [table, ...plan.createSql.slice(1).filter((/** @type {string} */ sql) => !dropped.has(sql))],
    expected: { ...plan.expected, columns: plan.expected.columns.filter((/** @type {any} */ column) => !absent.has(column.name)) } };
  Object.defineProperty(held, 'replan', { value: plan.replan });
  return held;
}

/**
 * The container keys of a collection's unique indexes, on an engine whose
 * generated column over a member of several types (or of none) is untyped
 * and holds an object or an array as its bytes (`dialect.containerKey`):
 * one plain column per such member of a unique index, written by two
 * triggers with the container's key (its members in one order), and per
 * unique index one index beside it for each combination of its such
 * members keyed by that column rather than their own, but the one keying
 * every member by its own column — the declared index. A beside index keys
 * every other member by its column (and its kind key,
 * {@link kindKeyTerms}), under the declared condition, unique, over the
 * rows whose key columns hold a key (the column is NULL for every value but a
 * container, and NULL keys never meet). Together they refuse a duplicate
 * container in any member order, and nothing the query engine compares
 * unequal. A non-unique index refuses nothing and has none.
 * @param {any} dialect
 * @param {string} table
 * @param {any[]} indexes - the planned declared indexes
 * @param {any[]} generated - the planned generated columns
 * @returns {{ keys: { column: string, of: string, type: string, pathText: string, read: string,
 *   triggers: { name: string, sql: string }[] }[], indexes: any[] }}
 */
export function containerKeysOf(dialect, table, indexes, generated) {
  /** @type {any[]} */
  const keys = [];
  /** @type {any[]} */
  const beside = [];
  const containerKey = dialect.containerKey;
  if (containerKey === undefined) return { keys, indexes: beside };
  const untyped = dialect.typeFor(undefined, 'generated');
  const doc = dialect.quoteIdentifier(DOC_COLUMN);
  /** @param {any} column */
  const keyOf = (column) => {
    const name = `kx_${column.name.replace(/^gx_/, '')}`;
    let key = keys.find((candidate) => candidate.column === name);
    if (key === undefined) {
      key = { column: name, of: column.name, type: dialect.typeFor('string', 'generated'), pathText: column.pathText,
        read: containerKey.read(doc, column.pathText),
        triggers: containerKey.triggers({ table, keyColumn: KEY_COLUMN, docColumn: DOC_COLUMN, column: name, pathText: column.pathText }) };
      keys.push(key);
    }
    return key;
  };
  for (const index of indexes) {
    const declared = index.declared;
    if (index.unique !== true || declared.derive || declared.expression !== undefined) continue;
    const columns = index.columns.map((/** @type {string} */ name) => generated.find((candidate) => candidate.name === name));
    const varied = columns.flatMap((/** @type {any} */ column, /** @type {number} */ at) =>
      (column !== undefined && column.pathText !== null && column.type === untyped ? [at] : []));
    if (varied.length === 0) continue;
    for (const at of varied) keyOf(columns[at]);
    // which varied members a beside index keys by their container key
    for (const combination of besideCombinations(varied.map(() => [false, true]))) {
      const byKey = new Set(varied.filter((_at, i) => combination[i]));
      const indexKeys = columns.map((/** @type {any} */ column, /** @type {number} */ at) => {
        if (!byKey.has(at)) return { column: index.columns[at] };
        const key = keyOf(column);
        return { column: key.column, read: key.read };
      });
      const flags = columns.flatMap((/** @type {any} */ column, /** @type {number} */ at) => {
        const term = byKey.has(at) || column === undefined || column.pathText === null ? null
          : /** @type {any} */ (dialect.kindKeyTerm)(doc, column.pathText, column.type);
        return term === null ? [] : [{ expression: term }];
      });
      const kind = varied.map((_at, i) => (combination[i] ? 'container' : 'value')).join('$');
      // only a row whose members hold containers there is keyed: a NULL key never meets another
      const where = [...(index.where === undefined ? [] : [`(${index.where})`]),
        ...indexKeys.filter((key) => 'read' in key).map((key) => `${dialect.quoteIdentifier(key.column)} IS NOT NULL`)].join(' AND ');
      beside.push({ name: kindIndexName(dialect, index.name, kind), of: index.name, kind, unique: true, keys: [...indexKeys, ...flags],
        where, ...(index.where === undefined ? {} : { condition: index.where }), declared });
    }
  }
  return { keys, indexes: beside };
}

/**
 * The generated columns a planned B-tree index keys: `'leads'` where the
 * column is the first key of an index that holds every row (no condition),
 * `'follows'` where it is only a later key or keys a conditional index.
 * @param {{ columns: string[], where?: any }[]} indexes
 * @returns {Map<string, 'leads' | 'follows'>}
 */
function indexedColumnsOf(indexes) {
  /** @type {Map<string, 'leads' | 'follows'>} */
  const out = new Map();
  for (const index of indexes) {
    index.columns.forEach((/** @type {string} */ column, /** @type {number} */ at) => {
      if (at === 0 && index.where === undefined) out.set(column, 'leads');
      else if (!out.has(column)) out.set(column, 'follows');
    });
  }
  return out;
}

/**
 * The keys a unique index adds after its columns where a column alone would
 * key two values of different kinds as one (`dialect.kindKeyTerm`): for each
 * generated column over a member, whether the member is a JSON boolean where
 * the column is untyped (it holds `true` as `1`), and where it is of a real
 * SQL type the member's value if it is not of the column's own kind (the
 * column holds `true` and `"1"` as `1.0`). Without them the index would refuse
 * two values the query engine compares unequal; every value it keyed apart
 * stays apart, and two equal values stay one key. A non-unique index refuses
 * nothing and keys the columns alone.
 * @param {any} dialect
 * @param {boolean | undefined} unique
 * @param {string[]} columns - the index's columns, in key order
 * @param {any[]} generated - the planned generated columns
 * @param {boolean} [untypedOnly] - the keys over untyped columns alone: the
 *   index as a table an earlier release created holds it
 * @returns {string[]}
 */
function kindKeyTerms(dialect, unique, columns, generated, untypedOnly = false) {
  if (unique !== true || dialect.kindKeyTerm === undefined) return [];
  const untyped = dialect.typeFor(undefined, 'generated');
  return columns.flatMap((name) => {
    const column = generated.find((candidate) => candidate.name === name);
    const term = column === undefined || column.pathText === null || untypedOnly && column.type !== untyped ? null
      : dialect.kindKeyTerm(dialect.quoteIdentifier(DOC_COLUMN), column.pathText, column.type);
    return term === null ? [] : [term];
  });
}

/**
 * The indexes beside a declared index over a member of several scalar kinds,
 * on an engine whose generated columns carry a real SQL type. The column a
 * declared index keys holds the member's first type and reads every other
 * kind as NULL, so a comparison of another kind reads the member out of the
 * document at that kind (the dialect's `columnRead`, as a native statement
 * spells it), and a unique index refuses a duplicate of the first kind
 * alone. Beside the declared index stands one index per combination of the
 * kinds its members hold other than the first of each (`integer` and
 * `number` are one kind), keying each such member by its read at that kind
 * and every other member by its column, under the declared condition, and
 * unique when the declared index is: together they key every scalar kind,
 * so a duplicate of any kind is refused, and a value of one kind never
 * meets one of another (`1` and `'1'` are two keys, as are `true` and `1`).
 * Beside a unique index an object and an array its union lists after a
 * scalar are kinds too, read as `jsonb`, whose equality is the query
 * engine's (members in any order, numbers by value). A key under a guarded
 * path step carries the other spelling of the guard (`alternate`), which a
 * table whose model declared the container the other way holds. A
 * non-unique index has them only over a single member path with no
 * condition and no guarded step (one a comparison seeks); a unique one
 * has them over every shape.
 * @param {any} schema
 * @param {any} dialect
 * @param {any[]} indexes - the planned declared indexes
 * @param {any[]} generated - the planned generated columns
 * @returns {{ name: string, of: string, kind: string, unique: boolean,
 *   keys: ({ column: string } | { expression: string, alternate?: string })[], where?: string, declared: any }[]}
 */
function kindIndexesOf(schema, dialect, indexes, generated) {
  if (dialect.capabilities.untypedColumns === true) return [];
  const doc = dialect.quoteIdentifier(DOC_COLUMN);
  const byName = new Map(generated.map((column) => [column.name, column]));
  return indexes.flatMap((index) => {
    const declared = index.declared;
    if (declared.expression !== undefined || declared.derive || !Array.isArray(declared.paths)
      || declared.paths.length !== index.columns.length) return [];
    const positions = declared.paths.map((/** @type {string} */ path, /** @type {number} */ at) => {
      const { segments } = compileIndexPath(path, `${declared.docPath}/path`);
      const column = byName.get(index.columns[at]);
      const types = schemaNodeAt(schema, segments)?.type;
      const first = columnKindFor(schemaTypeAt(schema, segments));
      // an object or an array is a kind of a unique index's member whose column holds a
      // scalar, keyed as `jsonb`; a column that holds a container keeps every kind
      const kindOf = (/** @type {any} */ type) => columnKindFor(type)
        ?? (declared.unique === true && first !== undefined && (type === 'object' || type === 'array') ? type : undefined);
      const kinds = !Array.isArray(types) || column === undefined || column.pathText === null ? []
        : [...new Set(types.map(kindOf))]
          .filter((kind) => kind !== undefined && kind !== first);
      const guarded = dialect.queryGuard(doc, segments) !== null;
      return { column: index.columns[at], kinds: /** @type {string[]} */ (kinds), first: /** @type {string} */ (first), read: column, guarded, segments };
    });
    // a member whose union lists a container first has a `jsonb` column that keeps every
    // kind: beside another member it is keyed by that column alone
    const varied = positions.filter((position) => position.kinds.length > 0 && (position.first !== undefined || positions.length === 1));
    if (varied.length === 0) return [];
    if (declared.unique !== true && (positions.length !== 1 || declared.where !== undefined || positions[0].guarded)) return [];
    // every combination of the varied members' kinds but the one of their first kinds
    return besideCombinations(varied.map((position) => [position.first, ...position.kinds])).map((combination) => {
      const kind = combination.join('$');
      const keys = positions.map((position) => {
        const at = varied.indexOf(position);
        if (at === -1 || combination[at] === position.first) return { column: position.column };
        const read = (/** @type {any} */ unpinned) => dialect.columnRead(doc, { pathText: position.read.pathText, kind: combination[at], unpinned });
        // a guarded path's other spelling, the one a table holds whose model declared the
        // container the other way, as its column has ({@link verifyKindIndexes})
        return { expression: read(position.read.unpinned),
          ...(position.guarded ? { alternate: read(position.read.unpinned === undefined ? position.segments : undefined) } : {}) };
      });
      return { name: kindIndexName(dialect, index.name, kind), of: index.name, kind, unique: declared.unique === true, keys,
        ...(index.where === undefined ? {} : { where: index.where }), declared };
    });
  });
}

/**
 * Every combination of one choice per member, the first choice of each
 * member first, but the combination of every member's first choice — the
 * declared index's own: the keys of the indexes beside it.
 * @template T
 * @param {T[][]} choices - per member, its declared choice first
 * @returns {T[][]}
 */
function besideCombinations(choices) {
  /** @type {T[][]} */
  let combinations = [[]];
  for (const options of choices) combinations = combinations.flatMap((combination) => options.map((option) => [...combination, option]));
  return combinations.slice(1);
}

/**
 * The name of the index beside the declared index `of` that seeks its
 * member's `kind`: `<of>$<kind>`, which no declared index or collection can
 * take (their names are identifiers), or, where that is longer than the
 * engine keeps an identifier, `of` clipped to fit beside a short hash of it.
 * @param {any} dialect @param {string} of @param {string} kind
 * @returns {string}
 */
export function kindIndexName(dialect, of, kind) {
  const natural = `${of}$${kind}`;
  const limit = dialect.maxIdentifierBytes;
  if (!Number.isFinite(limit) || utf8ByteLength(natural) <= limit) return natural;
  const suffix = `$${kind}_${hashContent(of)}`;
  return clipToBytes(of, limit - suffix.length) + suffix;
}

/**
 * The statement that creates an index {@link kindIndexesOf} plans.
 * @param {any} dialect @param {string} table
 * @param {{ name: string, unique: boolean, keys: ({ column: string } | { expression: string })[], where?: string }} index
 * @returns {string}
 */
export function kindIndexSql(dialect, table, index) {
  const keys = kindIndexTerms(dialect, index);
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${dialect.quoteIdentifier(index.name)} ON ${dialect.quoteIdentifier(table)} `
    + `(${keys.join(', ')})${index.where === undefined ? '' : ` WHERE ${index.where}`}`;
}

/**
 * The key terms of an index {@link kindIndexesOf} or {@link containerKeysOf}
 * plans, in order: a column by its name, a member read at a kind by its
 * expression; `reading`, a container key column by the read of the document
 * a trigger writes into it, for a table that does not hold the column yet.
 * @param {any} dialect
 * @param {{ keys: ({ column: string, read?: string } | { expression: string })[] }} index
 * @param {boolean} [reading]
 * @returns {string[]}
 */
export function kindIndexTerms(dialect, index, reading = false) {
  return index.keys.map((key) => (reading && 'read' in key ? key.read
    : 'column' in key ? dialect.quoteIdentifier(key.column) : key.expression));
}

/**
 * The statement that drops an index {@link kindIndexesOf} plans, where the
 * table holds it: one an earlier release created does not.
 * @param {any} dialect @param {string} name
 * @returns {string}
 */
export function kindIndexDropSql(dialect, name) {
  return `DROP INDEX IF EXISTS ${dialect.quoteIdentifier(name)}`;
}

/**
 * Give a generated column over a member of several types its storage. On an
 * engine whose columns hold any value it is untyped (see
 * {@link columnSchemaTypeAt}) and carries `legacyTypes`, the types a column
 * over a member's types was once declared in, which a table may still hold. A
 * member whose first type is `number` (null aside) reads its numbers as the
 * doubles the query engine compares, as a `REAL` column does. `earlierType`
 * is the type an earlier release declared such a column in, its first type's,
 * which a table may still hold: a migration that keeps the column's read
 * changes no column unless the other model's column cannot take that type.
 * @param {any} column
 * @param {{ schema: any, segments: import('./dialect.js').JsonPathSegment[], schemaType: string | undefined,
 *   firstType: string | undefined, dialect: any, held: string | undefined }} context - `held` is the type
 *   the table at hand declares the column in, when it is one of `legacyTypes`
 * @returns {any}
 */
function unionColumn(column, { schema, segments, schemaType, firstType, dialect, held }) {
  if (schemaType === firstType) return column;
  const declared = schemaNodeAt(schema, segments).type;
  const members = declared.filter((/** @type {any} */ type) => typeof type === 'string' && type !== 'null');
  const legacyTypes = [...new Set(members.map((/** @type {string} */ type) => dialect.typeFor(type, 'generated')))]
    .filter((type) => type !== column.type);
  if (held !== undefined && legacyTypes.includes(held)) {
    // the column of the table at hand: its type, the plain expression it was written with, and
    // the document for a kind it cannot answer
    return { ...column, type: held, kind: undefined,
      ...(held === dialect.typeFor(firstType, 'generated') ? {} : { unreadable: true }) };
  }
  return { ...column, legacyTypes, earlierType: dialect.typeFor(firstType, 'generated'), ...(firstType === 'number' ? { kind: 'key' } : {}) };
}

/**
 * The columns of an existing table that are declared in one of their member's
 * types, by the type word the table declares.
 * @param {any} dialect
 * @param {any} plan - from {@link planCollection}
 * @param {any[]} rows - the table's columns, as the dialect's catalog query answers
 * @returns {Map<string, string>}
 */
export function legacyColumnTypes(dialect, plan, rows) {
  /** @type {Map<string, string>} */
  const held = new Map();
  for (const column of plan.generated) {
    if (column.legacyTypes === undefined) continue;
    const have = rows.find((row) => String(row.name) === column.name);
    if (have === undefined) continue;
    const type = column.legacyTypes.find(
      (/** @type {string} */ candidate) => dialect.comparableColumnType(candidate) === dialect.comparableColumnType(String(have.type)));
    if (type !== undefined) held.set(column.name, type);
  }
  return held;
}

/**
 * Make the plan of an existing table describe the table: a generated column
 * declared in one of its member's types stays that type, so the table opens
 * and answers as it does. Nothing else may differ — the
 * comparisons that follow refuse any other drift.
 * @param {any} connection
 * @param {any} plan
 * @returns {any} value-or-promise
 */
function adoptLegacyColumns(connection, plan) {
  if (!(plan.generated ?? []).some((/** @type {any} */ column) => column.legacyTypes !== undefined)) return null;
  const dialect = connection.dialect;
  return chain(connection.prepare(dialect.introspect.columns(plan.table)), (statement) =>
    chain(statement.all([]), (rows) => {
      const held = legacyColumnTypes(dialect, plan, rows);
      if (held.size > 0) Object.assign(plan, plan.replan(held));
      return null;
    }));
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
      // an index a table an earlier release created goes without (see `verifyShape`)
      const legacyAbsent = new Set((plan.expected?.indexes ?? [])
        .filter((/** @type {any} */ index) => index.legacyAbsent === true).map((/** @type {any} */ index) => index.name));
      // and a unique index it created without some of the kind keys after its columns
      const earlier = earlierIndexSql(dialect, plan);
      for (const [name, wanted] of planned) {
        const have = actual.get(name);
        if (have === undefined && legacyAbsent.has(name)) continue;
        if (have === undefined)
          disagree(`the model declares '${name}', which the database does not have`);
        if (have !== wanted && !(earlier.get(name) ?? []).some((spelling) => spelling.sql === have)) {
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
 * The CREATE texts, as {@link comparableDeclaredSql} compares them, of each
 * planned index that keys kinds after its columns ({@link kindKeyTerms}) as
 * a table an earlier release created holds it: without the keys, or with
 * those over untyped columns alone (`earlierTerms`), each with the keys it
 * holds. Such a table opens and answers as it did (refusing `true` beside
 * `1`); `planColumnUpgrade` creates the index again with every key.
 * @param {any} dialect
 * @param {any} plan
 * @returns {Map<string, { sql: string, terms: string[] }[]>} by index name
 */
function earlierIndexSql(dialect, plan) {
  return new Map((plan.expected?.indexes ?? []).filter((/** @type {any} */ index) => index.terms !== undefined)
    .map((/** @type {any} */ index) => [index.name, [[], ...(index.earlierTerms === undefined ? [] : [index.earlierTerms])]
      .map((/** @type {string[]} */ terms) => ({ terms, sql: comparableDeclaredSql(dialect.ddl.createIndex(
        { name: index.name, table: plan.table, columns: index.columns, unique: index.unique, where: index.where, terms }), MANAGED_SQL_OPTIONS) }))]));
}

/**
 * The planned indexes a table holds as an earlier release created them
 * ({@link earlierIndexSql}), by name, with the kind keys each holds, from
 * the table's schema objects as `dialect.introspect.declaredSql` reads them.
 * @param {any} dialect
 * @param {any} plan
 * @param {{ type: unknown, name: unknown, sql: unknown }[]} rows
 * @returns {Map<string, string[]>}
 */
export function earlierIndexesHeld(dialect, plan, rows) {
  const earlier = earlierIndexSql(dialect, plan);
  /** @type {Map<string, string[]>} */
  const held = new Map();
  for (const row of rows) {
    const sql = comparableDeclaredSql(String(row.sql), MANAGED_SQL_OPTIONS);
    const spelling = String(row.type) === 'index' ? earlier.get(String(row.name))?.find((candidate) => candidate.sql === sql) : undefined;
    if (spelling !== undefined) held.set(String(row.name), spelling.terms);
  }
  return held;
}

/**
 * Verify an existing table against the planned shape; any difference
 * is `JD0002` and nothing is altered. Shared by the store's open path,
 * the migration engine's shadow validation and its acceptance of the
 * tables a migration leaves, which refuses in its own words (`refuse`).
 * @param {any} connection
 * @param {any} plan
 * @param {string} collection - the table's collection or entity
 * @param {string} docPath
 * @param {'collection' | 'entity'} [kind] - what `collection` names, for the refusal
 * @param {(difference: string) => never} [refuse] - raises the refusal of a
 *   difference, which names the table first; `JD0002` where none is given
 * @returns {any} value-or-promise
 */
export function verifyShape(connection, plan, collection, docPath, kind = 'collection', refuse = undefined) {
  const dialect = connection.dialect;
  const disagree = (/** @type {string} */ difference) => {
    if (refuse !== undefined) return refuse(`${kind} '${collection}': ${difference}`);
    throw new DbCompileError('JD0002',
      `${kind} '${collection}': the existing table does not match the declared model (${difference}); reshaping a live database is the migration story, and nothing was altered`,
      docPath);
  };
  // an engine that keeps no CREATE text has its catalog read back what that
  // text would carry — each index's condition and shape, each generated
  // column's expression — through the dialect's exact read-back
  const readBack = dialect.capabilities.declaredSqlText === true ? undefined : dialect.readBack;
  const declared = plan;
  return chain(adoptLegacyColumns(connection, declared), () => chain(connection.prepare(dialect.introspect.columns(declared.table)), (columnsStatement) =>
    chain(columnsStatement.all([]), (columnRows) => {
      // a table an earlier release created goes without the columns a unique index keys a
      // container by, their triggers and the indexes over them, and opens as it is
      const heldNames = new Set(columnRows.map((row) => String(row.name)));
      const plan = withoutContainerKeys(dialect, declared, new Set((declared.containerKeys ?? [])
        .map((/** @type {any} */ key) => key.column).filter((/** @type {string} */ column) => !heldNames.has(column))));
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
          identity: row.identity === undefined || row.identity === null ? '' : String(row.identity),
          conforming: readsConforming(row),
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
        let difference = planned === undefined ? null
          : readBack.expression(/** @type {string} */ (have.computes), planned, have.conforming);
        // a column read under the guard is one a query may read only where the table holds that
        // spelling; one it holds the other way, or whose spelling the catalog does not say, is not
        if (planned === undefined || difference !== null) plan.guardedColumns?.delete(have.name);
        if (difference !== null) {
          // the same path spelled with the guard or without it: a table whose container the model
          // declared the other way, or one an earlier release created, opens as it did
          const alternate = alternateExpression(plan, have.name);
          if (alternate !== undefined && readBack.expression(/** @type {string} */ (have.computes), alternate, have.conforming) === null)
            difference = null;
        }
        if (difference !== null) disagree(`column '${have.name}' ${difference}`);
      }
      // a key the model leaves to the database over a column that allocates
      // nothing (a table an earlier release created, or one migrated before
      // allocation was planned) opens, and refuses the write that needs the
      // allocation. Only what is proven is refused: a column allocates nothing
      // when it has no default of any kind and is no identity (a default the
      // application wrapped, or a function of its own, allocates as it says);
      // the answer is recorded for the entity as the open read it
      if (plan.autoKey !== undefined) {
        const key = actual.find((column) => column.name === plan.autoKey);
        plan.keyAllocates = key !== undefined && (key.computes !== null || key.identity !== '');
      }
      return chain(connection.prepare(dialect.introspect.indexes(plan.table)), (indexesStatement) =>
        chain(indexesStatement.all([]), (indexRows) => {
          // an index beside a declared one that seeks another kind of its member is
          // compared on its own, and a table an earlier release created goes without it
          const kindIndexes = new Map((plan.kindIndexes ?? []).map((/** @type {any} */ index) => [index.name, index]));
          const created = indexRows
            .filter((row) => String(row.origin) === 'c' && !kindIndexes.has(String(row.name)))
            .map((row) => ({ name: String(row.name), unique: Number(row.uniq) !== 0,
              predicate: row.predicate === null || row.predicate === undefined ? null : String(row.predicate),
              plain: row.plain === undefined || row.plain === null || Number(row.plain) === 1,
              conforming: readsConforming(row) }))
            .sort((a, b) => (a.name < b.name ? -1 : 1));
          // an index a table an earlier release created goes without
          // (`legacyAbsent`) is wanted only where the table has it
          const createdNames = new Set(created.map((index) => index.name));
          const wantedIndexes = plan.expected.indexes.filter((/** @type {any} */ index) =>
            index.legacyAbsent !== true || createdNames.has(index.name));
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
                // an expression key reads back without a name: the kind keys a
                // unique index adds after its columns, which a table an earlier
                // release created goes without or holds over its untyped columns
                // alone (the CREATE text is compared below)
                const haveColumns = rows.map((row) => (row.name === null || row.name === undefined ? null : String(row.name)));
                const keyed = (/** @type {readonly string[]} */ terms) => haveColumns.length === want.columns.length + terms.length
                  && haveColumns.every((column, at) => column === (at < want.columns.length ? want.columns[at] : null));
                if (![[], want.terms ?? [], want.earlierTerms ?? []].some(keyed))
                  disagree(`index '${have.name}' covers (${haveColumns.map((column) => column ?? '<expression>').join(', ')}) in that order, the model declares (${want.columns.join(', ')})`);
                // the catalog's shape flag: no NULLS NOT DISTINCT, no key order,
                // collation or operator class of its own, no INCLUDE column (it reads
                // as a key column here and keys nothing), not deferred — each changes
                // what a unique index refuses
                if (!have.plain) disagree(`index '${have.name}' is not the plain ascending B-tree the model declares (NULLS NOT DISTINCT, a key order, collation or operator class of its own, an INCLUDE column, or a deferred check)`);
                const difference = readBack !== undefined
                  ? readBack.condition(have.predicate, want.where, plan.conditionColumns ?? [], have.conforming)
                  : have.predicate === null ? null : `has the condition ${have.predicate}, which the model does not declare`;
                if (difference !== null) disagree(`index '${have.name}' ${difference}`);
                // an expression key, where the engine keeps no CREATE text, is read
                // back from the catalog and compared as the model plans it
                return chain(readBack === undefined || (want.terms ?? []).length === 0 ? null
                  : verifyIndexTerms(connection, have, want, disagree), () => collectColumns(i + 1));
              }));
          };
          // the table's rule programs: from the catalog where the engine keeps
          // no CREATE text, every other trigger or rewrite rule on the table
          // undeclared drift; a CREATE text comparison covers them below
          const heldKindIndexes = indexRows.filter((row) => String(row.origin) === 'c' && kindIndexes.has(String(row.name)));
          // an engine that keeps CREATE text compares theirs below
          const besides = () => (dialect.capabilities.declaredSqlText === true ? null
            : verifyKindIndexes(connection, kindIndexes, heldKindIndexes, plan.conditionColumns ?? [], disagree));
          return chain(collectColumns(0), () => chain(besides(), () =>
            chain(verifyIntervalChecks(connection, plan, disagree), () =>
              chain(verifyRulePrograms(connection, plan.table, plan.programs ?? [], disagree,
                { installed: dialect.capabilities.declaredSqlText !== true, undeclared: true }), () =>
                verifyDeclaredSql(connection, plan, disagree)))));
        }));
    })));
}

/**
 * The expression keys a declared index holds after its columns, on an engine
 * that keeps no CREATE text: each read back from the catalog as the server
 * deparses it and compared with the planned term (the dialect's
 * `readBack.indexKey`), under a deterministic collation — a nondeterministic one
 * (case-insensitive, say) would refuse values the model keys apart, and the
 * deparse of a key does not spell its collation.
 * @param {any} connection
 * @param {{ name: string, conforming: boolean }} have - the catalog's index
 * @param {{ columns: string[], terms: string[] }} want - the planned index
 * @param {(difference: string) => any} disagree
 * @returns {any} value-or-promise
 */
function verifyIndexTerms(connection, have, want, disagree) {
  const dialect = connection.dialect;
  return chain(connection.prepare(dialect.introspect.indexKeyColumns(have.name)), (statement) =>
    chain(statement.all([]), (keys) => {
      want.terms.forEach((planned, at) => {
        // the key's position holds an expression: the column check before this one compared it
        const key = keys[want.columns.length + at];
        if (typeof key?.term !== 'string') return disagree(`index '${have.name}' keys an expression it does not report`);
        const difference = dialect.readBack.indexKey(key.term, planned, have.conforming);
        if (difference !== null) disagree(`index '${have.name}' ${difference}`);
        if (key.deterministic === false || key.deterministic === 0)
          disagree(`index '${have.name}' keys ${key.term} under a nondeterministic collation, which refuses values the model keys apart`);
      });
      return null;
    }));
}

/**
 * The indexes beside a declared index that a table holds
 * ({@link kindIndexesOf}): each the plain B-tree, unique where the plan's
 * is, under the plan's condition, over exactly the keys the plan creates
 * it over, read back from the catalog.
 * @param {any} connection
 * @param {Map<string, any>} planned - by name
 * @param {any[]} rows - the table's catalog rows of those names
 * @param {any[]} conditionColumns - the members a condition may read
 * @param {(difference: string) => any} disagree
 * @returns {any} value-or-promise
 */
function verifyKindIndexes(connection, planned, rows, conditionColumns, disagree) {
  const dialect = connection.dialect;
  const step = (/** @type {number} */ i) => {
    if (i >= rows.length) return null;
    const row = rows[i];
    const name = String(row.name);
    const want = planned.get(name);
    if ((Number(row.uniq) !== 0) !== want.unique || (row.plain !== undefined && row.plain !== null && Number(row.plain) !== 1))
      disagree(`index '${name}' is not the plain${want.unique ? ' unique' : ''} B-tree the model creates beside '${want.of}'`);
    const predicate = row.predicate === null || row.predicate === undefined ? null : String(row.predicate);
    const condition = dialect.readBack.condition(predicate, want.where, conditionColumns, readsConforming(row));
    if (condition !== null) disagree(`index '${name}' ${condition}`);
    return chain(connection.prepare(dialect.introspect.indexKeyColumns(name)), (statement) =>
      chain(statement.all([]), (keys) => {
        const difference = keys.length !== want.keys.length ? `keys (${keys.map((key) => key.term ?? key.name).join(', ')})`
          : keys.map((key, at) => {
            const planKey = want.keys[at];
            if ('column' in planKey) return key.name === planKey.column ? null : `keys ${key.term ?? key.name} where the model keys ${planKey.column}`;
            if (key.name !== null && key.name !== undefined) return `keys ${key.name} where the model keys ${planKey.expression}`;
            if (typeof key.term !== 'string') return 'keys an expression it does not report';
            const difference = dialect.readBack.indexKey(key.term, planKey.expression, readsConforming(row));
            // a guarded path read the other way: a table whose container the model declared
            // the other way opens as it did, as its column does
            return difference === null || planKey.alternate === undefined
              || dialect.readBack.indexKey(key.term, planKey.alternate, readsConforming(row)) !== null ? difference : null;
          }).find((found) => found !== null) ?? null;
        if (difference !== null) disagree(`index '${name}' ${difference}`);
        return step(i + 1);
      }));
  };
  return step(0);
}

/**
 * The interval CHECKs an existing table must carry, on an engine that keeps
 * no CREATE text: each declared one present, validated, and read back as
 * the declaration through the one interval reader — text the reader does
 * not read is drift — and no CHECK the model does not declare beside them,
 * as the CREATE text comparison holds on SQLite. A collection declaring no
 * interval reads none of its table's CHECKs, as before.
 * @param {any} connection
 * @param {any} plan
 * @param {(difference: string) => never} disagree
 * @returns {any} value-or-promise
 */
function verifyIntervalChecks(connection, plan, disagree) {
  const dialect = connection.dialect;
  const intervals = plan.intervals ?? [];
  if (intervals.length === 0 || dialect.capabilities.declaredSqlText === true) return null;
  return chain(connection.prepare(dialect.introspect.checks(plan.table)), (statement) =>
    chain(statement.all([]), (rows) => {
      /** @type {Map<string, any>} */
      const stored = new Map(rows.map((row) => [String(row.name), row]));
      for (const interval of intervals) {
        const row = stored.get(interval.constraint);
        if (row === undefined) {
          disagree(`the model declares the interval '${interval.name}' as CHECK '${interval.constraint}', `
            + 'which the database does not have');
        }
        if (Number(row.validated) !== 1)
          disagree(`CHECK '${interval.constraint}' is not validated: the rows it holds were never checked against it`);
        const conforming = readsConforming(row);
        const read = readIntervalCheck(String(row.expression ?? ''), dialect.intervalSpelling(conforming));
        const same = read !== null && read.column === plan.docColumn && canonicalOf(read.span) === interval.span.canonical
          && read.start === interval.start && read.end === interval.end && read.maxDuration === interval.maxDuration;
        if (!same) {
          disagree(`CHECK '${interval.constraint}' is declared as\n  ${row.expression}\nand the model declares\n  ${interval.sql}`);
        }
      }
      for (const name of stored.keys()) {
        if (!intervals.some((interval) => interval.constraint === name))
          disagree(`the database has the CHECK '${name}', which the model does not declare`);
      }
      return null;
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
export function plannedExpression(dialect, plan, name) {
  const column = (plan.generated ?? []).find((/** @type {any} */ candidate) => candidate.name === name);
  if (column === undefined || column.stored === true || column.derive !== undefined) return undefined;
  return columnExpression(dialect, column);
}

/**
 * The expression one planned generated column is created with.
 * @param {any} dialect @param {any} column
 * @returns {string}
 */
export function columnExpression(dialect, column) {
  return column.expression ?? dialect.columnRead(dialect.quoteIdentifier(DOC_COLUMN), column);
}

/**
 * Whether a table built for the planned column `held` is one `wanted` accepts
 * as it is — it reads the member as `wanted` does, or as the other spelling a
 * table may hold for it (`alternate`: with the guard of a path that leaves a
 * container open, or without it). The guard names the kind of each digit step
 * (an index off an array, a name off an object), so a column read under the
 * guard of one kind is not one that `wanted` accepts when its step is the
 * other; an unguarded column names no kind and is accepted wherever the text
 * agrees. Meant for columns of a path the dialect guards (those carrying
 * `alternate`).
 * @param {any} dialect @param {any} held @param {any} wanted
 * @returns {boolean}
 */
export function acceptsColumn(dialect, held, wanted) {
  const text = columnExpression(dialect, held);
  return text === columnExpression(dialect, wanted) || text === wanted.alternate;
}

/**
 * The other expression a table may hold a planned generated column with: a
 * path the dialect guards is read off the document under the guard where the
 * schema leaves a container open and without it where the schema declares one,
 * and a table holds either (a model that changes how it declares the container
 * plans no change, and a table an earlier release created reads every such
 * column unguarded). Both open as they are.
 * @param {any} plan @param {string} name - the column
 * @returns {string | undefined}
 */
function alternateExpression(plan, name) {
  return (plan.generated ?? []).find((/** @type {any} */ candidate) => candidate.name === name)?.alternate;
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
 * The order tables can be created in: as declared, except that a table comes
 * after the tables it references (a foreign key's, a join table's endpoints),
 * which PostgreSQL requires to exist and SQLite does not. A table that
 * references itself needs no other; a cycle has no such order, and each table
 * of it is placed after the ones it reaches first (A and B referencing each
 * other, declared A then B, are created B then A), the walk being depth first.
 * A dialect that alters a table in place creates the cycle's tables without
 * the keys that close it and adds them afterwards (`planEntity`'s
 * `deferCycles`).
 * @param {string[]} names - in declaration order
 * @param {(name: string) => Iterable<string>} referencesOf
 * @returns {string[]}
 */
export function creationOrder(names, referencesOf) {
  const known = new Set(names);
  const placed = new Set();
  const order = [];
  const visit = (/** @type {string} */ name) => {
    if (placed.has(name)) return;
    placed.add(name);
    for (const other of referencesOf(name)) if (known.has(other)) visit(other);
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

/**
 * Whether the foreign key from `table` to `target` closes a cycle: the target
 * is another table that references `table` again, directly or through others.
 * A table that references itself closes none.
 * @param {string} table
 * @param {string} target
 * @param {any} entities - the full `explainMapping` result
 * @returns {boolean}
 */
function closesCycle(table, target, entities) {
  if (target === table) return false;
  const seen = new Set([target]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const fk of entities.entities[queue[i]]?.foreignKeys ?? []) {
      if (fk.references === table) return true;
      if (!seen.has(fk.references)) { seen.add(fk.references); queue.push(fk.references); }
    }
  }
  return false;
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
 * @param {{ deferCycles?: boolean, expressions?: Record<string, any> }} [options] - `deferCycles`: on a dialect
 *   that alters a table in place, leave the foreign keys that close a cycle
 *   out of the table and plan them as `deferredForeignKeys`, statements to
 *   run once every table of the cycle exists; `expressions`, the host's
 *   declared index functions an expression index calls (`openStore`'s)
 * @returns {{ table: string, createSql: string[], expected: any,
 *   columnNames: Set<string>, objects?: { name: string, what: string, docPath: string }[],
 *   programs?: any[], conditionColumns?: { name: string, physical: string, codec: string }[],
 *   declaredCalls?: Map<string, { index: string, term: string, docPath: string }>,
 *   deferredForeignKeys?: string[], autoKey?: string, keyAllocates?: boolean }}
 */
export function planEntity(name, entityMapping, entities, dialect, options = {}) {
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
  // a member's column is its own: not the table's document or row identity
  // column, not another member's as the engine compares names (SQLite folds
  // ASCII case) — refused at the member, never as the engine's own error
  const compare = dialect.name === 'sqlite' ? foldIdentifier : (/** @type {string} */ column) => column;
  const taken = new Map([[compare(DOC_COLUMN), { name: DOC_COLUMN, what: 'the document column' }]]);
  if (dialect.identityColumn !== undefined) taken.set(compare(dialect.identityColumn.name), { name: dialect.identityColumn.name, what: 'the row identity column' });
  for (const column of new Set([...entityMapping.columns.map((/** @type {any} */ c) => c.name), ...viaColumns])) {
    const holder = taken.get(compare(column));
    if (holder !== undefined) {
      throw new DbCompileError('JD0004', `the column for '${column}' would be named '${column}', the name of ${holder.what}`
        + (holder.name === column ? '' : ` ('${holder.name}': names are compared with ASCII case folded, as SQLite compares them)`)
        + ' — two columns of one table cannot share a name: rename the member', memberPath(column));
    }
    taken.set(compare(column), { name: column, what: `the column for '${column}'` });
  }
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

  // a foreign key that closes a cycle names a table that may not exist yet:
  // the table is created without it and the key is added once the cycle's
  // tables exist (the table still PLANS it, so the open verifies it)
  const deferred = options.deferCycles === true && dialect.capabilities.alterTableFull === true
    ? new Set(entityMapping.foreignKeys.filter((/** @type {any} */ fk) => closesCycle(name, fk.references, entities)).map((/** @type {any} */ fk) => fk.column))
    : new Set();
  const createSql = [dialect.ddl.createRelationalTable({
    table: name,
    columns: deferred.size === 0 ? columns
      : columns.map((column) => (deferred.has(column.name) ? { ...column, references: undefined } : column)),
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
  /** The CREATE of each index over a declared expression, by its SQL. @type {Map<string, { index: string, term: string, docPath: string }>} */
  const declaredCalls = new Map();
  (entityMapping.entityIndexes ?? []).forEach((/** @type {any} */ index, /** @type {number} */ i) => {
    const indexPath = `${entityPath}/indexes/${i}`;
    const indexName = `${name}_${index.name}`;
    refuseLongName(dialect, indexName, `index '${index.name}'`, `${indexPath}/name`);
    const terms = index.expression === undefined ? undefined
      : [entityIndexTerm(index, dialect, options.expressions, `${indexPath}/expression`)];
    const where = index.where === undefined ? undefined : indexCondition(index.where, conditionColumns, dialect, `${indexPath}/where`, unreadable);
    const declared = { name: indexName, unique: index.unique, columns: [...index.columns],
      ...(terms === undefined ? {} : { terms, reads: [...index.reads] }), ...(where === undefined ? {} : { where }) };
    objects.push({ name: indexName, what: `index '${index.name}'`, docPath: `${indexPath}/name`, rename: 'the index' });
    createSql.push(dialect.ddl.createIndex({ ...declared, table: name }));
    if (terms !== undefined) declaredCalls.set(createSql[createSql.length - 1], { index: index.name, term: terms[0], docPath: `${indexPath}/expression` });
    expectedIndexes.push(declared);
  });
  // the database rules' programs, created with the table and verified with it
  const programs = (entityMapping.invariants ?? []).some((/** @type {any} */ rule) => rule.enforcement === 'database')
    ? rulePrograms(name, entityMapping, entities, dialect, columns, conditionColumns) : [];
  for (const program of programs) createSql.push(program.sql);
  for (const program of new Set(programs.map((/** @type {any} */ item) => item.name)))
    objects.push({ name: program, what: `the rule program '${program}'`, docPath: `${entityPath}/invariants`, rename: 'the entity' });
  refuseNameCollisions(objects);

  // the key the database allocates, where its allocation is a property of the
  // column (`keyAllocates`, recorded when an existing table is verified, says
  // whether the table has it)
  const autoColumn = dialect.autoKeyType !== undefined && singleKey
    ? entityMapping.columns.find((/** @type {any} */ column) => column.key && column.auto === true) : undefined;

  return {
    table: name,
    createSql,
    columnNames: new Set(columns.map((column) => column.name)),
    ...(autoColumn === undefined ? {} : { autoKey: autoColumn.name }),
    expectedForeignKeys: expectedForeignKeysOf(columns),
    /** The statements that add the cycle's foreign keys, run after every table of the cycle exists. */
    deferredForeignKeys: columns.filter((column) => deferred.has(column.name))
      .map((column) => dialect.ddl.addForeignKey({ table: name, column: column.name, references: column.references })),
    objects,
    /** The CREATE of each index over a declared expression, by its SQL: what a
     * server that has no function the declaration names for those arguments refuses. */
    declaredCalls,
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
 * The key an entity index over a declared expression holds (MODEL-FORMAT
 * §7A): the host's function over the columns of the members it reads, each
 * read as the text a collection's expression reads (`textOperand`). Only an
 * engine whose functions live in the database (`catalogFunctions`) computes
 * one for every writer of the table; elsewhere it is `JD0004`, naming the
 * engine and the repair. The declarations are checked as a collection's are,
 * and the key must read back where the engine keeps no CREATE text.
 * @param {any} index - the mapping's entry @param {any} dialect
 * @param {Record<string, any> | undefined} declarations - the host's `expressions`
 * @param {string} docPath - the index's `expression` pointer
 * @returns {string}
 */
export function entityIndexTerm(index, dialect, declarations, docPath) {
  const members = index.reads.map((/** @type {string} */ member) => `'${modelPath([{ name: member }])}'`).join(', ');
  if (dialect.capabilities.catalogFunctions !== true) {
    throw new DbCompileError('JD0004', `index '${index.name}' over an expression reading ${members} cannot be kept on ${dialect.name}: `
      + 'the engine computes a declared function only on a connection that registered it, so every other writer of the '
      + 'table — a raw SQL client included — could no longer insert or delete a row. Index the member itself (path), '
      + 'declare the expression index on a collection, or keep the entity on PostgreSQL, whose server computes the '
      + "declaration's IMMUTABLE 'sql' function on every connection", docPath);
  }
  const expression = normalizeExpression(index.expression, docPath, declarations ?? {});
  const term = expressionSql(expression, dialect, { declarations: declarations ?? {}, registered: false, docPath,
    memberSql: (member) => dialect.textOperand(dialect.quoteIdentifier(/** @type {string[]} */ (memberNames(member))[0])) });
  if (dialect.readBack !== undefined && !dialect.readBack.expressionReads(term)) {
    throw new DbCompileError('JD0004', `index '${index.name}' keys ${term}, which the ${dialect.name} catalog would not read `
      + 'back exactly, so no open could verify it', docPath);
  }
  return term;
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
  // the primary key leads with the first column, so a read by the second —
  // one row's memberships from that side, the cascade from its entity —
  // seeks this index; a table an earlier release created has none, and
  // opens without it (`legacyAbsent`, see `verifyShape`)
  const index = { name: joinIndexName(dialect, tableName, join.right.column), unique: false, columns: [join.right.column] };
  const objects = [{ name: tableName, what: `the join table of '${join.left.entity}' and '${join.right.entity}'`, docPath,
    rename: 'the join table' }, ...ownObjects(dialect, tableName, columns, docPath),
  { name: index.name, what: `the index over '${join.right.column}' of the join table '${tableName}'`, docPath, rename: 'the join table' }];
  refuseNameCollisions(objects);
  return {
    table: tableName,
    createSql: [dialect.ddl.createRelationalTable({
      table: tableName,
      columns,
      compositeKey: [join.left.column, join.right.column],
    }), dialect.ddl.createIndex({ ...index, table: tableName })],
    objects,
    expectedForeignKeys: expectedForeignKeysOf(columns),
    expected: {
      columns: expectedColumnsOf(columns, legacyTypes, dialect),
      indexes: [{ ...index, legacyAbsent: true }],
    },
  };
}

/**
 * The name of a join table's index over its second key column:
 * `<table>_<column>`, as an entity's index over a column is named, or, where
 * that is longer than the engine keeps an identifier (PostgreSQL's 63 bytes),
 * `<table>_<hash>`, the table clipped at a character boundary to fit — a
 * table and a column that each fit never make a name the engine truncates.
 * @param {any} dialect @param {string} table @param {string} column
 * @returns {string}
 */
export function joinIndexName(dialect, table, column) {
  const natural = `${table}_${column}`;
  const limit = dialect.maxIdentifierBytes;
  if (!Number.isFinite(limit) || utf8ByteLength(natural) <= limit) return natural;
  const suffix = `_${hashContent(`${table}\u0000${column}`)}`;
  return clipToBytes(table, limit - suffix.length) + suffix;
}

/**
 * The longest prefix of `text` that is whole characters and at most `bytes`
 * bytes of UTF-8 — how an engine that bounds an identifier in bytes clips a
 * name it derives, so no character is split.
 * @param {string} text @param {number} bytes
 * @returns {string}
 */
export function clipToBytes(text, bytes) {
  let kept = '', used = 0;
  for (const character of text) {
    used += utf8ByteLength(character);
    if (used > bytes) break;
    kept += character;
  }
  return kept;
}

/** Plan explicit database-enforced persistence rules; never applies them. A
 * store-owned entity's programs are the ones its table is created and
 * verified with. A name too long for PostgreSQL becomes a short hash of its
 * table, so two tables can meet in one name: the plan refuses that rather
 * than install one table's program over the other's.
 * An entity index over an expression is planned with the table, so a model
 * that declares one takes the host's `expressions`, as `openStore` does.
 * @param {any} model @param {{ dialect: any, expressions?: Record<string, any> }} options @returns {any[]} */
export function planInvariants(model, options) {
  const mapping = explainMapping(model);
  const dialect = options.dialect;
  if (typeof dialect.invariantTriggers !== 'function') throw new DbCompileError('JD0005', 'this dialect cannot lower database invariants');
  const items = Object.entries(mapping.entities).flatMap(([name, entity]) => (entity.document === false
    ? dialect.invariantTriggers(entity, mapping, dialect)
    : planEntity(name, entity, mapping, dialect, { expressions: options.expressions }).programs ?? []));
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
