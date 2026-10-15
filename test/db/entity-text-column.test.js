//@ts-check
/**
 * @file A string an entity's column would store as another string. A
 * driver encodes text as UTF-8, which has no spelling for a lone
 * surrogate, and stores U+FFFD in its place, so every write that would
 * put one in a column — a mapped member, a key, a foreign key, a column
 * of a column-only table, by any write path — is refused `JD2003` and
 * stores nothing, while a document member keeps it (its JSON escape is
 * well-formed text). A key no write can store is one no read finds.
 * SQLite stores U+0000 in a column as written, so that is no refusal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';

const MODEL = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' }, meta: { type: 'object', properties: { n: { type: 'string' } } } } } },
    Post: { schema: { type: 'object', required: ['pid'], properties: { pid: { type: 'integer', 'x-entity': { key: true } },
      author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'setNull' } } } } } },
  },
};

/** The refusal, naming the member. @param {string} member */
const lone = (member) => ({ code: 'JD2003', message: new RegExp(`the member '${member}' holds a lone surrogate, which its column cannot store`) });

describe('a lone surrogate written to an entity column', () => {
  it("is refused JD2003 by a document entity's writer, and nothing is stored", async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const users = store.entity('User');
      // the row a U+FFFD would have landed on, had the write gone through
      await users.create({ id: 'u\uFFFD', name: 'x\uFFFD' });
      await users.create({ id: 'u2', name: 'xy' });
      await assert.rejects(async () => users.create({ id: 'u1', name: 'x\uD800' }), lone('name'), host);
      await assert.rejects(async () => users.create({ id: 'u\uD800', name: 'n' }), lone('id'), host);
      await assert.rejects(async () => users.update('u2', { name: 'y\uDC00' }), lone('name'), host);
      await assert.rejects(async () => store.entity('Post').create({ pid: 1, authorId: 'u\uD800' }), lone('authorId'), host);
      assert.equal(await users.get('u1'), undefined, host);
      assert.deepEqual(await users.get('u2'), { id: 'u2', name: 'xy' }, host);
      assert.deepEqual(await store.entity('Post').load({}), [], host);
      // a key no write can store names no row: not the one U+FFFD names
      assert.equal(await users.get('u\uD800'), undefined, host);
      assert.deepEqual(await users.get('u\uFFFD'), { id: 'u\uFFFD', name: 'x\uFFFD' }, host);
      assert.equal((await users.load({})).length, 2, host);
    });
  });

  it('is refused JD2003 by the unit of work, a replacement and an addition alike', async () => {
    for (const stage of /** @type {((store: any) => Promise<string>)[]} */ ([
      async (store) => {
        store.entity('User').put({ ...(await store.entity('User').get('u2')), name: 'p\uD800' });
        return 'name';
      },
      async (store) => {
        store.entity('User').add({ id: 'u3', name: 'w\uD800' });
        return 'name';
      },
      async (store) => {
        store.entity('Post').add({ pid: 1, authorId: 'u\uD800' });
        return 'authorId';
      },
    ])) {
      await onBothEngines(MODEL, async (store, host) => {
        const users = store.entity('User');
        await users.create({ id: 'u\uFFFD', name: 'x\uFFFD' });
        await users.create({ id: 'u2', name: 'xy' });
        const member = await stage(store);
        await assert.rejects(async () => store.saveChanges(), lone(member), host);
        assert.deepEqual((await users.load({})).map((/** @type {any} */ row) => [row.id, row.name]).sort(),
          [['u2', 'xy'], ['u\uFFFD', 'x\uFFFD']], host);
        assert.deepEqual(await store.entity('Post').load({}), [], host);
      });
    }
  });

  it('a save holding one such record writes none of its records, and a staged removal by such a key is refused', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const users = store.entity('User');
      await users.create({ id: 'u\uFFFD', name: 'x\uFFFD' });
      await users.create({ id: 'u0', name: 'a' });
      users.add({ id: 'u1', name: 'good' });
      users.add({ id: 'u2', name: 'x\uD800' });
      users.put({ ...(await users.get('u0')), name: 'changed' });
      await assert.rejects(async () => store.saveChanges(), lone('name'), host);
      // a removal by a key no row can be stored under would have removed the U+FFFD row
      assert.throws(() => users.remove('u\uD800'), lone('id'), host);
      assert.deepEqual((await users.load({})).map((/** @type {any} */ row) => [row.id, row.name]).sort(),
        [['u0', 'a'], ['u\uFFFD', 'x\uFFFD']], host);
    });
  });

  it('a document member keeps it, and SQLite stores U+0000 in a column as written', async () => {
    await onBothEngines(MODEL, async (store, host) => {
      const users = store.entity('User');
      if (host === 'sqlite') {
        await users.create({ id: 'u1', name: 'a\u0000b', meta: { n: 'x\uD800' } });
        assert.deepEqual(await users.get('u1'), { id: 'u1', name: 'a\u0000b', meta: { n: 'x\uD800' } });
      }
      await users.create({ id: 'u2', name: 'x\uFFFD', meta: { n: 'x\uFFFD' } });
      assert.deepEqual(await users.get('u2'), { id: 'u2', name: 'x\uFFFD', meta: { n: 'x\uFFFD' } }, host);
    });
  });
});

const PHYSICAL = (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: { P: {
  schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    name: { type: 'string' } } },
  physical: { ...(schema === null ? {} : { schema }), table: 'p', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'reject' } } } } } });
const PHYSICAL_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}p (id integer PRIMARY KEY, name text NOT NULL)`;

describe('a lone surrogate written to a column-only table', () => {
  it('is refused JD2003 by the writer and a native mutation, and nothing is stored', async () => {
    await onBothEnginesPhysical(PHYSICAL, PHYSICAL_DDL, async (store, host) => {
      const p = store.entity('P');
      await p.create({ id: 1, name: 'xy' });
      await assert.rejects(async () => p.create({ id: 2, name: 'x\uD800' }), lone('name'), host);
      await assert.rejects(async () => p.update(1, { name: 'y\uDC00' }), lone('name'), host);
      await assert.rejects(async () => p.mutate({ op: 'update', key: 1, set: { name: 'q\uD800' } }), lone('name'), host);
      await assert.rejects(async () => p.mutate({ op: 'upsert', values: { id: 3, name: 'u\uD800' }, conflict: ['id'], update: ['name'] }),
        lone('name'), host);
      assert.deepEqual((await p.load({})).map((/** @type {any} */ row) => [row.id, row.name]), [[1, 'xy']], host);
    });
  });

  it('is refused JD2003 by the unit of work, a replacement and an addition alike', async () => {
    for (const stage of /** @type {((p: any) => Promise<void>)[]} */ ([
      async (p) => p.put({ ...(await p.get(1)), name: 'v\uD800' }),
      async (p) => p.add({ id: 4, name: 'w\uD800' }),
    ])) {
      await onBothEnginesPhysical(PHYSICAL, PHYSICAL_DDL, async (store, host) => {
        const p = store.entity('P');
        await p.create({ id: 1, name: 'xy' });
        await stage(p);
        await assert.rejects(async () => store.saveChanges(), lone('name'), host);
        assert.deepEqual((await p.load({})).map((/** @type {any} */ row) => [row.id, row.name]), [[1, 'xy']], host);
      });
    }
  });
});
