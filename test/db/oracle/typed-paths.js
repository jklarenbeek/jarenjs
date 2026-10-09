//@ts-check
/**
 * @file What the corpus group of typed scalar path comparisons plans to
 * on each kind of host, and the check that holds a store to it: the
 * SQLite and PostgreSQL tests and the Bun run read the same table, so a
 * host cannot drift from the others unseen.
 *
 * A case plans native with no user function everywhere, except the shapes
 * the group marks. `stays` names the reason the planner refuses a shape
 * with (an operand the schema does not type as a scalar, a `$get` under a
 * member it does not type as an object): a host with the user-function
 * hatch (`node:sqlite`) answers it natively through a function, a host
 * without one runs the document in the engine and names the reason.
 * `unspellable` marks a member name the SQLite path grammar cannot carry,
 * which both SQLite drivers run in the engine under the dialect's reason.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

import { loadGroups, runCase } from './harness.js';

export const TYPED_PATHS_GROUP = 'typed scalar path comparisons';

/** @returns {any} the group, as the corpus loader reads it */
export function typedPathsGroup() {
  const group = loadGroups().find((entry) => entry.group === TYPED_PATHS_GROUP);
  if (group === undefined) throw new Error(`no corpus group is named '${TYPED_PATHS_GROUP}'`);
  return group;
}

/**
 * The plan a case is expected to have on a host: `node` (the SQLite
 * driver whose connection registers user functions), `bare` (a SQLite
 * driver with none: `bun:sqlite`) or `pg`.
 * @param {{ stays?: string, unspellable?: boolean }} kase
 * @param {'node' | 'bare' | 'pg'} host
 * @returns {{ mode: 'native' | 'set', udf: boolean, reason?: string }}
 */
export function planFor(kase, host) {
  if (kase.stays !== undefined) {
    return host === 'node' ? { mode: 'native', udf: true } : { mode: 'set', udf: false, reason: kase.stays };
  }
  if (kase.unspellable === true && host !== 'pg') return { mode: 'set', udf: false, reason: 'bind.path' };
  return { mode: 'native', udf: false };
}

/**
 * Hold one opened collection to the table: every case plans as expected
 * and answers as the engine does, native and forced to the residual.
 * @param {any} collection
 * @param {any} group
 * @param {'node' | 'bare' | 'pg'} host
 * @param {string} side - for the messages
 * @returns {Promise<string[]>} one message for each case that does not
 */
export async function checkTypedPaths(collection, group, host, side) {
  /** @type {string[]} */
  const failures = [];
  for (const kase of group.cases) {
    const want = planFor(kase, host);
    const label = `${host} ${side}: ${kase.name}`;
    const explained = await collection.explain(kase.query,
      kase.externals === undefined ? undefined : { externals: kase.externals });
    const got = { mode: explained.mode, udf: explained.udfs.length > 0 };
    if (got.mode !== want.mode || got.udf !== want.udf)
      failures.push(`${label}: plans ${got.mode}${got.udf ? ' with a function' : ''}, wanted ${want.mode}${want.udf ? ' with a function' : ''}`);
    else if (want.reason !== undefined) {
      const reason = reasonId(explained.residual.reasons[0].reason);
      if (reason !== want.reason) failures.push(`${label}: names ${reason}, wanted ${want.reason}`);
      // strict mode refuses what stays with the engine, by that reason
      const strict = await (async () => collection.execute(kase.query, { strict: true }))().then(() => null, (error) => error);
      if (strict?.code !== 'JD0010' || !strict.message.includes(explained.residual.reasons[0].reason))
        failures.push(`${label}: strict mode answers ${strict === null ? 'a result' : `${strict.code}: ${strict.message}`}`);
    }
    for (const mode of /** @type {const} */ (['native', 'residual'])) {
      const divergence = await runCase(collection, group.documents, kase, mode);
      if (divergence !== null) {
        failures.push(`${label} [${mode}]: the engine answers ${JSON.stringify(divergence.expected)}, `
          + `the store ${JSON.stringify(divergence.actual)}`);
      }
    }
  }
  return failures;
}

// ————— Physical columns whose NULL policy reads a NULL as a present `null` —————

const KEY = { 'x-entity': { key: true } };

/**
 * One adopted table `t` whose schema omits `null` while every column's
 * policy says a NULL is a present `null` (a text, an integer and a second
 * text; row 1 holds a NULL in all three), and one table `e` a native
 * mutation targets. The engine equates `null` with `null` where SQL pairs
 * no NULL with a NULL, so a comparison of two such columns that the
 * database answered would disagree with it.
 * @param {'sqlite' | 'postgres'} kind @param {string} [schema]
 */
export function nullPolicyWorld(kind, schema = undefined) {
  const table = (/** @type {string} */ name) => (kind === 'postgres' ? `"${schema}"."${name}"` : `"${name}"`);
  const int = kind === 'postgres' ? 'integer' : 'INTEGER';
  const text = kind === 'postgres' ? 'text' : 'TEXT';
  const physical = (/** @type {string} */ name, /** @type {any} */ columns) =>
    ({ ...(schema === undefined ? {} : { schema }), table: name, columns });
  const column = (/** @type {string} */ name, /** @type {string} */ codec, /** @type {string} */ policy) => ({ name, codec, null: policy });
  const model = { $model: '0.1', entities: {
    T: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', ...KEY },
      a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'string' } } },
    physical: physical('t', { id: column('id', 'integer', 'reject'), a: column('a', 'text', 'null'),
      b: column('b', 'integer', 'null'), c: column('c', 'text', 'null') }) },
    E: { schema: { type: 'object', required: ['id', 'payload'], properties: { id: { type: 'integer', ...KEY }, payload: { type: 'string' } } },
    physical: physical('e', { id: column('id', 'integer', 'reject'), payload: column('payload', 'text', 'reject') }) },
  } };
  const statements = `CREATE TABLE ${table('t')}(id ${int} PRIMARY KEY, a ${text}, b ${int}, c ${text});
    CREATE TABLE ${table('e')}(id ${int} PRIMARY KEY, payload ${text} NOT NULL);
    INSERT INTO ${table('t')} VALUES (1, NULL, NULL, NULL), (2, 'x', 3, 'x'), (3, NULL, 5, NULL), (4, 'y', NULL, 'y');
    INSERT INTO ${table('e')} VALUES (1, 'p1'), (2, 'p2')`;
  return { model, statements };
}

/**
 * Open a store over those tables, created first on the host.
 * @param {{ kind: 'sqlite', driver: any } | { kind: 'postgres', admin: any, pool: any, schema: string }} host
 * @returns {Promise<{ store: any, close: () => Promise<void> }>}
 */
export async function openNullPolicy(host) {
  if (host.kind === 'postgres') {
    const built = nullPolicyWorld('postgres', host.schema);
    await host.admin.query(built.statements);
    const store = await openStore(built.model, { driver: postgresDriver(host.pool, { schema: host.schema }), adopt: true });
    return { store, close: () => store.close() };
  }
  const built = nullPolicyWorld('sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'jaren-null-policy-'));
  const path = join(dir, 'adopted.sqlite');
  const db = await host.driver.open(path);
  db.exec(built.statements);
  db.close();
  const store = await openStore(built.model, { driver: host.driver, path, adopt: true });
  return { store, close: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Hold a store over {@link nullPolicyWorld} to the engine: a comparison of
 * two columns of different families stays with the engine under
 * `predicate.joinTerritory` and answers as it does (row 1 holds a `null` in
 * both columns, which the engine equates), and a native mutation whose
 * predicate compares two such members is refused (`JD0038`) and removes no row.
 * @param {any} store
 * @returns {Promise<string[]>} one message for each check that does not hold
 */
export async function checkNullPolicy(store) {
  /** @type {string[]} */
  const failures = [];
  const query = (/** @type {any} */ where) => ({ $for: { t: '$.T[*]' }, $where: where, $return: '$t.id' });
  const answer = (/** @type {any} */ where, /** @type {any} */ options) =>
    (async () => store.execute(query(where), options))().then((value) => JSON.stringify(value), (error) => `throws ${error.code}`);
  for (const [name, where, expected] of /** @type {[string, any, string | undefined][]} */ ([
    ['an equality of a text and an integer', { $eq: ['$t.a', '$t.b'] }, '1'],
    ['a difference of a text and an integer', { $ne: ['$t.a', '$t.b'] }, '[2,3,4]'],
    ['an order of a text and an integer', { $lt: ['$t.a', '$t.b'] }, undefined],
    ['an order the other way', { $ge: ['$t.b', '$t.a'] }, undefined],
  ])) {
    const explained = await store.explain(query(where));
    if (explained.mode !== 'set' || reasonId(explained.residual.reasons[0].reason) !== 'predicate.joinTerritory')
      failures.push(`${name}: plans ${explained.mode}, wanted set under predicate.joinTerritory`);
    const native = await answer(where);
    const engine = await answer(where, { pushdown: false });
    if (native !== engine) failures.push(`${name}: the store answers ${native}, the engine ${engine}`);
    if (expected !== undefined && engine !== expected) failures.push(`${name}: the engine answers ${engine}, wanted ${expected}`);
  }
  for (const where of [{ $eq: ['$it.id', '$it.payload'] }, { $lt: ['$it.id', '$it.payload'] }]) {
    const refused = await (async () => store.entity('E').mutate({ op: 'delete', where, returning: ['id'] }))()
      .then(() => null, (error) => error.code);
    if (refused !== 'JD0038') failures.push(`a mutation deleting where ${JSON.stringify(where)} answers ${refused ?? 'a result'}, wanted JD0038`);
  }
  const left = await store.execute({ $for: { e: '$.E[*]' }, $return: '$e.id' });
  if (JSON.stringify(left) !== '[1,2]') failures.push(`the mutations removed rows: ${JSON.stringify(left)} remain`);
  return failures;
}
