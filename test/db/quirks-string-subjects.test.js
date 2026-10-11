//@ts-check
/**
 * @file A string operator over a member the schema lets hold something
 * else than a string. The engine raises `JQ2001` on a subject that is a
 * number, so a member of several kinds besides `null` (`['string',
 * 'integer']`) runs in the engine, which raises as it does over the
 * documents, and so does an adopted column whose policy reads a NULL back as
 * a present `null`. A member typed `string` and `null` alone stays native, a
 * named deviation: a stored `null` answers false there, and the prefix search
 * keeps its index seek, its bounded cost and its strict and profile
 * behaviour. A column that admits `null` holds no member where it holds NULL.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { queryJson } from '@jarenjs/json/query';

const DOCS = [
  { id: 'a', ns: 'ada', mx: 'ada' },
  { id: 'b', ns: null, mx: 'bob' },
  { id: 'c', mx: 7 },
  { id: 'd', ns: 'adam', mx: 'adam' },
];
const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ns: { type: ['string', 'null'] },
    mx: { type: ['string', 'integer'] },
  },
};
const MODEL = { $model: '0.1', collections: { rows: { schema: SCHEMA, key: '/id', indexes: [{ name: 'by_ns', path: '$.ns' }] } } };
const ENTITIES = {
  $model: '0.1',
  entities: {
    Row: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          ns: { type: ['string', 'null'] },
          doc: { type: ['string', 'null'], 'x-entity': { column: 'json' } },
        },
      },
    },
  },
};

const query = (op, member, pattern = 'ad') => ({ $for: { it: '$[*]' }, $where: { [op]: [`$it.${member}`, pattern] }, $return: '$it.id' });
const OPS = ['$starts-with', '$ends-with', '$contains'];

describe('a string operator over a member that can hold a non-string', () => {
  for (const op of OPS) {
    it(`${op} over a member of two kinds besides null raises JQ2001 as the engine does, native or not`, async () => {
      const store = await openStore(MODEL, { driver: nodeDriver() });
      const rows = store.collection('rows');
      for (const doc of DOCS) await rows.insert(doc);
      try {
        const q = query(op, 'mx');
        assert.throws(() => queryJson(q, structuredClone(DOCS)), (e) => e.code === 'JQ2001');
        for (const pushdown of [undefined, false]) {
          await assert.rejects(Promise.resolve().then(() => rows.execute(q, { pushdown })), (e) => e.code === 'JQ2001');
        }
        // the engine's own predicate decides each row inside the statement
        assert.strictEqual((await rows.explain(q)).udfs.length, 1);
      }
      finally { await store.close(); }
    });
  }

  it('a member typed string and null stays native: a stored null answers false, and the prefix search seeks its index', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const rows = store.collection('rows');
    for (const doc of DOCS) await rows.insert(doc);
    try {
      for (const op of OPS) {
        const q = query(op, 'ns');
        // the engine raises on the null row; the statement answers false there
        assert.throws(() => queryJson(q, structuredClone(DOCS)), (e) => e.code === 'JQ2001');
        assert.deepStrictEqual(await rows.execute(q), op === '$ends-with' ? undefined : ['a', 'd'], op);
        const explained = await rows.explain(q);
        assert.deepStrictEqual(explained.udfs, [], op);
        assert.strictEqual(explained.mode, 'native', op);
      }
      const prefix = await rows.explain(query('$starts-with', 'ns'));
      assert.deepStrictEqual(prefix.indexes, ['rows_by_ns']);
      assert.doesNotMatch(prefix.sql, /jaren_p_/);
    }
    finally { await store.close(); }
  });

  it('a string-only member still translates', async () => {
    const store = await openStore({ $model: '0.1', collections: { rows: { schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } }, key: '/id' } } }, { driver: nodeDriver() });
    const rows = store.collection('rows');
    await rows.insert({ id: 'a', s: 'ada' });
    await rows.insert({ id: 'b', s: 'bob' });
    try {
      const q = { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.s', 'ad'] }, $return: '$it.id' };
      assert.strictEqual(await rows.execute(q), 'a');
      assert.deepStrictEqual((await rows.explain(q)).udfs, []);
    }
    finally { await store.close(); }
  });

  it('an entity column that admits null and a document member typed string and null both translate', async () => {
    const store = await openStore(ENTITIES, { driver: nodeDriver() });
    try {
      await store.entity('Row').create({ id: 'a', ns: 'ada', doc: 'ada' });
      await store.entity('Row').create({ id: 'b', ns: null, doc: null });
      for (const member of ['ns', 'doc']) {
        const q = { $for: { it: '$.Row[*]' }, $where: { '$starts-with': [`$it.${member}`, 'ad'] }, $return: '$it.id' };
        assert.strictEqual(await store.execute(q), 'a', member);
        assert.strictEqual((await store.explain(q)).mode, 'native', member);
      }
    }
    finally { await store.close(); }
  });

  it('an adopted text column whose policy reads a NULL as a present null runs in the engine and raises', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-strsubject-'));
    const path = join(dir, 'fixture.sqlite');
    const raw = await nodeDriver().open(path);
    raw.exec("CREATE TABLE note(id TEXT PRIMARY KEY, body TEXT); INSERT INTO note VALUES ('a', 'ada'), ('b', NULL);");
    raw.close();
    const model = { $model: '0.1', entities: { Note: {
      schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, body: { type: ['string', 'null'] } } },
      physical: { table: 'note', columns: {
        id: { name: 'id', codec: 'text', null: 'reject' }, body: { name: 'body', codec: 'text', null: 'null' } } },
    } } };
    const store = await openStore(model, { driver: nodeDriver(), path, adopt: true });
    try {
      const q = { $for: { it: '$.Note[*]' }, $where: { '$starts-with': ['$it.body', 'ad'] }, $return: '$it.id' };
      for (const pushdown of [undefined, false]) {
        await assert.rejects(Promise.resolve().then(() => store.execute(q, { pushdown })), (e) => e.code === 'JQ2001');
      }
      assert.strictEqual((await store.explain(q)).mode, 'set');
    }
    finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

const url = process.env.JAREN_PG_URL;
describe('the same members on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('a member typed string and null stays native under strict and under a profile row bound; a union of two kinds runs in the engine', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `jaren_strsubject_${process.pid}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    try {
      const store = await openStore(MODEL, { driver: postgresDriver(pool, { schema, maxConnections: 2 }) });
      try {
        const rows = store.collection('rows');
        for (let i = 0; i < 300; i++) await rows.insert({ id: `r${String(i).padStart(3, '0')}`, ns: i % 10 === 0 ? null : `name${i}`, mx: `name${i}` });
        const nullable = query('$starts-with', 'ns', 'name29');
        const explained = await rows.explain(nullable);
        assert.strictEqual(explained.mode, 'native');
        assert.deepStrictEqual(explained.udfs ?? [], []);
        assert.strictEqual((await rows.execute(nullable, { strict: true })).length, 10);
        // 10 matching rows are fetched under a bound of 50: the statement reads only them
        assert.strictEqual((await rows.execute(nullable, { profile: { collections: ['rows'], maxRows: 50 } })).length, 10);
        await rows.insert({ id: 'zz', mx: 7 });
        const union = query('$starts-with', 'mx', 'name29');
        assert.strictEqual((await rows.explain(union)).mode, 'set');
        await assert.rejects(Promise.resolve().then(() => rows.execute(union)), (e) => e.code === 'JQ2001');
        await assert.rejects(Promise.resolve().then(() => rows.execute(union, { strict: true })), (e) => e.code === 'JD0010');
      }
      finally { await store.close(); }
    }
    finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
