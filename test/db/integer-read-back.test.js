//@ts-check
/**
 * @file A stored integer that a JavaScript number would round is refused on
 * every public read, with one code on both engines: `JD2003`, class `data`,
 * the driver's own refusal as its cause. SQLite's driver refuses an integer
 * past ±(2^53 - 1); PostgreSQL holds an `integer` member's column as
 * `numeric` and refuses the integer whose number is neither it nor spelled
 * by its digits. Every integer within ±(2^53 - 1) reads as it is stored,
 * and on PostgreSQL so does an integer past 2^53 that the store wrote. A
 * `number` member's column reads such a value as the nearest double on both
 * engines (SQLite's `REAL` column rounds it as it is written).
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

const model = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' }, n: { type: 'number' } } } } } };

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

  it('on postgres, an integer past 2^53 the store wrote reads back as written', { skip: skipFor('postgres') }, async () => {
    await withStore('postgres', model, async (store) => {
      const set = store.entity('T');
      for (const [id, v] of [['a', 2 ** 53 + 2], ['b', 2 ** 60], ['c', -(2 ** 62)], ['d', 2 ** 70]]) {
        await set.create({ id, v });
        assert.deepEqual(await set.asNoTracking().get(id), { id, v });
      }
    });
  });
});
