//@ts-check
/**
 * @file The differential-oracle harness. Each case runs the SAME query
 * document through genuinely independent sides — the in-memory engine
 * over the raw documents, and the store's translator over the same
 * documents freshly inserted, both as the group declares its indexes
 * and with every index removed — and the results must be identical
 * (deep equality: member order insignificant, array order
 * significant); when the engine THROWS, the store must throw the same
 * code. The harness never compiles the translator's output — both
 * sides share only the query document, which is what makes agreement
 * evidence.
 *
 * Coverage is measured, not asserted: {@link recordConstructs} tallies
 * which grammar constructs each query exercises against
 * {@link CONSTRUCT_ROSTER}, and the table is printed so an uncovered
 * construct is an open finding, not a silent gap.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileJsonQuery } from '@jarenjs/json/query';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The default oracle collection schema: typed members the pushdown
 * can promote, untyped members (`u`, `o`, anything else) it cannot. */
export const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    n: { type: 'integer' },
    s: { type: 'string' },
    f: { type: 'number' },
    b: { type: 'boolean' },
    o: { type: 'object', properties: { k: { type: 'integer' } } },
  },
};
export const DEFAULT_INDEXES = [
  { name: 'by_n', path: '$.n' },
  { name: 'by_s', path: '$.s' },
];

/**
 * Load every corpus group file (one JSON file per construct group).
 * @returns {{ group: string, schema?: any, indexes?: any[],
 *   documents: any[], cases: { name: string, query: any,
 *   externals?: any }[] }[]}
 */
export function loadGroups() {
  const dir = path.join(__dirname, 'corpus');
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

/**
 * The three sides every case is run through. `resident` is the
 * in-memory engine over the raw documents — the reference answer.
 * `indexed` is the store as the group declares it; `unindexed` is the
 * same store with every declared index removed, so the same documents
 * reach a plan that has no generated column to read and must translate
 * over the stored document instead. Agreement across all three is what
 * says a promotion is a promotion and not a change of meaning.
 */
export const ORACLE_SIDES = /** @type {const} */ (['indexed', 'unindexed']);

/**
 * Open a fresh store seeded with a group's documents. `side` chooses
 * whether the group's declared indexes exist: an unindexed store plans
 * the same documents with no generated column to read.
 * @param {any} group
 * @param {any} [driver]
 * @param {'indexed' | 'unindexed'} [side]
 * @returns {Promise<{ store: any, collection: any }>}
 */
export async function storeForGroup(group, driver = nodeDriver(), side = 'indexed') {
  const model = {
    $model: '0.1',
    collections: {
      rows: {
        schema: group.schema ?? DEFAULT_SCHEMA,
        key: null,
        identity: 'integer',
        indexes: side === 'unindexed' ? [] : (group.indexes ?? DEFAULT_INDEXES),
      },
    },
  };
  const store = await openStore(model, { driver });
  const collection = store.collection('rows');
  for (const document of group.documents) await collection.insert(document);
  return { store, collection };
}

/**
 * The entity variant: load every relations corpus group. Each group
 * carries its own `model` (entities with explicit keys, so the JSON
 * documents ARE the stored documents) and `documents` as the
 * multi-entity root object the engine side queries directly.
 * @returns {{ group: string, model: any,
 *   documents: Record<string, any[]>, cases: { name: string,
 *   query: any, externals?: any }[] }[]}
 */
export function loadRelationGroups() {
  const dir = path.join(__dirname, 'relations');
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

/**
 * Open a fresh store for a relations group and create every entity
 * document, parents before children (the corpus lists entities in
 * dependency order — real foreign keys refuse orphans).
 * @param {any} group
 * @param {any} [driver]
 * @param {'indexed' | 'unindexed'} [side]
 * @returns {Promise<{ store: any }>}
 */
export async function storeForEntityGroup(group, driver = nodeDriver(), side = 'indexed') {
  const store = await openStore(side === 'unindexed' ? withoutIndexes(group.model) : group.model,
    { driver });
  for (const name of Object.keys(group.documents)) {
    const set = store.entity(name);
    for (const document of group.documents[name]) await set.create(document);
  }
  // a group may declare MEMBERSHIPS: join rows, written the one way a
  // join table is written — through the unit of work, never as an
  // entity, because a join-table root is read-only (§10.7)
  for (const [table, rows] of Object.entries(group.memberships ?? {})) {
    for (const row of rows) {
      const [owner, member] = joinSidesOf(group.model, table);
      store.entity(owner.entity).link(row[owner.column], owner.member, row[member.column]);
    }
    await store.saveChanges();
  }
  return { store };
}

/**
 * Which entity declares the many-to-many member a join table serves,
 * and which column of a join row belongs to each side — read from the
 * group's own model, so a corpus writes memberships by naming the two
 * key columns and nothing else.
 * @param {any} model
 * @param {string} table
 * @returns {[{ entity: string, member: string, column: string },
 *   { entity: string, column: string }]}
 */
function joinSidesOf(model, table) {
  for (const [name, entity] of Object.entries(model.entities ?? {})) {
    for (const [member, property] of Object.entries(entity.schema?.properties ?? {})) {
      const relation = /** @type {any} */ (property)['x-entity']?.relation;
      if (relation === undefined || relation.many !== true || relation.via !== undefined) continue;
      const [a, b] = [name, relation.to].sort();
      if (`${a}_${b}` !== table) continue;
      return [{ entity: name, member, column: `${name}_key` },
        { entity: relation.to, column: `${relation.to}_key` }];
    }
  }
  throw new Error(`oracle: no declared many-to-many member serves the join table '${table}'`);
}

/**
 * The same model with every declared index dropped: an entity's
 * `x-entity.index` and a collection's `indexes` list. A declared scalar
 * property is a COLUMN whether or not it is indexed (MODEL-FORMAT
 * §9.3), so this changes what the database can seek through, not what
 * the planner can address — which is exactly the difference the third
 * oracle side is there to prove immaterial to the answer.
 * @param {any} model
 * @returns {any}
 */
function withoutIndexes(model) {
  const stripped = structuredClone(model);
  for (const entity of Object.values(stripped.entities ?? {})) {
    for (const property of Object.values(/** @type {any} */ (entity).schema?.properties ?? {})) {
      const declared = /** @type {any} */ (property)['x-entity'];
      if (declared?.index !== undefined) delete declared.index;
    }
  }
  for (const collection of Object.values(stripped.collections ?? {}))
    /** @type {any} */ (collection).indexes = [];
  return stripped;
}

/**
 * Run one entity case through both sides: the in-memory engine over
 * the multi-entity root object, the store's entity translator over the
 * same documents created through the entity sets.
 * @param {any} store - the seeded store
 * @param {Record<string, any[]>} documents - the multi-entity root
 * @param {{ query: any, externals?: any }} kase
 * @param {'native' | 'residual'} mode
 * @returns {Promise<null | { expected: any, actual: any, sql?: string }>}
 */
export async function runEntityCase(store, documents, kase, mode) {
  let expected;
  let expectedCode = null;
  try {
    expected = compileJsonQuery(kase.query)(structuredClone(documents), kase.externals);
  }
  catch (error) {
    expectedCode = /** @type {any} */ (error).code ?? String(error);
  }

  let actual;
  let actualCode = null;
  const options = {
    externals: kase.externals,
    pushdown: mode === 'residual' ? false : undefined,
  };
  try {
    actual = await Promise.resolve(store.execute(kase.query, options));
  }
  catch (error) {
    actualCode = /** @type {any} */ (error).code ?? String(error);
  }

  if (expectedCode !== null || actualCode !== null) {
    if (expectedCode === actualCode) return null;
    return { expected: `throws ${expectedCode}`, actual: `throws ${actualCode}` };
  }
  if (deepEquals(actual, expected)) return null;
  let sql;
  try {
    sql = (await store.explain(kase.query, options)).sql;
  }
  catch {
    sql = '<explain failed>';
  }
  return { expected, actual, sql };
}

/**
 * Run one case through both sides and assert agreement. Returns the
 * divergence report instead of throwing, so the caller can attach the
 * case name and mode.
 * @param {any} collection - the seeded store collection
 * @param {any[]} documents - the group's raw documents
 * @param {{ query: any, externals?: any }} kase
 * @param {'native' | 'residual'} mode
 * @returns {Promise<null | { expected: any, actual: any, sql?: string }>}
 */
export async function runCase(collection, documents, kase, mode) {
  let expected;
  let expectedCode = null;
  try {
    expected = compileJsonQuery(kase.query)(structuredClone(documents), kase.externals);
  }
  catch (error) {
    expectedCode = /** @type {any} */ (error).code ?? String(error);
  }

  let actual;
  let actualCode = null;
  const options = {
    externals: kase.externals,
    pushdown: mode === 'residual' ? false : undefined,
  };
  try {
    actual = await Promise.resolve(collection.execute(kase.query, options));
  }
  catch (error) {
    actualCode = /** @type {any} */ (error).code ?? String(error);
  }

  if (expectedCode !== null || actualCode !== null) {
    if (expectedCode === actualCode) return null;
    return { expected: `throws ${expectedCode}`, actual: `throws ${actualCode}` };
  }
  if (deepEquals(actual, expected)) return null;
  let sql;
  try {
    sql = (await collection.explain(kase.query, options)).sql;
  }
  catch {
    sql = '<explain failed>';
  }
  return { expected, actual, sql };
}

/**
 * Deep JSON equality: member order insignificant, array order
 * significant, numbers by value.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function deepEquals(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
    && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEquals(a[key], b[key]));
  }
  return false;
}

/**
 * The construct roster the coverage table reports against: the
 * pushdown table's rows plus the deliberate residuals.
 */
export const CONSTRUCT_ROSTER = [
  '$eq', '$ne', '$lt', '$le', '$gt', '$ge',
  '$and', '$or', '$not',
  '$exists', '$empty',
  '$starts-with', '$ends-with', '$contains', '$match',
  '$orderby', '$subsequence',
  '$count', '$sum', '$avg', '$min', '$max',
  '$let', '$for', '$return',
  'external', 'null-literal', 'boolean-literal', 'cross-type',
  'object-return', 'array-return', 'quantifier',
];

/**
 * Tally the constructs one query document exercises.
 * @param {any} query
 * @param {Map<string, number>} tally
 */
export function recordConstructs(query, tally) {
  const bump = (name) => tally.set(name, (tally.get(name) ?? 0) + 1);
  const walk = (node, context) => {
    if (Array.isArray(node)) {
      if (context === '$return') bump('array-return');
      node.forEach((item) => walk(item, null));
      return;
    }
    if (typeof node === 'string') {
      if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(node) && node !== '$') bump('external');
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (CONSTRUCT_ROSTER.includes(key)) bump(key);
      if (key === '$every' || key === '$some' || key === '$satisfies') bump('quantifier');
      if ((key === '$eq' || key === '$ne') && Array.isArray(node[key])) {
        if (node[key].includes(null)) bump('null-literal');
        if (node[key].some((v) => typeof v === 'boolean')) bump('boolean-literal');
      }
      if (/^\$(eq|ne|lt|le|gt|ge)$/.test(key) && Array.isArray(node[key])) {
        // the corpus convention: `.n`/`.f`/`.o.k` are numeric members,
        // `.s` is a string member — a literal of the other type is the
        // cross-type category
        const [left, right] = node[key];
        const pathOf = (v) => (typeof v === 'string' && v.startsWith('$it') ? v : null);
        const litOf = (v) => (typeof v !== 'string' || !v.startsWith('$') ? v : undefined);
        const p2 = pathOf(left) ?? pathOf(right);
        const lit = pathOf(left) !== null ? litOf(right) : litOf(left);
        if (p2 !== null && lit !== undefined) {
          const numeric = /\.(n|f|k)$/.test(p2);
          const stringy = /\.s$/.test(p2);
          if ((numeric && typeof lit === 'string') || (stringy && typeof lit === 'number'))
            bump('cross-type');
        }
      }
      if (key === '$return' && node[key] !== null && typeof node[key] === 'object'
        && !Array.isArray(node[key])) bump('object-return');
      walk(node[key], key);
    }
  };
  walk(query, null);
}

/**
 * Render the coverage table and the missing list.
 * @param {Map<string, number>} tally
 * @returns {{ table: string, missing: string[] }}
 */
export function coverageTable(tally) {
  const missing = CONSTRUCT_ROSTER.filter((name) => !tally.has(name));
  const rows = CONSTRUCT_ROSTER
    .map((name) => `${name.padEnd(16)} ${String(tally.get(name) ?? 0).padStart(4)}`);
  return { table: rows.join('\n'), missing };
}
