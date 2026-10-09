//@ts-check
/**
 * @file Navigation hops over ADOPTED tables: the tables exist before the
 * store opens, and every column declares a codec and a NULL policy. Two
 * worlds, one check, read by the SQLite and PostgreSQL tests and by the
 * Bun run, so a host cannot drift from the others unseen.
 *
 * The leaf world holds one column for each codec and each policy
 * (`reject`: NOT NULL; `absent`: a NULL is a member that is not there;
 * `null`: a NULL is a present `null`). A keyed hop that reaches no row —
 * a dangling key, a NULL key, a related row a profile hides — leaves its
 * member out, whatever its column's policy says of a NULL it does read.
 * The null-policy world correlates columns whose schema does not say
 * `null` but whose policy does: SQL pairs no NULL with a NULL where the
 * engine pairs a `null` with a `null`, so such a correlation is never
 * native.
 *
 * The engine answers over the documents the store holds (a `null`-policy
 * column reads back a present `null`, an `absent` one no member), and a
 * profile's mandatory predicate narrows the related rows it hides.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { compileJsonQuery } from '@jarenjs/json/query';

import { deepEquals } from './harness.js';

const KEY = { 'x-entity': { key: true } };

export const CODECS = Object.freeze(['integer', 'number', 'text', 'boolean', 'datetime']);
export const POLICIES = Object.freeze(['reject', 'absent', 'null']);
/** One column for each codec and each policy. */
export const COLUMNS = CODECS.flatMap((codec) => POLICIES.map((policy) => ({ name: `${codec}_${policy}`, codec, policy })));

/** @type {Record<string, any>} */
const BASE = {
  integer: { type: 'integer' }, number: { type: 'number' }, text: { type: 'string' },
  boolean: { type: 'boolean' }, datetime: { type: 'string', format: 'date-time' },
};
/** The schema of a column that holds `codec` under `policy`: only a `null` policy admits `null`. */
const schemaOf = (/** @type {string} */ codec, /** @type {string} */ policy) =>
  (policy === 'null' ? { ...BASE[codec], type: [BASE[codec].type, 'null'] } : BASE[codec]);

/** @type {Record<string, Record<string, string>>} */
const SQL_TYPE = {
  sqlite: { integer: 'INTEGER', number: 'REAL', text: 'TEXT', boolean: 'INTEGER', datetime: 'TEXT' },
  postgres: { integer: 'integer', number: 'double precision', text: 'text', boolean: 'boolean', datetime: 'text' },
};
/** @type {Record<string, any[]>} */
const VALUES = {
  integer: [5, 6, 7], number: [2.5, -1.25, 0.5], text: ['x', 'y', 'z'], boolean: [true, false, true],
  datetime: ['2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'],
};
/** A value as SQL spells it on the host. */
const sqlValue = (/** @type {string} */ kind, /** @type {string} */ codec, /** @type {any} */ value) => {
  if (value === null) return 'NULL';
  if (codec === 'boolean') return kind === 'sqlite' ? (value ? '1' : '0') : String(value);
  return typeof value === 'string' ? `'${value}'` : String(value);
};

/** A physical layout of one table, qualified by the schema where the host has one. */
const physical = (/** @type {string | undefined} */ schema, /** @type {string} */ table, /** @type {any} */ columns) =>
  ({ ...(schema === undefined ? {} : { schema }), table, columns });
const column = (/** @type {string} */ codec, /** @type {string} */ policy, name = '') => ({ name, codec, null: policy });

/**
 * The leaf world: `A` (key `aid`, one column for each codec and policy) is
 * what the outer rows of `B` reach through `aref`. Row 1 of `A` holds a
 * value in every column, row 2 only in the `reject` ones, row 3 another
 * value in every column. `B` holds a key that finds each, a dangling key
 * and a NULL key.
 * @param {'sqlite' | 'postgres'} kind @param {string} [schema]
 */
export function leafWorld(kind, schema = undefined) {
  const table = (/** @type {string} */ name) => (kind === 'postgres' ? `"${schema}"."${name}"` : `"${name}"`);
  const model = { $model: '0.1', entities: {
    A: { schema: { type: 'object', properties: { aid: { type: 'integer', ...KEY },
      ...Object.fromEntries(COLUMNS.map((c) => [c.name, schemaOf(c.codec, c.policy)])) } },
    physical: physical(schema, 'a', { aid: column('integer', 'reject', 'aid'),
      ...Object.fromEntries(COLUMNS.map((c) => [c.name, column(c.codec, c.policy, c.name)])) }) },
    B: { schema: { type: 'object', properties: { bid: { type: 'integer', ...KEY }, aref: { type: 'integer' } } },
    physical: physical(schema, 'b', { bid: column('integer', 'reject', 'bid'), aref: column('integer', 'absent', 'aref') }) },
  } };
  const row = (/** @type {number} */ key, /** @type {(c: { codec: string, policy: string }) => any} */ pick) =>
    `(${[String(key), ...COLUMNS.map((c) => sqlValue(kind, c.codec, pick(c)))].join(', ')})`;
  const statements = `CREATE TABLE ${table('a')}(aid ${SQL_TYPE[kind].integer} PRIMARY KEY, ${COLUMNS.map((c) =>
    `${c.name} ${SQL_TYPE[kind][c.codec]}${c.policy === 'reject' ? ' NOT NULL' : ''}`).join(', ')});
    CREATE TABLE ${table('b')}(bid ${SQL_TYPE[kind].integer} PRIMARY KEY, aref ${SQL_TYPE[kind].integer});
    INSERT INTO ${table('a')} VALUES ${[row(1, (c) => VALUES[c.codec][0]),
    row(2, (c) => (c.policy === 'reject' ? VALUES[c.codec][1] : null)), row(3, (c) => VALUES[c.codec][2])].join(', ')};
    INSERT INTO ${table('b')} VALUES (1, 1), (2, 2), (3, 9), (4, NULL), (5, 3)`;
  return { model, statements, entities: ['A', 'B'] };
}

/** A hop from a row of `B` to its row of `A`, returning `member`. @param {string} member */
const hopA = (member) => ({ $for: { a: '$.A[*]' }, $where: { $eq: ['$a.aid', '$it.aref'] }, $return: member });
const overB = (/** @type {any} */ extra, /** @type {any} */ ret) => [{ $for: { it: '$.B[*]' }, ...extra, $return: ret }];
/** A literal of each codec the first row of `A` holds. */
const LITERAL = { integer: 5, number: 2.5, text: 'x', boolean: true, datetime: '2024-01-01T00:00:00Z' };

/** The queries of the leaf world: every site a hop reads a column at, for every column. */
export function leafQueries() {
  /** @type {[string, any][]} */
  const queries = [];
  for (const { name, codec } of COLUMNS) {
    const member = `$a.${name}`;
    const literal = /** @type {Record<string, any>} */ (LITERAL)[codec];
    queries.push([`${name}: a leaf as an object member`, overB({}, { id: '$it.bid', v: hopA(member) })]);
    queries.push([`${name}: a leaf in an array`, overB({}, { id: '$it.bid', w: [hopA(member)] })]);
    queries.push([`${name}: a leaf as the whole return`, overB({}, hopA(member))]);
    queries.push([`${name}: a count of the leaf`, { $count: { $for: { it: '$.B[*]' }, $return: hopA(member) } }]);
    queries.push([`${name}: an existence`, overB({ $where: { $exists: hopA(member) } }, '$it.bid')]);
    queries.push([`${name}: an equality`, overB({ $where: { $eq: [hopA(member), literal] } }, '$it.bid')]);
    queries.push([`${name}: an inequality`, overB({ $where: { $ne: [hopA(member), literal] } }, '$it.bid')]);
    queries.push([`${name}: an order key`, overB({ $orderby: [{ $key: hopA(member), $dir: 'desc' }, { $key: '$it.bid' }] }, '$it.bid')]);
  }
  return queries;
}

/** The profile that hides row 1 of `A`, and what the engine sees of it. */
export const HIDING_PROFILE = { predicates: { A: { $ge: ['$it.aid', 2] } } };
export const hidesFirst = (/** @type {string} */ entity, /** @type {any} */ row) => entity !== 'A' || row.aid >= 2;

/**
 * The null-policy world: `C` and `D` correlate on columns whose schema
 * does not say `null` and whose policy does. `ref` is a nullable foreign
 * key of the same kind, so even a keyed hop reads a column that can hold
 * a `null`.
 * @param {'sqlite' | 'postgres'} kind @param {string} [schema]
 */
export function nullPolicyWorld(kind, schema = undefined) {
  const table = (/** @type {string} */ name) => (kind === 'postgres' ? `"${schema}"."${name}"` : `"${name}"`);
  const int = SQL_TYPE[kind].integer;
  const text = SQL_TYPE[kind].text;
  // the schema is the plain one: the policy alone says a NULL is a `null`
  const plain = (/** @type {string} */ codec) => ({ ...BASE[codec] });
  const model = { $model: '0.1', entities: {
    C: { schema: { type: 'object', properties: { cid: { type: 'integer', ...KEY }, ref: plain('integer'), tag: plain('text'), n: plain('integer') } },
      physical: physical(schema, 'c', { cid: column('integer', 'reject', 'cid'), ref: column('integer', 'null', 'ref'),
        tag: column('text', 'null', 'tag'), n: column('integer', 'null', 'n') }) },
    D: { schema: { type: 'object', properties: { did: { type: 'integer', ...KEY }, tag: plain('text'), n: plain('integer') } },
      physical: physical(schema, 'd', { did: column('integer', 'reject', 'did'), tag: column('text', 'null', 'tag'), n: column('integer', 'null', 'n') }) },
  } };
  const statements = `CREATE TABLE ${table('c')}(cid ${int} PRIMARY KEY, ref ${int}, tag ${text}, n ${int});
    CREATE TABLE ${table('d')}(did ${int} PRIMARY KEY, tag ${text}, n ${int});
    INSERT INTO ${table('c')} VALUES (1, 1, 'x', 1), (2, 2, NULL, NULL), (3, NULL, 'y', 3);
    INSERT INTO ${table('d')} VALUES (1, 'x', 1), (2, NULL, NULL), (3, 'z', 3)`;
  return { model, statements, entities: ['C', 'D'] };
}

/** The queries of the null-policy world: every hop site, correlated on a column that can hold a `null`. */
export function nullPolicyQueries() {
  const byTag = (/** @type {string} */ ret) => ({ $for: { d: '$.D[*]' }, $where: { $eq: ['$d.tag', '$c.tag'] }, $return: ret });
  const byNumber = (/** @type {string} */ ret) => ({ $for: { d: '$.D[*]' }, $where: { $eq: ['$d.n', '$c.n'] }, $return: ret });
  const byKey = (/** @type {string} */ ret) => ({ $for: { d: '$.D[*]' }, $where: { $eq: ['$d.did', '$c.ref'] }, $return: ret });
  const overC = (/** @type {any} */ extra, /** @type {any} */ ret) => [{ $for: { c: '$.C[*]' }, ...extra, $return: ret }];
  /** @type {[string, any][]} */
  const queries = [];
  for (const [label, hop] of /** @type {[string, (ret: string) => any][]} */ ([['tag', byTag], ['number', byNumber]])) {
    queries.push([`an existence by ${label}`, overC({ $where: { $exists: hop('$d') } }, '$c.cid')]);
    queries.push([`an emptiness by ${label}`, overC({ $where: { $empty: hop('$d') } }, '$c.cid')]);
    queries.push([`a comparison by ${label}`, overC({ $where: { $ge: [hop('$d.did'), 1] } }, '$c.cid')]);
    queries.push([`a count by ${label}`, overC({ $where: { $ge: [{ $count: hop('$d') }, 1] } }, '$c.cid')]);
    queries.push([`a count leaf by ${label}`, overC({}, { id: '$c.cid', k: { $count: hop('$d') } })]);
    queries.push([`an any by ${label}`, { $some: { c: '$.C[*]' }, $satisfies: { $exists: hop('$d') } }]);
    queries.push([`an every by ${label}`, { $every: { c: '$.C[*]' }, $satisfies: { $exists: hop('$d') } }]);
  }
  // the nullable column on the related side alone: `n` of `D` against the key of `C`
  const byInner = (/** @type {string} */ ret) => ({ $for: { d: '$.D[*]' }, $where: { $eq: ['$d.n', '$c.cid'] }, $return: ret });
  queries.push(['an existence by a nullable column of the related entity', overC({ $where: { $exists: byInner('$d') } }, '$c.cid')]);
  queries.push(['a count by a nullable column of the related entity', overC({ $where: { $ge: [{ $count: byInner('$d') }, 1] } }, '$c.cid')]);
  queries.push(['a leaf by a nullable key', overC({}, { id: '$c.cid', t: byKey('$d.tag') })]);
  queries.push(['an order key by a nullable key', overC({ $orderby: [{ $key: byKey('$d.did') }, { $key: '$c.cid' }] }, '$c.cid')]);
  queries.push(['an existence by a nullable key', overC({ $where: { $exists: byKey('$d') } }, '$c.cid')]);
  return queries;
}

/**
 * Open a store over the tables of a world, created first on the host.
 * @param {{ kind: 'sqlite', driver: any } | { kind: 'postgres', admin: any, pool: any, schema: string }} host
 * @param {(kind: 'sqlite' | 'postgres', schema?: string) => { model: any, statements: string }} world
 * @returns {Promise<{ store: any, close: () => Promise<void> }>}
 */
export async function openAdopted(host, world) {
  if (host.kind === 'postgres') {
    const built = world('postgres', host.schema);
    await host.admin.query(built.statements);
    const store = await openStore(built.model, { driver: postgresDriver(host.pool, { schema: host.schema }), adopt: true });
    return { store, close: () => store.close() };
  }
  const built = world('sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'jaren-adopted-hops-'));
  const path = join(dir, 'adopted.sqlite');
  const db = await host.driver.open(path);
  db.exec(built.statements);
  db.close();
  const store = await openStore(built.model, { driver: host.driver, path, adopt: true });
  return { store, close: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Hold a store to the engine: every query answers as the engine answers
 * over the documents the store holds — natively where it plans native,
 * under `strict`, and in the engine with `pushdown: false` — raising the
 * engine's code where the engine raises.
 * @param {any} store
 * @param {string[]} entities
 * @param {[string, any][]} queries
 * @param {{ profile?: any, visible?: (entity: string, row: any) => boolean }} [options]
 * @returns {Promise<{ native: number, problems: string[], planned: Map<string, { mode: string, reason: string | null }> }>}
 */
export async function checkAdoptedHops(store, entities, queries, options = {}) {
  const { profile, visible = () => true } = options;
  /** @type {Record<string, any[]>} */
  const held = {};
  for (const entity of entities) {
    const rows = await store.execute([{ $for: { x: `$.${entity}[*]` }, $return: '$x' }]);
    held[entity] = rows.filter((/** @type {any} */ row) => visible(entity, row));
  }
  const call = profile === undefined ? {} : { profile };
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, { mode: string, reason: string | null }>} */
  const planned = new Map();
  let native = 0;
  for (const [name, query] of queries) {
    /** @type {any} */
    let expected;
    let expectedCode = null;
    try { expected = compileJsonQuery(query)(structuredClone(held)); }
    catch (error) { expectedCode = /** @type {any} */ (error).code ?? String(error); }
    const explained = await store.explain(query, call);
    const isNative = explained.mode === 'native';
    planned.set(name, { mode: explained.mode, reason: isNative ? null : reasonId(explained.reasons[0].reason) });
    if (isNative) native++;
    /** @param {{ strict?: boolean, pushdown?: boolean }} extra */
    const answer = async (extra) => {
      try { return { value: await store.execute(query, { ...call, ...extra }), code: null }; }
      catch (error) { return { value: undefined, code: /** @type {any} */ (error).code ?? String(error) }; }
    };
    const agrees = (/** @type {{ value: any, code: string | null }} */ got) => (expectedCode !== null || got.code !== null
      ? expectedCode === got.code : deepEquals(got.value, expected));
    const show = (/** @type {{ value: any, code: string | null }} */ got) => got.code ?? JSON.stringify(got.value);
    const planNative = await answer(isNative ? { strict: true } : {});
    if (!agrees(planNative)) {
      problems.push(`${name} [${explained.mode}]: store ${show(planNative)}, engine ${expectedCode ?? JSON.stringify(expected)}`);
    }
    const residual = await answer({ pushdown: false });
    if (!agrees(residual)) problems.push(`${name} [residual]: store ${show(residual)}, engine ${expectedCode ?? JSON.stringify(expected)}`);
  }
  return { native, problems, planned };
}
