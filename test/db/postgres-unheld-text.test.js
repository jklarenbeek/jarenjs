//@ts-check
/**
 * @file PostgreSQL holds no U+0000 in text or jsonb, nor the escape of a lone
 * surrogate in jsonb. A query document comparing such a literal — a list item
 * included, over an entity's column or document as over a collection's —
 * runs in the residual; a statement with no engine path refuses it by its own code before
 * it reaches the server: a profile's mandatory predicate `JD0011` on every
 * query surface of a collection and an entity (a point read, which the engine
 * judges, still answers), a graph load's `where` `JD0032`, and a native
 * mutation's `where` `JD0038`.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { adoptedPostgres } from './helpers.js';

const url = process.env.JAREN_PG_URL;
const MODEL = { $model: '0.1',
  collections: { ev: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, tenant: { type: 'string' } } } } },
  entities: { E: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, tenant: { type: 'string' } } } } } };
const ROWS = [{ id: 'a1', tenant: 'a' }, { id: 'b1', tenant: 'b' }];
const UNHELD = /the profile's predicate for '(?:ev|E)' compares a string this server cannot hold/;

describe('PostgreSQL: a literal the server cannot hold, where no engine path answers it', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  /** @type {any} */
  let pool;
  const schema = `jaren_unheld_${process.pid}`;
  let n = 0;
  before(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: url, max: 2 });
  });
  after(async () => { await pool.end(); });

  /** A fresh store under `profile`, seeded. @param {any} profile @param {(store: any) => Promise<void>} fn */
  const using = async (profile, fn) => {
    const own = `${schema}_${++n}`;
    await pool.query(`CREATE SCHEMA "${own}"`);
    const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema: own }), ...(profile ? { profile } : {}) });
    try {
      for (const row of ROWS) {
        await store.collection('ev').insert(row);
        await store.entity('E').create(row);
      }
      await fn(store);
    }
    finally {
      await store.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${own}" CASCADE`);
    }
  };
  const refused = (/** @type {any} */ error) => error.code === 'JD0011' && UNHELD.test(error.message);

  for (const predicate of [{ $ne: ['$it.tenant', 'a\u0000'] }, { $eq: ['$it.tenant', { $seq: ['a', 'x\u0000'] }] },
    { $eq: ['$it.tenant', { $seq: ['a', 'x\uD800'] }] }]) {
    it(`a profile predicate ${JSON.stringify(predicate)} is refused on every query surface; a point read answers`, () =>
      using({ predicates: { ev: predicate, E: predicate } }, async (store) => {
        const ev = store.collection('ev');
        const ids = { $for: { it: '$[*]' }, $return: '$it.id' };
        await assert.rejects(async () => ev.execute(ids), refused);
        await assert.rejects(async () => ev.execute(ids, { pushdown: false }), refused);
        await assert.rejects(async () => ev.all(), refused);
        await assert.rejects(async () => ev.explain(ids), refused);
        assert.deepStrictEqual(await ev.get('a1'), { id: 'a1', tenant: 'a' });
        const entityIds = { $for: { e: '$.E[*]' }, $return: '$e.id' };
        await assert.rejects(async () => store.execute(entityIds), refused);
        await assert.rejects(async () => store.execute(entityIds, { pushdown: false }), refused);
        await assert.rejects(async () => store.entity('E').load({}), refused);
        assert.deepStrictEqual(await store.entity('E').get('a1'), { id: 'a1', tenant: 'a' });
      }));
  }

  it('an entity document comparing a column or a member with such a list item runs in the residual, as a collection\'s does', () =>
    using(null, async (store) => {
      for (const item of ['x\u0000', 'x\uD800']) {
        for (const document of [
          { $for: { e: '$.E[*]' }, $where: { $eq: ['$e.tenant', { $seq: ['a', item] }] }, $return: '$e.id' },
          { $for: { e: '$.E[*]' }, $where: { $eq: ['$e.extra', { $seq: ['a', item] }] }, $return: '$e.id' },
          { $for: { e: '$[*]' }, $where: { $eq: ['$e.tenant', { $seq: ['a', item] }] }, $return: '$e.id' },
        ]) {
          const run = (/** @type {any} */ options) => (document.$for.e === '$[*]'
            ? store.collection('ev').execute(document, options) : store.execute(document, options));
          const expected = document.$where.$eq[0] === '$e.extra' ? undefined : 'a1';
          assert.deepStrictEqual(await run(undefined), expected, JSON.stringify(document));
          assert.deepStrictEqual(await run({ pushdown: false }), expected);
          const explained = await (document.$for.e === '$[*]' ? store.collection('ev') : store.entity('E')).explain(document);
          assert.strictEqual(explained.mode, 'set');
          if (document.$for.e !== '$[*]') assert.strictEqual(reasonId(explained.reasons[0].reason), 'bind.serverText');
        }
      }
    }));

  it('a graph load\'s where is refused JD0032, and execute() answers it in the engine', () => using(null, async (store) => {
    const where = { $ne: ['$it.tenant', 'a\u0000'] };
    for (const read of [() => store.entity('E').load({ where }), () => store.entity('E').page({ where })]) {
      await assert.rejects(async () => read(), (/** @type {any} */ error) => error.code === 'JD0032'
        && /a string literal holding U\+0000, or a list item holding U\+0000 or a lone surrogate, is not a value this server holds/.test(error.message));
    }
    assert.deepStrictEqual(await store.execute({ $for: { e: '$.E[*]' }, $where: { $ne: ['$e.tenant', 'a\u0000'] }, $return: '$e.id' }),
      ['a1', 'b1']);
  }));

  it('a native mutation\'s where is refused JD0038 and changes nothing', async () => {
    const entities = { Row: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, s: { type: 'string' } } },
      physical: { table: 'rows', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, s: { name: 's', codec: 'text', null: 'reject' } } } } };
    const handle = await adoptedPostgres("CREATE TABLE rows (id integer PRIMARY KEY, s text NOT NULL); INSERT INTO rows VALUES (1, 'a');",
      entities, { label: 'unheld' });
    try {
      await assert.rejects(async () => handle.store.entity('Row').mutate({ op: 'update', where: { $ne: ['$it.s', 'a\u0000'] }, set: { s: 'b' } }),
        (/** @type {any} */ error) => error.code === 'JD0038' && /is not a value this server holds/.test(error.message));
      assert.deepStrictEqual(await handle.store.entity('Row').get(1), { id: 1, s: 'a' });
    }
    finally { await handle.close(); }
  });
});
