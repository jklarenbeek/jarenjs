//@ts-check
/**
 * @file What a store profile's predicate costs a point read (MODEL-FORMAT
 * §8): nothing in the database. A profiled `get` — collection or entity —
 * runs the same statement a store with no profile runs, and that statement is a key seek, not a
 * scan: the predicate is judged on the one row the seek returns.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';

const url = process.env.JAREN_PG_URL;

const MODEL = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } }, key: '/id' },
  },
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, tenant: { type: 'string' } } } },
  },
};
const BY_TENANT = { $eq: ['$it.tenant', '$tenant'] };
const PROFILE = { externals: ['tenant'], predicates: { docs: BY_TENANT, User: BY_TENANT } };

/**
 * A prepared statement that records its text each time it runs; a statement
 * prepared asynchronously is wrapped once it settles.
 * @param {any} statement @param {string} sql @param {{ sql: string[] }} record
 * @returns {any}
 */
function ranAs(statement, sql, record) {
  if (typeof statement?.then === 'function')
    return statement.then((/** @type {any} */ made) => ranAs(made, sql, record));
  const descriptors = Object.getOwnPropertyDescriptors(statement);
  for (const name of ['get', 'all', 'run', 'iterate']) {
    const run = statement[name];
    if (typeof run !== 'function') continue;
    descriptors[name] = { enumerable: true, value: (/** @type {any[]} */ ...args) => {
      record.sql.push(sql);
      return run.apply(statement, args);
    } };
  }
  return Object.freeze(Object.defineProperties({}, descriptors));
}

/**
 * A connection, or a scope a connection hands a callback, whose statements
 * record their text each time they run — and whose callbacks are handed a
 * recording scope in turn.
 * @param {any} target @param {{ sql: string[] }} record
 * @returns {any}
 */
function recordingScope(target, record) {
  const descriptors = Object.getOwnPropertyDescriptors(target);
  descriptors.prepare = { enumerable: true, value: (/** @type {string} */ sql, /** @type {any} */ metadata) =>
    ranAs(target.prepare(sql, metadata), sql, record) };
  for (const name of ['transaction', 'exclusively', 'shared']) {
    const open = target[name];
    if (typeof open !== 'function') continue;
    descriptors[name] = { enumerable: true, value: (/** @type {any} */ fn, /** @type {any[]} */ ...rest) =>
      open.call(target, (/** @type {any} */ scope, /** @type {any[]} */ ...more) =>
        fn(scope !== null && typeof scope === 'object' ? recordingScope(scope, record) : scope, ...more), ...rest) };
  }
  return Object.freeze(Object.defineProperties({}, descriptors));
}

/**
 * A driver whose connections record every statement they run.
 * @param {any} driver @param {{ sql: string[], connection: any }} record
 */
function recording(driver, record) {
  return Object.freeze({
    ...driver,
    open: async (/** @type {any} */ path, /** @type {any} */ options) => {
      const connection = await driver.open(path, options);
      record.connection = connection;
      return recordingScope(connection, record);
    },
  });
}

/**
 * The statements one store's point reads run, and what they answer.
 * @param {any} driver - a driver whose connections record what they run
 * @param {{ sql: string[] }} record - where they record it
 * @param {any} profile - `undefined` for a store with none
 */
async function pointReads(driver, record, profile) {
  const store = await openStore(MODEL, { driver, ...(profile === undefined ? {} : { profile }) });
  try {
    await store.collection('docs').insert({ id: 'a1', tenant: 'a' });
    await store.collection('docs').insert({ id: 'b1', tenant: 'b' });
    await store.entity('User').create({ id: 1, tenant: 'a' });
    await store.entity('User').create({ id: 2, tenant: 'b' });
    const options = { externals: { tenant: 'a' } };
    record.sql.length = 0;
    const collection = await store.collection('docs').get('b1', options);
    const collectionSql = [...record.sql];
    record.sql.length = 0;
    const entity = await store.entity('User').asNoTracking().get(2, options);
    return { collection, entity, collectionSql, entitySql: [...record.sql] };
  }
  finally { await store.close(); }
}

/**
 * The profiled store's point reads hide the other tenant's rows and run
 * one statement each, the text a store with no profile runs.
 * @param {any} profiled @param {any} bare
 */
function assertSameSeek(profiled, bare) {
  assert.strictEqual(profiled.collection, undefined);
  assert.strictEqual(profiled.entity, undefined);
  assert.deepStrictEqual(bare.collection, { id: 'b1', tenant: 'b' });
  assert.deepStrictEqual(bare.entity, { id: 2, tenant: 'b' });
  assert.strictEqual(profiled.collectionSql.length, 1);
  assert.strictEqual(profiled.entitySql.length, 1);
  assert.deepStrictEqual(profiled.collectionSql, bare.collectionSql);
  assert.deepStrictEqual(profiled.entitySql, bare.entitySql);
  assert.doesNotMatch(profiled.collectionSql[0], /tenant/);
}

describe('a profiled point read stays a key seek', () => {
  it('runs the statement a store with no profile runs, and SQLite plans it as a key search', async () => {
    /** @type {{ sql: string[], connection: any }} */
    const record = { sql: [], connection: null };
    const profiled = await pointReads(recording(nodeDriver(), record), record, PROFILE);
    const bare = await pointReads(recording(nodeDriver(), record), record, undefined);
    assertSameSeek(profiled, bare);
    const store = await openStore(MODEL, { driver: recording(nodeDriver(), record) });
    try {
      for (const [sql, key] of [[profiled.collectionSql[0], 'b1'], [profiled.entitySql[0], 2]]) {
        const detail = record.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all([key])
          .map((/** @type {any} */ row) => row.detail).join('; ');
        assert.match(detail, /^SEARCH /, detail);
        assert.doesNotMatch(detail, /\bSCAN\b/, detail);
      }
    }
    finally { await store.close(); }
  });
});

describe('PostgreSQL: a profiled point read stays a key seek', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('runs the statement a store with no profile runs, and the planner reads it through the key index', async () => {
    const pg = (await import('pg')).default;
    // with sequential scans priced out, a statement no index answers still
    // plans as a Seq Scan — so an index scan here is the key seek itself
    const pool = new pg.Pool({ connectionString: url, max: 2, options: '-c enable_seqscan=off' });
    const schemas = [`jaren_seek_p_${process.pid}`, `jaren_seek_b_${process.pid}`];
    try {
      for (const schema of schemas) await pool.query(`CREATE SCHEMA "${schema}"`);
      const record = { sql: /** @type {string[]} */ ([]), connection: null };
      const profiled = await pointReads(recording(postgresDriver(pool, { schema: schemas[0] }), record), record, PROFILE);
      const bare = await pointReads(recording(postgresDriver(pool, { schema: schemas[1] }), record), record, undefined);
      assertSameSeek(profiled, bare);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemas[0]}"`);
        for (const [sql, key] of [[profiled.collectionSql[0], 'b1'], [profiled.entitySql[0], 2]]) {
          const plan = (await client.query(`EXPLAIN ${sql}`, [key])).rows
            .map((/** @type {any} */ row) => row['QUERY PLAN']).join('; ');
          assert.match(plan, /Index (Only )?Scan using/, plan);
          assert.doesNotMatch(plan, /Seq Scan/, plan);
        }
      }
      finally { client.release(); }
    }
    finally {
      try { for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    }
  });
});
