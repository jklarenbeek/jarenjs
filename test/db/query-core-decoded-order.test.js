//@ts-check
/**
 * @file A decoded read over a physical entity: the residual fetches the
 * root in key order, compared as the key's codec compares — a text key
 * in code-point order — on every dialect, so `pushdown: false` and the
 * native plan answer the same sequence. PostgreSQL has no `codepoint`
 * spelling of its own; its codec comparison is the dialect's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { tempDbPath } from './helpers.js';

const url = process.env.JAREN_PG_URL;

/** @param {string | undefined} schema */
const modelIn = (schema) => ({ $model: '0.1', entities: {
  Setting: { schema: { type: 'object', properties: {
    key: { type: 'string', 'x-entity': { key: true } }, value: { type: 'string' } } },
  physical: { ...(schema === undefined ? {} : { schema }), table: 'app_settings', columns: {
    key: { name: 'key', codec: 'text', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'reject' } } } },
  Item: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, label: { type: 'string' } } },
  physical: { ...(schema === undefined ? {} : { schema }), table: 'items', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, label: { name: 'label', codec: 'text', null: 'reject' } } } },
} });

const TABLES = `CREATE TABLE app_settings (key text PRIMARY KEY, value text NOT NULL);
  INSERT INTO app_settings VALUES ('b','2'),('a','1'),('B','3');
  CREATE TABLE items (id integer PRIMARY KEY, label text NOT NULL);
  INSERT INTO items VALUES (2,'b'),(10,'a'),(1,'c');`;

const settings = { $for: { s: '$.Setting[*]' }, $return: '$s.key' };
const ordered = { $for: { s: '$.Setting[*]' }, $orderby: '$s.key', $return: '$s' };
const items = { $for: { i: '$.Item[*]' }, $return: '$i.id' };

/** Every read below answers the same with the planner on and off. @param {any} store */
async function assertDecodedReads(store) {
  for (const options of [{}, { pushdown: false }]) {
    assert.deepEqual(await store.execute(settings, options), ['B', 'a', 'b'], JSON.stringify(options));
    assert.deepEqual(await store.execute(ordered, options),
      [{ key: 'B', value: '3' }, { key: 'a', value: '1' }, { key: 'b', value: '2' }], JSON.stringify(options));
    assert.deepEqual(await store.execute(items, options), [1, 2, 10], JSON.stringify(options));
  }
  assert.deepEqual((await store.explain(settings, { pushdown: false })).mode, 'set');
}

describe('a decoded read of a physical entity orders its root by the key codec', () => {
  it('on SQLite, as it always has', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const { nodeDriver } = await import('@jarenjs/db/node');
    const raw = await nodeDriver().open(dbPath);
    try {
      await raw.exec(TABLES);
    }
    finally {
      await raw.close();
    }
    let store;
    try {
      store = await openStore(modelIn(undefined), { driver: nodeDriver(), path: dbPath });
      await assertDecodedReads(store);
    }
    finally {
      try {
        await store?.close();
      }
      finally {
        cleanup();
      }
    }
  });

  it('on PostgreSQL, where a text key has no codepoint spelling of its own', { skip: !url && 'JAREN_PG_URL is not set' }, async () => {
    const { default: pg } = await import('pg');
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `query_core_decoded_${process.pid}`;
    let store;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; ${TABLES}`);
      store = await openStore(modelIn(schema), { driver: postgresDriver(pool, { schema }), adopt: true });
      await assertDecodedReads(store);
    }
    finally {
      try {
        await store?.close();
      }
      finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    }
  });
});
