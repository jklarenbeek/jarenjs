//@ts-check
/**
 * @file An entity's `integer` column orders as the engine reads it. On
 * PostgreSQL the store makes such a column a `numeric`, which holds the
 * digits a writer spelled: another writer's `1152921504606846976` beside the
 * store's `1152921504606847000` (both 2^60), or `5.00000000000000000001`
 * beside `5`, are two values there and one double to the engine, which ties
 * them and keeps the rows' order. Every order term reads the double — a
 * query's `$orderby`, a window, a hop's order key, a load's `orderBy`, a
 * keyset page resuming inside a run of equal doubles, an include's order —
 * a schema bound included, which a `numeric` holding a conforming fraction
 * does not keep. A column holding a key (the entity's own, a
 * database-allocated one, a reference to one, a join table's sides) is read
 * bare and keeps its index order. SQLite's `INTEGER` column holds no integer
 * the engine reads but as its own double; there every answer is unchanged.
 * Every answer is compared with the engine's (`pushdown: false`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENGINES, skipFor, withPostgres, withStore } from './store-core-engines.js';
import { openStore } from '@jarenjs/db';

const INTEGERS = { b: { type: 'integer' }, c: { type: 'integer', 'x-entity': { index: true } },
  q: { type: 'integer', minimum: -1e15, maximum: 1e15 } };
const MODEL = { $model: '0.1', entities: {
  E: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, pId: { type: 'string' },
    ...INTEGERS, js: { 'x-entity': { relation: { to: 'J', many: true, via: 'eId', onDelete: 'cascade' } } },
    p: { 'x-entity': { relation: { to: 'P', via: 'pId', onDelete: 'setNull' } } } } } },
  J: { schema: { type: 'object', required: ['id', 'eId'], properties: { id: { type: 'string', 'x-entity': { key: true } },
    eId: { type: 'string' }, ...INTEGERS } } },
  P: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, ...INTEGERS } } } } };
/**
 * The digits another writer stores in each row's columns, in row order. On
 * PostgreSQL: one double spelled by other digits than the store's (2^60 by
 * `…847000` and `…846976`, 5 by a fraction above and below it); the bounded
 * `q` takes 7 where the digits pass its bound. On SQLite the spellings its
 * `INTEGER` column takes as the engine reads them (a past-2^53 integer that
 * is not its own double is the engine's JD2003 there).
 */
const SPELLINGS = {
  postgres: ['1152921504606847000', '1152921504606846976', '5.00000000000000000001', '5', '1', '1152921504606847000', '4.99999999999999999999'],
  sqlite: ['9007199254740991', '9007199254740991.0', '5.00000000000000000001', '5', '1', '9007199254740991', '4.99999999999999999999'],
};
const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/**
 * Open the store on `engine`, write every row through it, then set each
 * row's integer columns to another writer's digits, and run `fn`.
 * @param {string} engine @param {(store: any) => Promise<void>} fn
 */
async function withSpelledRows(engine, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-integer-column-order-'));
  const path = join(dir, 'store.sqlite');
  try {
    await withStore(engine, MODEL, async (store, pg) => {
      for (const id of IDS) {
        await store.entity('P').create({ id, b: 1, c: 1, q: 1 });
        await store.entity('E').create({ id, pId: id, b: 1, c: 1, q: 1 });
        await store.entity('J').create({ id, eId: 'a', b: 1, c: 1, q: 1 });
      }
      const updates = ['E', 'J', 'P'].flatMap((table) => SPELLINGS[/** @type {'postgres' | 'sqlite'} */ (engine)].map((digits, i) =>
        `UPDATE "${table}" SET "b" = ${digits}, "c" = ${digits}, "q" = ${Math.abs(Number(digits)) < 1e15 ? digits : 7} WHERE "id" = '${IDS[i]}';`)).join(' ');
      if (pg !== null) await pg.pool.query(`SET search_path TO "${pg.schema}"; ${updates} RESET search_path`);
      else {
        const db = new DatabaseSync(path);
        try { db.exec(updates); }
        finally { db.close(); }
      }
      await fn(store);
    }, engine === 'sqlite' ? { path } : {});
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** @param {any[]} rows */
const ids = (rows) => rows.map((row) => row.id).join('');

for (const engine of ENGINES) {
  describe(`an entity's integer column another writer spelled, ${engine}`, { skip: skipFor(engine) }, () => {
    it('orders, windows, loads, pages and includes as the engine does', async () => {
      await withSpelledRows(engine, async (store) => {
        const E = store.entity('E');
        const differ = [];
        for (const member of ['b', 'c', 'q']) {
          for (const dir of ['asc', 'desc']) {
            const key = { $key: `$it.${member}`, $dir: dir };
            // with no further term, the engine keeps the rows' order inside a run of one double
            const query = { $for: { it: '$.E[*]' }, $orderby: [key], $return: '$it.id' };
            const oracle = (await store.execute(query, { pushdown: false })).join('');
            /** @param {string} label @param {any} doc @param {string} native */
            const against = async (label, doc, native) => {
              const expected = (await store.execute(doc, { pushdown: false })).join('');
              if (native !== expected) differ.push({ member, dir, label, native, expected });
            };
            await against('orderby', query, (await store.execute(query)).join(''));
            assert.equal((await store.explain(query)).mode, 'native');
            for (const start of [0, 1, 2, 4]) {
              const window = { $subsequence: [query, start, 3] };
              await against(`window ${start}`, window, (await store.execute(window)).join(''));
            }
            // a hop's order key: each row's parent, spelled as the row is
            const hop = { $for: { it: '$.E[*]' }, $orderby: [{ $key: { $for: { r1: '$.P[*]' }, $where: { $eq: ['$r1.id', '$it.pId'] },
              $return: `$r1.${member}` }, $dir: dir }], $return: '$it.id' };
            assert.equal((await store.explain(hop)).mode, 'native');
            await against('hop', hop, (await store.execute(hop)).join(''));
            const loaded = ids(await E.asNoTracking().load({ orderBy: [key] }));
            if (loaded !== oracle) differ.push({ member, dir, label: 'load', native: loaded, expected: oracle });
            const included = ids((await E.asNoTracking().load({ where: { $eq: ['$it.id', 'a'] }, include: { js: { orderBy: [key] } } }))[0].js);
            if (included !== oracle) differ.push({ member, dir, label: 'include', native: included, expected: oracle });
            // a keyset page of two resumes inside a run of equal doubles
            let paged = '';
            let continuation;
            for (let i = 0; i < IDS.length && (i === 0 || continuation != null); i++) {
              const page = await E.page({ orderBy: [key, '$it.id'] }, { limit: 2, ...(continuation === undefined ? {} : { after: continuation }) });
              paged += ids(page.items);
              continuation = page.continuation;
            }
            await against('page', { ...query, $orderby: [key, '$it.id'] }, paged);
          }
        }
        assert.deepEqual(differ, []);
        // the engine's own answer: 2^60's two spellings tie on PostgreSQL, and 5's three
        assert.deepEqual(await store.execute({ $for: { it: '$.E[*]' }, $orderby: ['$it.b'], $return: '$it.id' }, { pushdown: false }),
          ['e', 'c', 'd', 'g', 'a', 'b', 'f']);
      });
    });
  });
}

const KEYS = { $model: '0.1', entities: {
  K: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    v: { type: 'integer', 'x-entity': { index: true } }, as: { 'x-entity': { relation: { to: 'A', many: true, via: 'kId', onDelete: 'cascade' } } },
    tags: { 'x-entity': { relation: { to: 'T', many: true } } } } } },
  A: { schema: { type: 'object', properties: { aid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, kId: { type: 'integer' },
    k: { 'x-entity': { relation: { to: 'K', via: 'kId', onDelete: 'cascade' } } } } } },
  T: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } } } };

/**
 * Run `fn` over a PostgreSQL store of `model` whose ordered statements are
 * recorded as the store sends them.
 * @param {any} model
 * @param {(store: any, seen: { text: string, values: any[] }[], pg: { pool: any, schema: string }) => Promise<void>} fn
 */
async function withRecordedStatements(model, fn) {
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  await withPostgres(async ({ pool, schema }) => {
    /** @type {{ text: string, values: any[] }[]} */
    const seen = [];
    /** @param {(...args: any[]) => any} query */
    const record = (query) => (/** @type {any} */ text, /** @type {any[]} */ ...rest) => {
      const sql = typeof text === 'string' ? text : text?.text;
      if (typeof sql === 'string' && sql.includes('ORDER BY'))
        seen.push({ text: sql.replace(/^DECLARE "[^"]+" NO SCROLL CURSOR FOR /, ''), values: Array.isArray(rest[0]) ? rest[0] : text?.values ?? [] });
      return query(text, ...rest);
    };
    /** @param {any} target */
    const recording = (target) => new Proxy(target, { get(object, name) {
      if (name === 'query') return record(object.query.bind(object));
      if (name === 'connect') return async () => recording(await object.connect());
      const value = object[name];
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    const store = await openStore(model, { driver: postgresDriver(recording(pool), { schema }) });
    try { await fn(store, seen, { pool, schema }); }
    finally { await store.close(); }
  });
}

describe('a column holding a key, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('reads bare in a query, a window, a load, a page and an include, and an include still seeks a reference', async () => {
    await withRecordedStatements(KEYS, async (store, seen, { pool, schema }) => {
      await store.entity('K').create({ id: 1, v: 1 });
      await store.entity('A').create({ kId: 1 });
      await store.entity('T').create({ name: 'red' });
      store.entity('K').link(1, 'tags', 'red');
      await store.saveChanges();
      const s = `"${schema}"`;
      await pool.query(`INSERT INTO ${s}."K" (id, v, doc) SELECT g + 1, g, '{}'::jsonb FROM generate_series(1, 20000) g;
        INSERT INTO ${s}."A" ("kId", doc) SELECT (g % 20000) + 1, '{}'::jsonb FROM generate_series(1, 20000) g;
        ANALYZE ${s}."K"; ANALYZE ${s}."A";`);
      // an integer key, a database-allocated one, a reference to one and a join table's side
      for (const [root, member] of [['K', 'id'], ['A', 'aid'], ['A', 'kId'], ['K_T', 'K_key']]) {
        const query = { $for: { it: `$.${root}[*]` }, $orderby: [{ $key: `$it.${member}`, $dir: 'desc' }], $return: `$it.${member}` };
        for (const doc of [query, { $subsequence: [query, 1, 3] }]) {
          assert.match((await store.explain(doc)).sql, new RegExp(`ORDER BY "t0"\\."${member}" DESC NULLS LAST, "t0"\\."rid"`), `${root}.${member}`);
          assert.deepEqual(await store.execute(doc), await store.execute(doc, { pushdown: false }));
        }
      }
      seen.length = 0;
      await store.entity('A').asNoTracking().load({ orderBy: ['$it.kId'], take: 3 });
      const first = await store.entity('K').page({ orderBy: ['$it.id'] }, { limit: 3 });
      await store.entity('K').page({ orderBy: ['$it.id'] }, { limit: 3, after: first.continuation });
      await store.entity('K').asNoTracking().load({ where: { $eq: ['$it.id', 1] }, include: { as: { orderBy: ['$it.kId', '$it.aid'] } } });
      assert.deepEqual(seen.map((statement) => statement.text.replace(/^SELECT .*? FROM "(\w+)" AS "r"/, '$1')
        .replace(/\(SELECT jsonb_agg.*? FROM \(SELECT "r_as"\.\* FROM "A" AS "r_as" WHERE (.*?)\) AS "r_as"\) AS "__as"/, 'include $1')), [
        'A ORDER BY "r"."kId" ASC NULLS FIRST, "r"."rid" LIMIT 3',
        'K ORDER BY "r"."id" ASC NULLS FIRST LIMIT 4',
        'K WHERE ("r"."id" > $1) ORDER BY "r"."id" ASC NULLS FIRST LIMIT 4',
        'K WHERE ("r"."id" IS NOT NULL AND "r"."id" = $1) ORDER BY "r"."rid"']);
      const include = seen[3];
      assert.match(include.text, /WHERE "r_as"\."kId" = "r"\."id" ORDER BY "r_as"\."kId" ASC NULLS FIRST, "r_as"\."aid" ASC NULLS FIRST, "r_as"\."rid"/);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${s}`);
        const plan = (await client.query(`EXPLAIN ${include.text}`, include.values)).rows.map((/** @type {any} */ row) => row['QUERY PLAN']).join('\n');
        assert.match(plan, /Index (Only )?Scan using "A_kId"/, plan);
      }
      finally { await client.query('RESET search_path'); client.release(); }
      // an integer column that holds no key reads the double, in a query and a load alike
      assert.match((await store.explain({ $for: { it: '$.K[*]' }, $orderby: ['$it.v'], $return: '$it.id' })).sql,
        /ORDER BY \(CASE WHEN abs\("t0"\."v"\) < /);
      seen.length = 0;
      await store.entity('K').asNoTracking().load({ orderBy: ['$it.v'], take: 3 });
      assert.match(seen[0].text, /ORDER BY \(CASE WHEN abs\("r"\."v"\) < /);
    });
  });
});

describe('a number key and a reference to one, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('order as the doubles they hold, as before', async () => {
    const model = { $model: '0.1', entities: {
      N: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'number', 'x-entity': { key: true } }, tag: { type: 'string' } } } },
      R: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, nId: { type: 'number' },
        n: { 'x-entity': { relation: { to: 'N', via: 'nId', onDelete: 'cascade' } } } } } } } };
    await withStore('postgres', model, async (store, pg) => {
      const { pool, schema } = /** @type {{ pool: any, schema: string }} */ (pg);
      await store.entity('N').create({ id: 1, tag: 'x' });
      await store.entity('N').create({ id: 2, tag: 'y' });
      await store.entity('R').create({ id: 'r', nId: 1 });
      // another writer re-keys 2 by digits below 1 that round to it, and references it
      await pool.query(`SET search_path TO "${schema}"; UPDATE "N" SET id = 0.99999999999999999999 WHERE id = 2;
        INSERT INTO "R" (id, "nId", doc) VALUES ('s', 0.99999999999999999999, '{}'::jsonb); RESET search_path`);
      for (const [root, member, ret] of [['N', 'id', 'tag'], ['R', 'nId', 'id']]) {
        const query = { $for: { it: `$.${root}[*]` }, $orderby: [`$it.${member}`], $return: `$it.${ret}` };
        assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), root);
        assert.deepEqual(await store.execute(query), root === 'N' ? ['x', 'y'] : ['r', 's']);
      }
    });
  });
});

describe('an entity\'s integer column, SQLite', () => {
  it('reads bare and in its index\'s order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-integer-column-order-'));
    const path = join(dir, 'store.sqlite');
    try {
      await withStore('sqlite', MODEL, async (store) => {
        for (const id of IDS) await store.entity('E').create({ id, b: 1, c: IDS.indexOf(id), q: 1 });
        const doc = { $subsequence: [{ $for: { it: '$.E[*]' }, $orderby: ['$it.c'], $return: '$it.id' }, 1, 3] };
        const { sql } = await store.explain(doc);
        assert.match(sql, /ORDER BY "t0"\."c" ASC NULLS FIRST, "t0"\."rowid"/);
        const db = new DatabaseSync(path);
        try {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...sql.split('?').slice(1).map(() => 0)).map((row) => String(row.detail));
          assert.ok(!plan.includes('USE TEMP B-TREE FOR ORDER BY'), plan.join(' | '));
        }
        finally { db.close(); }
        assert.deepEqual(await store.execute(doc), ['b', 'c', 'd']);
      }, { path });
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
