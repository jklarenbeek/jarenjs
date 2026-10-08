//@ts-check
/**
 * @file Keys behave alike on both engines.
 *
 * A key string that names no number, written under a NUMERIC key column, is
 * refused before any statement (`JD2002`) — PostgreSQL's numeric input would
 * otherwise read `'0x10'` as 16 and replace that row, and store `'NaN'` under
 * a key no read can find, while every read binds such a string as NULL and
 * finds nothing (MODEL-FORMAT §6). The unit of work refuses it alike, in
 * `remove`, `link`, `unlink` and a membership array, and so does `create()`
 * with a membership array, before its insert — where PostgreSQL linked
 * `'0x10'` as tag 16 and SQLite failed the join row. A key a membership names
 * is refused naming the member it came from. Decimal text names its number in
 * a membership too: an unlink removes it, a link of one held is no change. A
 * document without its key is refused unless the key is allocated, and a
 * membership naming no row is one classification on both engines.
 *
 * An entity's single integer key with `default: "auto"` is allocated by the
 * database on both engines (MODEL-FORMAT §9.5): SQLite through its INTEGER
 * PRIMARY KEY, PostgreSQL through a `bigserial` key column, with the foreign
 * keys and join columns that reference it typed to match. A sequence does not
 * give back a number a rolled-back insert drew, so PostgreSQL keys can leave a
 * gap. A PostgreSQL table an earlier release created keeps its `numeric` key
 * and still opens; the documented upgrade gives it its sequence. A database
 * created while the key was `auto` opens under a model that dropped it.
 *
 * A name PostgreSQL cannot hold whole (63 bytes) is `JD0004` at the model
 * member when the model is planned, never the dialect's raw `TypeError`. So
 * is an index the plan would name as PostgreSQL names one of the table's own
 * objects (`<table>_pkey`, `<table>_<column>_seq`): the open skipped it, so
 * the member went unenforced and the next open failed `JD0002`. SQLite names
 * no such object and keeps the index.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ENGINES, PG_URL, skipFor, withStore, withPostgres, counted } from './store-core-engines.js';

const NO_NUMBER = ['0x10', '1_000', 'NaN', 'Infinity'];

const NUMBERED = {
  $model: '0.1',
  collections: {
    docs: { schema: { type: 'object', properties: { id: { type: 'number' } } }, key: '/id' },
    counted: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
  entities: {
    Doc: { schema: { type: 'object', properties: {
      id: { type: 'number', 'x-entity': { key: true } }, v: { type: 'string' } } } },
  },
};

const TAGGED = {
  $model: '0.1',
  entities: {
    Doc: { schema: { type: 'object', properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, v: { type: 'string' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Tag: { schema: { type: 'object', properties: { tid: { type: 'integer', 'x-entity': { key: true } } } } },
  },
};

const AUTO = {
  $model: '0.1',
  entities: {
    Post: { schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Comment: { schema: { type: 'object', properties: {
      cid: { type: 'string', 'x-entity': { key: true } }, postId: { type: 'integer' },
      post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'cascade' } } } } } },
    Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  },
};

for (const engine of ENGINES) {
  describe(`a numeric key column refuses a key that names no number (${engine})`, { skip: skipFor(engine) }, () => {
    it('a collection write is JD2002 before any statement, a read answers absent, and no other row moves', () =>
      withStore(engine, NUMBERED, async (store) => {
        const docs = store.collection('docs');
        await docs.put({ id: 16, v: 'sixteen' });
        for (const key of NO_NUMBER) {
          await assert.rejects(Promise.resolve().then(() => docs.put({ id: key, v: 'x' })), { code: 'JD2002' }, key);
          await assert.rejects(Promise.resolve().then(() => docs.insert({ id: key, v: 'x' })), { code: 'JD2002' }, key);
          assert.strictEqual(await docs.get(key), undefined, key);
          assert.strictEqual(await docs.delete(key), false, key);
        }
        assert.deepStrictEqual(await docs.all(), [{ id: 16, v: 'sixteen' }]);
        // decimal text still names its number, as before
        await docs.put({ id: '16', v: 'text' });
        assert.deepStrictEqual(await docs.all(), [{ id: '16', v: 'text' }]);
      }));

    it('an explicit key on an allocated integer identity is refused alike', () =>
      withStore(engine, NUMBERED, async (store) => {
        const counted = store.collection('counted');
        const key = await counted.insert({ n: 1 });
        await assert.rejects(Promise.resolve().then(() => counted.put({ n: 2 }, '0x1')), { code: 'JD2002' });
        assert.deepStrictEqual(await counted.get(key), { n: 1 });
        assert.deepStrictEqual(await counted.all(), [{ n: 1 }]);
      }));

    it('an entity write is refused alike — create(), and add() before the save', () =>
      withStore(engine, NUMBERED, async (store) => {
        const docs = store.entity('Doc');
        await docs.create({ id: 16, v: 'sixteen' });
        for (const key of NO_NUMBER) {
          await assert.rejects(Promise.resolve().then(() => docs.create({ id: key, v: 'x' })), { code: 'JD2002' }, key);
          assert.throws(() => docs.add({ id: key, v: 'x' }), { code: 'JD2002' }, key);
        }
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        assert.deepStrictEqual(await docs.load({}), [{ id: 16, v: 'sixteen' }]);
      }));

    it('the unit of work refuses it alike — remove(), link() and unlink() as they stage, a membership array at the save — and no row moves', () =>
      withStore(engine, TAGGED, async (store) => {
        const docs = store.entity('Doc');
        await docs.create({ id: 16, v: 'sixteen' });
        await store.entity('Tag').create({ tid: 16 });
        await store.entity('Tag').create({ tid: 1 });
        for (const key of NO_NUMBER) {
          assert.throws(() => docs.remove(key), { code: 'JD2002' }, `remove(${key})`);
          assert.throws(() => docs.remove({ id: key }), { code: 'JD2002' }, `remove({ id: ${key} })`);
          assert.throws(() => docs.link(16, 'tags', key), { code: 'JD2002' }, `link(16, tags, ${key})`);
          assert.throws(() => docs.link(16, 'tags', { tid: key }), { code: 'JD2002' }, `link(16, tags, { tid: ${key} })`);
          assert.throws(() => docs.link(key, 'tags', 1), { code: 'JD2002' }, `link(${key}, tags, 1)`);
          assert.throws(() => docs.link({ id: key }, 'tags', 1), { code: 'JD2002' }, `link({ id: ${key} }, tags, 1)`);
          assert.throws(() => docs.unlink(16, 'tags', key), { code: 'JD2002' }, `unlink(16, tags, ${key})`);
          assert.throws(() => docs.unlink(key, 'tags', 1), { code: 'JD2002' }, `unlink(${key}, tags, 1)`);
        }
        const { pendingDeletes, pendingMemberships } = store.stats().tracker;
        assert.deepStrictEqual({ pendingDeletes, pendingMemberships }, { pendingDeletes: 0, pendingMemberships: 0 });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        // a membership array is read when the save plans it, before any statement
        docs.add({ id: 17, tags: [1, '0x10'] });
        await assert.rejects(store.saveChanges(), { code: 'JD2002' });
        docs.discard(17);
        docs.put({ ...await docs.get(16), tags: ['1_000'] });
        await assert.rejects(store.saveChanges(), { code: 'JD2002' });
        docs.discard(16);
        assert.deepStrictEqual((await docs.asNoTracking().load({ include: { tags: true } }))
          .map((/** @type {any} */ doc) => [doc.id, doc.tags.map((/** @type {any} */ tag) => tag.tid)]), [[16, []]]);
        // decimal text still names its number
        docs.link(16, 'tags', '1');
        assert.strictEqual((await store.saveChanges()).joinInserted, 1);
      }));

    it('create() refuses a membership array carrying one before its insert, and every membership path names the member', () =>
      withStore(engine, TAGGED, async (store) => {
        const docs = store.entity('Doc');
        await store.entity('Tag').create({ tid: 16 });
        await store.entity('Tag').create({ tid: 1000 });
        /** JD2002 for `key`, naming the member it came from. @param {string} key */
        const refused = (key) => (/** @type {any} */ error) => error.code === 'JD2002' && error.key === key
          && error.message.includes(`the key ${JSON.stringify(key)} in 'tags' `);
        for (const key of NO_NUMBER) {
          await assert.rejects(async () => docs.create({ id: 1, tags: [key] }), refused(key), `create({ tags: [${key}] })`);
          await assert.rejects(async () => docs.create({ id: 2, tags: [16, { tid: key }] }), refused(key), `create({ tags: [16, { tid: ${key} }] })`);
        }
        // no row was written: neither the document nor a join row
        assert.deepStrictEqual(await docs.asNoTracking().load({}), []);
        // the unit of work's paths name it too: add() and put() at the save, link() and unlink() as they stage
        docs.add({ id: 3, tags: [16, '0x10'] });
        await assert.rejects(async () => store.saveChanges(), refused('0x10'), 'add() + saveChanges()');
        docs.discard(3);
        await docs.create({ id: 5, tags: [16] });
        docs.put({ ...await docs.get(5), tags: [16, 'NaN'] });
        await assert.rejects(async () => store.saveChanges(), refused('NaN'), 'put() + saveChanges()');
        docs.discard(5);
        assert.throws(() => docs.link(5, 'tags', '1_000'), refused('1_000'), 'link()');
        assert.throws(() => docs.unlink(5, 'tags', { tid: 'Infinity' }), refused('Infinity'), 'unlink()');
        assert.deepStrictEqual((await docs.asNoTracking().load({ include: { tags: true } }))
          .map((/** @type {any} */ doc) => [doc.id, doc.tags.map((/** @type {any} */ tag) => tag.tid)]), [[5, [16]]]);
        // decimal text still names its number
        assert.deepStrictEqual(await docs.create({ id: 6, tags: ['1000'] }), { id: 6, tags: ['1000'] });
        assert.deepStrictEqual((await docs.asNoTracking().load({ where: { $eq: ['$it.id', 6] }, include: { tags: true } }))
          .map((/** @type {any} */ doc) => doc.tags.map((/** @type {any} */ tag) => tag.tid)), [[1000]]);
      }));

    it('a membership key in decimal text names its number: unlink() removes the membership, a link() or put() of one held changes nothing', () =>
      withStore(engine, TAGGED, async (store) => {
        const docs = store.entity('Doc');
        await store.entity('Tag').create({ tid: 16 });
        await store.entity('Tag').create({ tid: 17 });
        await docs.create({ id: 2, tags: [16] });
        /** The tag ids a document holds. @param {number} id */
        const held = async (id) => (await docs.asNoTracking().load({ where: { $eq: ['$it.id', id] }, include: { tags: true } }))[0]
          .tags.map((/** @type {any} */ tag) => tag.tid).sort();
        for (const text of ['16', ' 16', '16.0']) {
          docs.unlink(2, 'tags', text);
          assert.strictEqual((await store.saveChanges()).joinDeleted, 1, `unlink ${JSON.stringify(text)}`);
          assert.deepStrictEqual(await held(2), []);
          // one membership, however its own key and its target are spelled
          docs.link('2', 'tags', 16);
          docs.link(2, 'tags', text);
          assert.strictEqual((await store.saveChanges()).joinInserted, 1, `link ${JSON.stringify(text)}`);
          docs.link(2, 'tags', text);
          assert.strictEqual((await store.saveChanges()).joinInserted, 0, `link ${JSON.stringify(text)} again`);
          assert.strictEqual(store.stats().tracker.pendingMemberships, 0);
          assert.deepStrictEqual(await held(2), [16]);
        }
        const [two] = await docs.load({ where: { $eq: ['$it.id', 2] }, include: { tags: true } });
        docs.put({ ...two, tags: ['16', '17'] });
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.joinInserted, report.joinDeleted], [1, 0]);
        assert.deepStrictEqual(await held(2), [16, 17]);
        // two spellings of one target in a membership array are one join row
        await docs.create({ id: 3, tags: [17, ' 17'] });
        docs.add({ id: 4, tags: ['16', 16] });
        assert.strictEqual((await store.saveChanges()).joinInserted, 1);
        assert.deepStrictEqual([await held(3), await held(4)], [[17], [16]]);
        // the unit of work files a row under the number its key names, so a
        // later word reaches it whichever spelling names it
        docs.add({ id: '30', v: 'thirty' });
        docs.remove(30);
        const { pendingInserts, pendingDeletes } = store.stats().tracker;
        assert.deepStrictEqual({ pendingInserts, pendingDeletes }, { pendingInserts: 0, pendingDeletes: 0 });
      }));
  });

  describe(`a write a key or a membership target is missing for (${engine})`, { skip: skipFor(engine) }, () => {
    it('a document without its key is refused before any statement unless the database allocates the key', () =>
      withStore(engine, TAGGED, async (store) => {
        const docs = store.entity('Doc');
        await assert.rejects(docs.create({ v: 'no key' }), { code: 'JD2002', message: /the key member 'id' is missing/ });
        assert.throws(() => docs.add({ v: 'no key' }), { code: 'JD2002' });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        assert.deepStrictEqual(await docs.asNoTracking().load({}), []);
      }));

    it('create() with a membership naming no row is JD2005, class constraint, with the driver error as its cause, and writes nothing', () =>
      withStore(engine, TAGGED, async (store) => {
        await assert.rejects(store.entity('Doc').create({ id: 20, tags: [999] }), (/** @type {any} */ error) =>
          error.code === 'JD2005' && error.class === 'constraint' && error.cause !== undefined && error.collection === 'Doc');
        assert.deepStrictEqual(await store.entity('Doc').asNoTracking().load({}), []);
      }));
  });

  describe(`a duplicate key is JD2001 under a name PostgreSQL clips its key name for (${engine})`, { skip: skipFor(engine) }, () => {
    for (const name of [58, 59, 62, 63].map((bytes) => 'E'.padEnd(bytes, 'x'))) {
      it(`an entity and a collection named in ${name.length} bytes`, () =>
        withStore(engine, {
          $model: '0.1',
          entities: { [name]: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } } },
          collections: { [`c${name.slice(1)}`]: { schema: { type: 'object' }, key: '/id' } },
        }, async (store) => {
          const duplicate = { code: 'JD2001', class: 'duplicate' };
          await store.entity(name).create({ id: 'a' });
          await assert.rejects(store.entity(name).create({ id: 'a' }), duplicate, 'create()');
          store.entity(name).add({ id: 'a' });
          await assert.rejects(store.saveChanges(), duplicate, 'saveChanges()');
          store.entity(name).discard('a');
          const collection = store.collection(`c${name.slice(1)}`);
          await collection.insert({ id: 'a' });
          await assert.rejects(collection.insert({ id: 'a' }), duplicate, 'a collection insert');
        }));
    }
  });

  describe(`default: "auto" allocates an entity key (${engine})`, { skip: skipFor(engine) }, () => {
    it('through create(), through add() and saveChanges(), again after a rolled-back save, and for the rows that reference it', () =>
      withStore(engine, AUTO, async (store) => {
        const posts = store.entity('Post');
        assert.deepStrictEqual(await posts.create({ title: 'x' }), { title: 'x', pid: 1 });
        const added = posts.add({ title: 'y' });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 1, updated: 0, deleted: 0 });
        assert.strictEqual(added.pid, undefined, 'the staged document stays as it was handed in');
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Post').add({ title: 'z' });
          await tx.saveChanges();
          throw new Error('undo');
        }), /undo/);
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 1, updated: 0, deleted: 0 });
        // SQLite's INTEGER PRIMARY KEY hands out the next free number again; a
        // PostgreSQL sequence never gives back the one the rolled-back save drew
        const keys = (await posts.load({ orderBy: '$it.pid' })).map((/** @type {any} */ post) => post.pid);
        assert.deepStrictEqual(keys, engine === 'sqlite' ? [1, 2, 3] : [1, 2, 4]);
        await store.entity('Comment').create({ cid: 'c1', postId: 1 });
        await store.entity('Tag').create({ name: 'red' });
        posts.link(1, 'tags', 'red');
        assert.strictEqual((await store.saveChanges()).joinInserted, 1);
        const [first] = await posts.load({ where: { $eq: ['$it.pid', 1] }, include: { tags: true } });
        assert.deepStrictEqual(first.tags.map((/** @type {any} */ tag) => tag.name), ['red']);
        assert.deepStrictEqual(await store.entity('Comment').get('c1'), { cid: 'c1', postId: 1 });
        await posts.delete(1);
        assert.strictEqual(await store.entity('Comment').get('c1'), undefined, 'the cascade reached the child');
      }));

    it('an explicit key is still written as given', () =>
      withStore(engine, AUTO, async (store) => {
        assert.deepStrictEqual(await store.entity('Post').create({ pid: 40, title: 'explicit' }), { pid: 40, title: 'explicit' });
      }));

    it('SQLite allocates past an explicit key; a PostgreSQL sequence does not see it, so the allocation that meets it is JD2001', () =>
      withStore(engine, AUTO, async (store) => {
        const posts = store.entity('Post');
        await posts.create({ pid: 1, title: 'explicit' });
        if (engine === 'postgres') {
          await assert.rejects(posts.create({ title: 'next' }),
            { code: 'JD2001', message: /a 'Post' already exists under the key the database allocated/ });
        }
        assert.deepStrictEqual(await posts.create({ title: 'next' }), { title: 'next', pid: 2 });
      }));
  });
}

describe('a physical key column refuses a key its codec cannot hold, or none, where the write is staged, and a read by one answers absent', () => {
  const column = (/** @type {string} */ name, /** @type {string} */ codec) => ({ name, codec, null: 'reject' });
  const PHYSICAL = { $model: '0.1', entities: { Doc: {
    schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' } } },
    physical: { table: 'docs', columns: { id: column('id', 'integer'), title: column('title', 'text') } } } } };
  /** @param {any} store */
  const body = async (store) => {
    const docs = store.entity('Doc');
    await docs.create({ id: 16, title: 'sixteen' });
    for (const key of ['0x10', 'NaN', '16.0']) {
      assert.strictEqual(await docs.get(key), undefined, `get(${key})`);
      assert.throws(() => docs.remove(key), { code: 'JD2003' }, `remove(${key})`);
    }
    // a document without its key is refused as add() and create() take it
    assert.throws(() => docs.add({ title: 'no key' }), { code: 'JD2002' });
    await assert.rejects(docs.create({ title: 'no key' }), { code: 'JD2002' });
    const { pendingInserts, pendingDeletes } = store.stats().tracker;
    assert.deepStrictEqual({ pendingInserts, pendingDeletes }, { pendingInserts: 0, pendingDeletes: 0 });
    assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
    assert.deepStrictEqual((await docs.asNoTracking().load({})).map((/** @type {any} */ doc) => doc.id), [16]);
  };
  it('on SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-physical-key-'));
    try {
      const database = new DatabaseSync(join(dir, 'db.sqlite'));
      database.exec('CREATE TABLE docs(id integer PRIMARY KEY, title text NOT NULL)');
      database.close();
      const store = await openStore(PHYSICAL, { driver: nodeDriver(), path: join(dir, 'db.sqlite'), adopt: true });
      try { await body(store); }
      finally { await store.close(); }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('on PostgreSQL', { skip: skipFor('postgres') }, () => withPostgres(async ({ pool, schema, driver }) => {
    await pool.query(`CREATE TABLE "${schema}".docs(id integer PRIMARY KEY, title text NOT NULL)`);
    const store = await openStore(PHYSICAL, { driver: driver(), adopt: true });
    try { await body(store); }
    finally { await store.close(); }
  }));
});

describe('what PostgreSQL jsonb cannot store, as the README and REPLICATION-FORMAT declare', () => {
  const DOCS = { $model: '0.1', collections: { docs: { schema: { type: 'object' }, key: '/id' } } };
  for (const engine of ENGINES) {
    it(`a string holding U+0000 or an unpaired surrogate (${engine})`, { skip: skipFor(engine) }, () =>
      withStore(engine, DOCS, async (store) => {
        const docs = store.collection('docs');
        const outcome = async (/** @type {() => any} */ fn) => {
          try { return { value: await fn() }; }
          catch (/** @type {any} */ error) { return { code: error.code }; }
        };
        const written = [await outcome(() => docs.put({ id: 'a', s: 'x\u0000y' })), await outcome(() => docs.put({ id: 'b', s: '\uD800' })),
          await outcome(() => docs.get('k\u0000'))];
        assert.deepStrictEqual(written, engine === 'sqlite'
          ? [{ value: 'a' }, { value: 'b' }, { value: undefined }]
          : [{ code: 'JD2005' }, { code: 'JD2005' }, { code: 'JD2005' }]);
        if (engine === 'sqlite') assert.deepStrictEqual(await docs.get('a'), { id: 'a', s: 'x\u0000y' });
      }));
  }

  it('so a SQLite-origin envelope carrying one does not apply to a PostgreSQL replica', { skip: skipFor('postgres') }, async () => {
    const source = await openStore(DOCS, { driver: nodeDriver(), replication: { replica: 'site-a' } });
    try {
      for (const doc of [{ id: 'x', v: 1 }, { id: 'nul', s: 'a\u0000b' }, { id: 'y', v: 2 }]) await source.collection('docs').put(doc);
      const page = await source.replication.page({ after: 0, limit: 100 });
      const snapshot = await source.replication.snapshot();
      await withPostgres(async ({ driver }) => {
        const replica = await openStore(DOCS, { driver: driver(), replication: { replica: 'site-p' } });
        try {
          const applied = [];
          for (const envelope of page.items) {
            try { applied.push((await replica.replication.apply(envelope)).status); }
            catch (/** @type {any} */ error) { applied.push(error.code); }
          }
          assert.deepStrictEqual(applied, ['applied', 'JD2005', 'JD2100']);
          await assert.rejects(replica.replication.reset(snapshot), { code: 'JD2005' });
        }
        finally { await replica.close(); }
      });
    }
    finally { await source.close(); }
  });
});

describe('a PostgreSQL auto key table an earlier release created', { skip: skipFor('postgres') }, () => {
  // the DDL this package wrote for the AUTO model before the key was allocated
  const LEGACY = [
    'CREATE TABLE "Post" ("pid" numeric PRIMARY KEY, "title" text COLLATE "C", "doc" jsonb NOT NULL, "rid" bigserial)',
    'CREATE TABLE "Comment" ("cid" text COLLATE "C" PRIMARY KEY, "postId" numeric REFERENCES "Post" ("pid") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE, "doc" jsonb NOT NULL, "rid" bigserial)',
    'CREATE UNIQUE INDEX "Comment_postId" ON "Comment" ("postId")',
    'CREATE TABLE "Tag" ("name" text COLLATE "C" PRIMARY KEY, "doc" jsonb NOT NULL, "rid" bigserial)',
    'CREATE TABLE "Post_Tag" ("Post_key" numeric REFERENCES "Post" ("pid") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE, "Tag_key" text COLLATE "C" REFERENCES "Tag" ("name") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE, "rid" bigserial, PRIMARY KEY ("Post_key", "Tag_key"))',
  ];
  /** Run statements with the schema on the search path. @param {any} pool @param {string} schema @param {string[]} statements */
  const inSchema = async (pool, schema, statements) => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      for (const sql of statements) await client.query(sql);
    }
    finally {
      await client.query('RESET search_path');
      client.release();
    }
  };

  it('still opens with its numeric key: explicit keys work, an allocated one is refused by the database until the upgrade gives the column its sequence', () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await inSchema(pool, schema, LEGACY);
      let store = await openStore(AUTO, { driver: driver() });
      try {
        assert.deepStrictEqual(await store.entity('Post').create({ pid: 7, title: 'kept' }), { pid: 7, title: 'kept' });
        await store.entity('Comment').create({ cid: 'c7', postId: 7 });
        await assert.rejects(store.entity('Post').create({ title: 'auto' }), { code: 'JD2005' });
      }
      finally { await store.close(); }
      // the upgrade recipe MIGRATION-UPGRADE documents: referencing columns first
      await inSchema(pool, schema, [
        'ALTER TABLE "Comment" ALTER COLUMN "postId" TYPE bigint',
        'ALTER TABLE "Post_Tag" ALTER COLUMN "Post_key" TYPE bigint',
        'ALTER TABLE "Post" ALTER COLUMN "pid" TYPE bigint',
        'CREATE SEQUENCE "Post_pid_seq" OWNED BY "Post"."pid"',
        'ALTER TABLE "Post" ALTER COLUMN "pid" SET DEFAULT nextval(\'"Post_pid_seq"\')',
        'SELECT setval(\'"Post_pid_seq"\', COALESCE((SELECT max("pid") FROM "Post"), 0) + 1, false)',
      ]);
      store = await openStore(AUTO, { driver: driver() });
      try {
        assert.deepStrictEqual(await store.entity('Post').create({ title: 'auto' }), { title: 'auto', pid: 8 });
        assert.deepStrictEqual(await store.entity('Comment').get('c7'), { cid: 'c7', postId: 7 });
      }
      finally { await store.close(); }
    }));

  it('a fresh table declares the allocation, and the catalog agrees', () =>
    withStore('postgres', AUTO, async (store, pg) => {
      await store.entity('Post').create({ title: 'x' });
      const { rows } = await /** @type {any} */ (pg).pool.query(`SELECT table_name, column_name, data_type, column_default IS NOT NULL AS allocated
        FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('pid', 'postId', 'Post_key') ORDER BY table_name`, [/** @type {any} */ (pg).schema]);
      assert.deepStrictEqual(rows.map((/** @type {any} */ row) => [row.table_name, row.column_name, row.data_type, row.allocated]), [
        ['Comment', 'postId', 'bigint', false],
        ['Post', 'pid', 'bigint', true],
        ['Post_Tag', 'Post_key', 'bigint', false],
      ]);
    }));
});

describe('a PostgreSQL database created while an entity key was auto', { skip: skipFor('postgres') }, () => {
  /** The AUTO model with the key the caller's again. */
  const MANUAL = structuredClone(AUTO);
  MANUAL.entities.Post.schema.properties.pid['x-entity'] = { key: true };

  it('opens under a model that no longer declares auto: explicit keys and the rows that reference them work, and auto declared again resumes the sequence', () =>
    withPostgres(async ({ driver }) => {
      let store = await openStore(AUTO, { driver: driver() });
      try { assert.deepStrictEqual(await store.entity('Post').create({ title: 'a' }), { title: 'a', pid: 1 }); }
      finally { await store.close(); }
      store = await openStore(MANUAL, { driver: driver() });
      try {
        assert.deepStrictEqual(await store.entity('Post').create({ pid: 50, title: 'explicit' }), { pid: 50, title: 'explicit' });
        assert.deepStrictEqual(await store.entity('Comment').create({ cid: 'c50', postId: 50 }), { cid: 'c50', postId: 50 });
        await store.entity('Tag').create({ name: 'red' });
        store.entity('Post').link(50, 'tags', 'red');
        assert.strictEqual((await store.saveChanges()).joinInserted, 1);
      }
      finally { await store.close(); }
      store = await openStore(AUTO, { driver: driver() });
      try {
        assert.deepStrictEqual(await store.entity('Post').create({ title: 'b' }), { title: 'b', pid: 2 });
        const keys = (await store.entity('Post').load({ orderBy: '$it.pid' })).map((/** @type {any} */ post) => post.pid);
        assert.deepStrictEqual(keys, [1, 2, 50]);
      }
      finally { await store.close(); }
    }));
});

describe('a name PostgreSQL cannot hold is refused when the model is planned', () => {
  const LONG = 'm'.repeat(61);
  const KEY = { id: { type: 'string', 'x-entity': { key: true } } };
  /** Each model, the member its refusal names and where. */
  const CASES = [
    ['an index over a long member', { $model: '0.1', collections: { c: { schema: { type: 'object', properties: { [LONG]: { type: 'string' } } },
      key: '/id', indexes: [{ name: 'byM', path: `$.${LONG}` }] } } }, `gx_${LONG}`, '/collections/c/indexes/0/path'],
    ['a long index name', { $model: '0.1', collections: { c: { schema: { type: 'object' }, key: '/id', indexes: [{ name: 'i'.repeat(62), path: '$.a' }] } } },
      `c_${'i'.repeat(62)}`, '/collections/c/indexes/0/name'],
    ['a unique long property', { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { ...KEY,
      ['p'.repeat(62)]: { type: 'string', 'x-entity': { unique: true } } } } } } }, `E_${'p'.repeat(62)}`, `/entities/E/schema/properties/${'p'.repeat(62)}`],
    ['a long property', { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { ...KEY,
      ['q'.repeat(64)]: { type: 'string' } } } } } }, 'q'.repeat(64), `/entities/E/schema/properties/${'q'.repeat(64)}`],
  ];
  for (const [label, model, name, docPath] of CASES) {
    it(`${label}: JD0004 naming it and the 63-byte limit on PostgreSQL, opened on SQLite`, async () => {
      if (PG_URL) {
        await withPostgres(async ({ pool, schema, driver }) => {
          await assert.rejects(Promise.resolve().then(() => openStore(model, { driver: driver() })), (/** @type {any} */ error) => {
            assert.strictEqual(error.code, 'JD0004');
            assert.strictEqual(error.docPath, docPath);
            assert.ok(error.message.includes(`'${name}'`) && error.message.includes('63 bytes'), error.message);
            return true;
          });
          const { rows } = await pool.query('SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = $1', [schema]);
          assert.strictEqual(rows[0].tables, 0, 'nothing was created');
        });
      }
      const store = await openStore(model, { driver: nodeDriver() });
      await store.close();
    });
  }
});

describe('an index named as PostgreSQL names one of the table\'s own objects is refused when the model is planned', () => {
  const KEY = { id: { type: 'string', 'x-entity': { key: true } } };
  /** An entity whose `member` is unique, written twice with one value. @param {string} member */
  const uniqueMember = (member) => ({ $model: '0.1', entities: { E: { schema: { type: 'object', properties: { ...KEY,
    [member]: { type: 'string', 'x-entity': { unique: true } } } } } } });
  /** Two entity writes that differ in the key and agree on `member`. @param {string} member */
  const twice = (member) => async (/** @type {any} */ store) => {
    await store.entity('E').create({ id: 'a', [member]: 'same' });
    await store.entity('E').create({ id: 'b', [member]: 'same' });
  };
  /** Each model, the name its index would take, the refusal's docPath, and two writes the index refuses. */
  const CASES = /** @type {[string, any, string, string, (store: any) => Promise<void>][]} */ ([
    ['a unique member named pkey (the primary key\'s index)', uniqueMember('pkey'), 'E_pkey', '/entities/E/schema/properties/pkey', twice('pkey')],
    ['a unique member named rid_seq (the identity column\'s sequence)', uniqueMember('rid_seq'), 'E_rid_seq', '/entities/E/schema/properties/rid_seq', twice('rid_seq')],
    ['a unique member named after an allocated key\'s sequence', { $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
      pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, pid_seq: { type: 'string', 'x-entity': { unique: true } } } } } } },
    'Post_pid_seq', '/entities/Post/schema/properties/pid_seq', async (store) => {
      await store.entity('Post').create({ pid_seq: 'same' });
      await store.entity('Post').create({ pid_seq: 'same' });
    }],
    ['a collection index named pkey', { $model: '0.1', collections: { c: { schema: { type: 'object' }, key: '/id',
      indexes: [{ name: 'pkey', path: '$.v', unique: true }] } } }, 'c_pkey', '/collections/c/indexes/0/name', async (store) => {
      await store.collection('c').put({ id: 'a', v: 'same' });
      await store.collection('c').put({ id: 'b', v: 'same' });
    }],
    ['an index named key_seq on an allocated integer identity', { $model: '0.1', collections: { c: { schema: { type: 'object' }, key: null,
      identity: 'integer', indexes: [{ name: 'key_seq', path: '$.v', unique: true }] } } }, 'c_key_seq', '/collections/c/indexes/0/name', async (store) => {
      await store.collection('c').insert({ v: 'same' });
      await store.collection('c').insert({ v: 'same' });
    }],
  ]);
  for (const [label, model, name, docPath, writeTwice] of CASES) {
    it(`${label}: JD0004 at the member on PostgreSQL, before any statement; SQLite keeps the index`, async () => {
      if (PG_URL) {
        await withPostgres(async ({ pool, schema, driver }) => {
          // a store that opens after all is closed, so its schema can be dropped
          const error = await Promise.resolve().then(() => openStore(model, { driver: driver() }))
            .then(async (/** @type {any} */ store) => { await store.close(); return null; }, (/** @type {any} */ refused) => refused);
          assert.ok(error !== null, 'the open is refused');
          assert.strictEqual(error.code, 'JD0004');
          assert.strictEqual(error.docPath, docPath);
          assert.ok(error.message.includes(`'${name}'`) && /rename/.test(error.message), error.message);
          const { rows } = await pool.query('SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = $1', [schema]);
          assert.strictEqual(rows[0].tables, 0, 'nothing was created');
        });
      }
      await withStore('sqlite', model, async (store) => {
        await assert.rejects(async () => writeTwice(store), (/** @type {any} */ error) => ['JD2001', 'JD2005'].includes(error.code)
          && /UNIQUE constraint failed/.test(error.cause?.message ?? ''), 'the unique index holds');
      });
    });
  }

  it('a foreign-key or check constraint is no relation: an index over a member named like one is created and enforced on both engines', async () => {
    // `E_parentId_fkey` and `E_status_check` are the names PostgreSQL gives
    // E's foreign key and its check constraint
    const MODEL = { $model: '0.1', entities: {
      P: { schema: { type: 'object', properties: { ...KEY,
        kids: { 'x-entity': { relation: { to: 'E', many: true, via: 'parentId', onDelete: 'cascade' } } } } } },
      E: { schema: { type: 'object', properties: { ...KEY, parentId: { type: 'string' }, status: { type: 'string', enum: ['a', 'b'] },
        parentId_fkey: { type: 'string', 'x-entity': { unique: true } }, status_check: { type: 'string', 'x-entity': { unique: true } } } } } } };
    for (const engine of ENGINES) {
      if (skipFor(engine)) continue;
      await withStore(engine, MODEL, async (store, pg) => {
        if (pg !== null) {
          const { rows } = await pg.pool.query(`SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE n.nspname = $1 AND c.conname IN ('E_parentId_fkey', 'E_status_check') ORDER BY 1`, [pg.schema]);
          assert.deepStrictEqual(rows.map((/** @type {any} */ row) => row.conname), ['E_parentId_fkey', 'E_status_check']);
        }
        await store.entity('P').create({ id: 'p' });
        await store.entity('E').create({ id: 'a', parentId: 'p', status: 'a', parentId_fkey: 'x', status_check: 'x' });
        for (const [member, other] of [['parentId_fkey', 'status_check'], ['status_check', 'parentId_fkey']]) {
          await assert.rejects(async () => store.entity('E').create({ id: `b-${member}`, parentId: 'p', status: 'a', [member]: 'x', [other]: member }),
            { code: 'JD2005' }, `${engine}: ${member}`);
        }
      });
    }
  });
});

describe('a member whose column the table already has is refused when the model is planned', () => {
  /** A `Doc` with its integer key and one more member. @param {string} member */
  const model = (member) => ({ $model: '0.1', entities: { Doc: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, [member]: { type: 'string' } } } } } });
  /** @param {string} engine @param {any} declared @returns {Promise<any>} the open's refusal, or null */
  const refusal = async (engine, declared) => {
    try { await withStore(engine, declared, async () => {}); return null; }
    catch (error) { return error; }
  };
  /** Each member, and on each engine the column it would take or null where the engine keeps it apart. */
  const CASES = [
    ['doc', { sqlite: 'the document column', postgres: 'the document column' }],
    ['DOC', { sqlite: 'the document column', postgres: null }],
    ['rid', { sqlite: null, postgres: 'the row identity column' }],
    ['Id', { sqlite: "the column for 'id'", postgres: null }],
  ];
  for (const engine of ENGINES) {
    it(`on ${engine}: JD0004 at the member, naming the column it would share, never the engine's own duplicate-column error`, { skip: skipFor(engine) }, async () => {
      for (const [member, taken] of CASES) {
        const error = await refusal(engine, model(member));
        if (taken[engine] === null) { assert.strictEqual(error, null, `${engine}: ${member} opens: ${error?.message}`); continue; }
        assert.ok(error !== null, `${engine}: ${member} is refused`);
        assert.strictEqual(error.code, 'JD0004', `${engine}: ${member}: ${error.message}`);
        assert.strictEqual(error.docPath, `/entities/Doc/schema/properties/${member}`);
        assert.ok(error.message.includes(taken[engine]), error.message);
      }
    });
  }
});
