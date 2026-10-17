//@ts-check
/**
 * @file A stored integer that a JavaScript number would round is refused on
 * every public read, an included child's included, with one code on both
 * engines: `JD2003`, class `data`, the driver's own refusal as its cause.
 * SQLite holds the exact 64-bit integer and refuses one a double does not
 * hold; PostgreSQL holds an `integer` member's column as `numeric` and
 * refuses the integer whose number is neither it nor spelled by its digits.
 * Every integer within ±(2^53 - 1) reads as it is stored, and on both
 * engines so does an integer past 2^53 that the store wrote. A `number`
 * member's column reads such a value as the nearest double on both engines
 * (SQLite's `REAL` column rounds it as it is written).
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const model = { $model: '0.1', entities: {
  T: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' }, n: { type: 'number' },
    kids: { 'x-entity': { relation: { to: 'C', many: true, via: 'tid', onDelete: 'cascade' } } } } } },
  C: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, tid: { type: 'string' }, v: { type: 'integer' } } } } } };

/**
 * Open the model on `engine`, and hand `fn` the store and a raw writer that
 * runs one statement beside it.
 * @param {string} engine
 * @param {(store: any, raw: (sql: string) => Promise<void>) => Promise<void>} fn
 */
async function withRawWriter(engine, fn) {
  if (engine === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-integer-read-'));
    const path = join(dir, 'store.sqlite');
    try {
      await withStore('sqlite', model, (store) => fn(store, async (sql) => {
        const db = new DatabaseSync(path);
        try { db.exec(sql); }
        finally { db.close(); }
      }), { path });
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
    return;
  }
  await withStore('postgres', model, (store, pg) => fn(store, async (sql) => {
    const client = await pg?.pool.connect();
    try {
      await client.query(`SET search_path TO "${pg?.schema}"`);
      await client.query(sql);
    }
    finally { client.release(); }
  }));
}

describe('a stored integer a JavaScript number would round', () => {
  for (const engine of ENGINES) {
    describe(`on ${engine}`, { skip: skipFor(engine) }, () => {
      it('is refused JD2003 on each public read, and a safe integer reads as stored', async () => {
        await withRawWriter(engine, async (store, raw) => {
          const set = store.entity('T');
          await set.create({ id: 'r', v: 1 });
          for (const value of [9007199254740991, -9007199254740991]) {
            await raw(`UPDATE "T" SET "v" = ${value}`);
            assert.deepEqual(await set.asNoTracking().get('r'), { id: 'r', v: value });
          }
          for (const value of ['9007199254740993', '-9007199254740993']) {
            await raw(`UPDATE "T" SET "v" = ${value}`);
            for (const run of [() => set.asNoTracking().get('r'), () => set.load({}), () => set.page({}, { limit: 1 }),
              () => store.execute({ $for: { it: '$.T[*]' }, $return: '$it' })]) {
              await assert.rejects(async () => run(), (error) => {
                assert.deepEqual({ code: error.code, class: error.class, retryable: error.retryable, cause: error.cause?.code },
                  { code: 'JD2003', class: 'data', retryable: false, cause: 'ERR_OUT_OF_RANGE' });
                assert.equal(error.reason, 'a stored integer cannot be represented exactly as a JavaScript number: '
                  + `Value is too large to be represented as a JavaScript number: ${value}`);
                return true;
              });
            }
          }
        });
      });
    });
  }

  it('on postgres, the integer stored with a scale is refused as the one without', { skip: skipFor('postgres') }, async () => {
    await withRawWriter('postgres', async (store, raw) => {
      const set = store.entity('T');
      await set.create({ id: 'r', v: 1, n: 1 });
      for (const value of ['9007199254740993.0', '-9007199254740993.00']) {
        await raw(`UPDATE "T" SET "v" = ${value}`);
        await assert.rejects(async () => set.asNoTracking().get('r'), (error) => {
          assert.deepEqual({ code: error.code, cause: error.cause?.code }, { code: 'JD2003', cause: 'ERR_OUT_OF_RANGE' });
          assert.equal(error.reason, 'a stored integer cannot be represented exactly as a JavaScript number: '
            + `Value is too large to be represented as a JavaScript number: ${value.replace(/\.0+$/, '')}`);
          return true;
        });
      }
      // a safe integer with a scale reads as the integer, and a number column as the nearest double
      await raw('UPDATE "T" SET "v" = 12.0, "n" = 9007199254740993.0');
      assert.deepEqual(await set.asNoTracking().get('r'), { id: 'r', v: 12, n: 9007199254740992 });
    });
  });

  for (const engine of ENGINES) {
    it(`on ${engine}, a number column reads it as the nearest double`, { skip: skipFor(engine) }, async () => {
      await withRawWriter(engine, async (store, raw) => {
        const set = store.entity('T');
        await set.create({ id: 'r', v: 1, n: 1 });
        await raw('UPDATE "T" SET "n" = 9007199254740993');
        assert.deepEqual(await set.asNoTracking().get('r'), { id: 'r', v: 1, n: 9007199254740992 });
      });
    });
  }

  for (const engine of ENGINES) {
    it(`on ${engine}, a native statement that projects the member refuses it as the row read whole does`, { skip: skipFor(engine) }, async () => {
      await withRawWriter(engine, async (store, raw) => {
        const set = store.entity('T');
        await set.create({ id: 'a', v: 1, n: 1 });
        await set.create({ id: 'b', v: 2, n: 2 });
        await raw('UPDATE "T" SET "v" = 9007199254740993 WHERE "id" = \'b\'');
        for (const ret of ['$it.v', { v: '$it.v' }, { id: '$it.id', v: '$it.v' }]) {
          const document = { $for: { it: '$.T[*]' }, $orderby: ['$it.id'], $return: ret };
          assert.equal((await store.explain(document)).mode, 'native', JSON.stringify(ret));
          for (const pushdown of [true, false]) {
            await assert.rejects(async () => store.execute(document, { pushdown }), (error) => {
              assert.deepEqual({ code: error.code, class: error.class, cause: error.cause?.code },
                { code: 'JD2003', class: 'data', cause: 'ERR_OUT_OF_RANGE' }, `${JSON.stringify(ret)} ${pushdown}`);
              return true;
            });
          }
        }
        // a member the statement does not project is not read (a named deviation)
        assert.deepEqual(await store.execute({ $for: { it: '$.T[*]' }, $orderby: ['$it.id'], $return: '$it.n' }), [1, 2]);
      });
    });
  }

  for (const engine of ENGINES) {
    it(`on ${engine}, an integer past 2^53 the store wrote reads back as written`, { skip: skipFor(engine) }, async () => {
      await withStore(engine, model, async (store) => {
        const set = store.entity('T');
        // a double past the 64-bit integers is a PostgreSQL `numeric`'s alone
        const values = [2 ** 53 + 2, 2 ** 60, -(2 ** 62), ...engine === 'postgres' ? [2 ** 70] : []];
        for (const [i, v] of values.entries()) {
          await set.create({ id: `r${i}`, v });
          assert.deepEqual(await set.asNoTracking().get(`r${i}`), { id: `r${i}`, v });
          await store.entity('C').create({ id: `c${i}`, tid: `r${i}`, v });
        }
        const loaded = await set.asNoTracking().load({ orderBy: '$it.id', include: { kids: true } });
        assert.deepEqual(loaded.map((/** @type {any} */ row) => [row.v, row.kids.map((/** @type {any} */ kid) => kid.v)]),
          values.map((v) => [v, [v]]));
        const projected = { $for: { it: '$.T[*]' }, $orderby: ['$it.id'], $return: '$it.v' };
        assert.deepEqual(await store.execute(projected), values);
        assert.deepEqual(await store.execute(projected, { pushdown: false }), values);
      });
    });
  }

  for (const engine of ENGINES) {
    it(`on ${engine}, an included child's integer is refused where the row read whole is`, { skip: skipFor(engine) }, async () => {
      await withRawWriter(engine, async (store, raw) => {
        await store.entity('T').create({ id: 't', v: 1 });
        await store.entity('C').create({ id: 'c', tid: 't', v: 1 });
        const include = () => store.entity('T').asNoTracking().load({ include: { kids: true } });
        // a PostgreSQL `numeric` keeps the scale a retype left; SQLite reads
        // the digits a JavaScript number spells 2^60 by as the integer they name
        const refused = ['9007199254740993', '-9007199254740993',
          ...engine === 'postgres' ? ['9007199254740993.0'] : ['1152921504606847000']];
        for (const digits of refused) {
          await raw(`UPDATE "C" SET "v" = ${digits}`);
          for (const read of [include, () => store.entity('C').asNoTracking().get('c')]) {
            await assert.rejects(async () => read(), (error) => {
              assert.deepEqual({ code: error.code, class: error.class, retryable: error.retryable, cause: error.cause?.code },
                { code: 'JD2003', class: 'data', retryable: false, cause: 'ERR_OUT_OF_RANGE' }, digits);
              assert.equal(error.reason, 'a stored integer cannot be represented exactly as a JavaScript number: '
                + `Value is too large to be represented as a JavaScript number: ${digits.replace(/\.0+$/, '')}`);
              return true;
            });
          }
        }
        // read as the row read whole reads it: the exact integer on both, and
        // on PostgreSQL the digits a JavaScript number wrote
        for (const digits of ['1152921504606846976', ...engine === 'postgres' ? ['1152921504606847000'] : [], '-9007199254740991']) {
          await raw(`UPDATE "C" SET "v" = ${digits}`);
          const [row] = await include();
          assert.deepEqual(row.kids, [{ id: 'c', tid: 't', v: Number(digits) }]);
          assert.deepEqual(await store.entity('C').asNoTracking().get('c'), { id: 'c', tid: 't', v: Number(digits) });
        }
      });
    });
  }
});
