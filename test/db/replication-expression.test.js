//@ts-check
/**
 * @file Replay order over a unique entity index over an expression
 * (MODEL-FORMAT §7A, PostgreSQL only: SQLite refuses such an index at the
 * model): its slot holds the key the host's declarations `apply` over the
 * row's members, so an envelope that hands a folded value from one row to
 * another — released by an update, by removing the member or by deleting
 * the row — replays the release before the take, as over a unique column.
 * A rotation, which no order replays, and a declaration without `apply`,
 * whose key the store cannot compute, keep the envelope's order and are
 * refused (`JD2005`). On the server `JAREN_PG_URL` names, two schemas
 * dropped after; on SQLite the index is refused at the model (`JD0004`), so a
 * SQLite pair has no such slot to order by.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { PG_URL } from './store-core-engines.js';

const lower = { arity: 1, deterministic: true, sql: 'lower' };
const APPLIED = { lower: { ...lower, apply: (/** @type {string} */ value) => value.toLowerCase() } };
const SCHEMA = { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, email: { type: 'string' }, active: { type: 'boolean' } } };
/** @param {any} [where] */
const modelOf = (where) => ({ $model: '0.1', entities: { User: { schema: SCHEMA, indexes: [{ name: 'by_lower',
  expression: { call: 'lower', args: [{ member: '$.email' }] }, unique: true, ...(where === undefined ? {} : { where }) }] } } });

/**
 * Two replicated stores of `model` on one pool, a schema each, handed to `fn` and closed.
 * @param {any} model @param {Record<string, any>} expressions @param {(a: any, b: any) => Promise<void>} fn
 */
async function replicas(model, expressions, fn) {
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
  const schemas = ['a', 'b'].map((replica) => `jaren_replication_expression_${process.pid}_${replica}`);
  const stores = [];
  try {
    for (const schema of schemas) await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const [at, schema] of schemas.entries())
      stores.push(await openStore(model, { driver: postgresDriver(pool, { schema }), expressions,
        capture: { mode: 'journal' }, replication: { replica: at === 0 ? 'a' : 'b' } }));
    await fn(stores[0], stores[1]);
  }
  finally {
    for (const store of stores) await store.close();
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

/** Hand every envelope of `a` to `b`, answering each status or the refusal's code, but for one `b`
 * already applied (`duplicate`). @param {any} a @param {any} b */
const ship = async (a, b) => {
  const answers = [];
  for (const envelope of (await a.replication.page()).items) {
    answers.push(await b.replication.apply(envelope).then((result) => result.status, (error) => error.code));
  }
  return answers.filter((answer) => answer !== 'duplicate');
};

/** Both rows as `b` holds them. @param {any} b */
const rowsOf = async (b) => [await b.entity('User').get('u1'), await b.entity('User').get('u2')];

/** One transaction in which u2 releases `b@x` and u1 takes it as `B@X`, the release spelled by `release`. */
const RELEASES = /** @type {[string, (users: any) => Promise<any>][]} */ ([
  ['an update', (users) => users.update('u2', { email: 'zz@x' })],
  ['removing the member', (users) => users.update('u2', { email: undefined })],
  ['a delete', (users) => users.delete('u2')],
]);

describe('sqlite: an entity index over an expression', () => {
  it('is refused at the model, so replication between two SQLite stores has no such index to order by', async () => {
    await assert.rejects(openStore(modelOf(), { driver: nodeDriver(), expressions: APPLIED, capture: { mode: 'journal' }, replication: { replica: 'a' } }),
      (/** @type {any} */ error) => error.code === 'JD0004' && /by_lower/.test(error.message));
  });
});

describe('replication over a unique entity expression index', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  for (const [label, release] of RELEASES) for (const how of label === 'an update' ? ['apply', 'reset'] : ['apply']) {
    it(`a folded value released by ${label} and taken in one envelope replays the release first, by ${how}`, () => replicas(modelOf(), APPLIED, async (a, b) => {
      await a.entity('User').create({ id: 'u1', email: 'one@x' });
      await a.entity('User').create({ id: 'u2', email: 'b@x' });
      assert.deepEqual(await ship(a, b), ['applied', 'applied']);
      await a.transaction(async (/** @type {any} */ tx) => {
        await release(tx.entity('User'));
        await tx.entity('User').update('u1', { email: 'B@X' });
      });
      if (how === 'apply') assert.deepEqual(await ship(a, b), ['applied']);
      else assert.equal((await b.replication.reset(await a.replication.snapshot())).status, 'reset');
      assert.deepEqual(await rowsOf(b), await rowsOf(a));
    }));
  }

  it('a partial index orders only the rows its condition holds', () => replicas(modelOf({ $eq: ['$.active', true] }), APPLIED, async (a, b) => {
    await a.entity('User').create({ id: 'u1', email: 'one@x', active: true });
    await a.entity('User').create({ id: 'u2', email: 'b@x', active: true });
    assert.deepEqual(await ship(a, b), ['applied', 'applied']);
    await a.transaction(async (/** @type {any} */ tx) => {
      // u2 leaves the index without changing its key, then u1 takes the key
      await tx.entity('User').update('u2', { active: false });
      await tx.entity('User').update('u1', { email: 'B@X' });
    });
    assert.deepEqual(await ship(a, b), ['applied']);
    assert.deepEqual(await rowsOf(b), await rowsOf(a));
  }));

  it('a rotation of two folded values is still refused JD2005', () => replicas(modelOf(), APPLIED, async (a, b) => {
    await a.entity('User').create({ id: 'u1', email: 'a@x' });
    await a.entity('User').create({ id: 'u2', email: 'b@x' });
    assert.deepEqual(await ship(a, b), ['applied', 'applied']);
    await a.transaction(async (/** @type {any} */ tx) => {
      await tx.entity('User').update('u1', { email: 'tmp@x' });
      await tx.entity('User').update('u2', { email: 'A@X' });
      await tx.entity('User').update('u1', { email: 'B@X' });
    });
    assert.deepEqual(await ship(a, b), ['JD2005']);
  }));

  it('a declaration without apply keeps the envelope order, refused JD2005', () => replicas(modelOf(), { lower }, async (a, b) => {
    await a.entity('User').create({ id: 'u1', email: 'one@x' });
    await a.entity('User').create({ id: 'u2', email: 'b@x' });
    assert.deepEqual(await ship(a, b), ['applied', 'applied']);
    await a.transaction(async (/** @type {any} */ tx) => {
      await tx.entity('User').update('u2', { email: 'zz@x' });
      await tx.entity('User').update('u1', { email: 'B@X' });
    });
    assert.deepEqual(await ship(a, b), ['JD2005']);
  }));
});
