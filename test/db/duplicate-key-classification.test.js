//@ts-check
/**
 * @file A duplicate key is the collision on the key's own constraint,
 * whatever that constraint is called, and a write that collides on its key
 * and on another unique member at once is a duplicate key on both engines.
 * PostgreSQL names the key constraint in its catalog, which the store reads
 * when it opens (a renamed table keeps the key name it was created with, an
 * adopted table keeps its own, and a unique member may be named like a key's
 * index). SQLite reports the first constraint it checks, so a UNIQUE failure
 * that does not name the key is followed by one read of the key the write
 * carried; a collision on any other unique member alone stays a constraint
 * failure naming it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planModelMigration, migrate, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { postgresDialect } from '@jarenjs/db/postgres';
import { DatabaseSync } from 'node:sqlite';
import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';
import { adopted, asyncWasmHandle, tempDbPath } from './helpers.js';

const uniqueText = () => ({ type: 'string', 'x-entity': { unique: true } });

/** `Post` keyed by `pid`, with a unique `slug` and a unique member named like a key's index.
 * @param {string} [pidType] @param {boolean} [pkey1] */
const postModel = (pidType = 'string', pkey1 = true) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
  pid: { type: pidType, 'x-entity': { key: true } }, slug: uniqueText(), ...(pkey1 ? { pkey1: uniqueText() } : {}) } } } } });

/** The same entity renamed to `Article` by a migration. @param {string} pidType */
const articleModel = (pidType) => ({ $model: '0.1', entities: { Article: { 'x-rename': 'Post', ...postModel(pidType).entities.Post } } });

const rowsCollection = { schema: { type: 'object' }, key: '/id', indexes: [{ name: 'byN', path: '$.n', unique: true }] };
const rowsModel = { $model: '0.1', collections: { rows: rowsCollection } };
const itemsModel = { $model: '0.1', collections: { items: { 'x-rename': 'rows', ...rowsCollection } } };

/** A composite key (`a`, `b`) beside a unique member. */
const pairModel = { $model: '0.1', entities: { Pair: { schema: { type: 'object', properties: {
  a: { type: 'integer', 'x-entity': { key: true } }, b: { type: 'string', 'x-entity': { key: true } }, s: uniqueText() } } } } };

/** What a call is refused with, or `null`. @param {() => any} run */
async function refusal(run) {
  try { await run(); }
  catch (error) { return { code: /** @type {any} */ (error).code, message: /** @type {any} */ (error).message }; }
  return null;
}

/**
 * A database of its own on `engine`: a store opener, the target a migration
 * runs against, the dialect it plans for, and raw SQL.
 * @param {string} engine
 * @param {(db: { engine: string, open: (model: any, options?: any) => Promise<any>, target: () => any, dialect: any,
 *   raw: (sql: string) => Promise<any>, schema: string | null }) => Promise<void>} fn
 */
async function withDatabase(engine, fn) {
  if (engine === 'sqlite') {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await fn({ engine, schema: null, dialect: sqliteDialect,
        open: (model, options = {}) => openStore(model, { driver: nodeDriver(), path: dbPath, ...options }),
        target: () => ({ driver: nodeDriver(), path: dbPath }),
        raw: async (sql) => { const db = new DatabaseSync(dbPath); try { db.exec(sql); } finally { db.close(); } } });
    }
    finally { cleanup(); }
    return;
  }
  await withPostgres(async ({ pool, schema, driver }) => fn({ engine, schema, dialect: postgresDialect({ schema }),
    open: (model, options = {}) => openStore(model, { driver: driver(), ...options }),
    target: () => ({ driver: driver() }),
    raw: (sql) => pool.query(sql) }));
}

/** @param {any} db @param {any} model @param {(store: any) => Promise<void>} fn @param {any} [options] */
async function withOpen(db, model, fn, options = {}) {
  const store = await db.open(model, options);
  try { await fn(store); }
  finally { await store.close(); }
}

/** Apply the migration from `from` to `to` without its draft transforms. @param {any} db @param {any} from @param {any} to */
async function renameTo(db, from, to) {
  const plan = planModelMigration(from, to, { dialect: db.dialect, id: 'rename' });
  plan.migration.steps = plan.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  const run = await migrate(db.target(), [plan.migration], { baseline: from, model: to, shadow: false });
  assert.deepEqual(run.applied, ['rename']);
}

/**
 * Run `fn` with every statement `node:sqlite` executes recorded, in order, and
 * every `SELECT 1` prepared while `refuseReads` is set refused: the statements a
 * store runs outside its open reach the binding through scopes of the driver's
 * own, so the binding is the one place all of them pass.
 * @param {(ran: string[]) => Promise<void>} fn @param {boolean} [refuseReads]
 */
async function recordingStatements(fn, refuseReads = false) {
  /** @type {string[]} */
  const ran = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (/** @type {string} */ sql, /** @type {any[]} */ ...rest) {
    if (refuseReads && /^SELECT 1 /.test(sql)) { ran.push(sql); throw new Error('the read is refused'); }
    const statement = prepare.call(this, sql, ...rest);
    for (const method of /** @type {const} */ (['run', 'get', 'all', 'iterate'])) {
      const original = /** @type {Function} */ (statement[method]);
      /** @type {any} */ (statement)[method] = function (/** @type {any[]} */ ...args) { ran.push(sql); return original.apply(this, args); };
    }
    return statement;
  };
  try { await fn(ran); }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

/** The key reads among statements. @param {string[]} ran */
const keyReads = (ran) => ran.filter((sql) => /^SELECT 1 /.test(sql));

const PG_REJECTED = 'JD2005: the database rejected the operation: duplicate key value violates unique constraint';

for (const engine of ENGINES) {
  describe(`${engine}: a duplicate key is the collision on the key's own constraint`, { skip: skipFor(engine) }, () => {
    for (const pidType of ['string', 'integer']) {
      it(`a renamed entity keeps JD2001 for a duplicate ${pidType} key`, async () => {
        const key = pidType === 'string' ? 'a' : 1;
        await withDatabase(engine, async (db) => {
          await withOpen(db, postModel(pidType), (store) => store.entity('Post').create({ pid: key, slug: 's1', pkey1: 'p1' }));
          await renameTo(db, postModel(pidType), articleModel(pidType));
          await withOpen(db, articleModel(pidType), async (store) => {
            assert.deepEqual(await refusal(() => store.entity('Article').create({ pid: key, slug: 's2', pkey1: 'p2' })),
              { code: 'JD2001', message: `JD2001: a 'Article' already exists under key ${JSON.stringify(key)} at /entities/Article` });
            assert.equal((await refusal(() => store.entity('Article').create({ pid: pidType === 'string' ? 'b' : 2, slug: 's1', pkey1: 'p3' })))?.code, 'JD2005',
              'a collision on a unique member alone is still a constraint failure');
            assert.equal((await refusal(() => store.entity('Article').create({ pid: key, slug: 's1', pkey1: 'p9' })))?.code, 'JD2001',
              'the key and a unique member at once');
          });
        });
      });
    }

    it('a renamed collection keeps JD2001 for a duplicate key', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, rowsModel, (store) => store.collection('rows').insert({ id: 'a', n: 1 }));
        await renameTo(db, rowsModel, itemsModel);
        await withOpen(db, itemsModel, async (store) => {
          assert.deepEqual(await refusal(() => store.collection('items').insert({ id: 'a', n: 2 })),
            { code: 'JD2001', message: "JD2001: a document already exists under key 'a' at /collections/items" });
        });
      });
    });

    it('a unique member named like a key index is a constraint failure naming its index, never a duplicate key', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, postModel(), async (store) => {
          await store.entity('Post').create({ pid: 'a', slug: 's1', pkey1: 'p1' });
          const refused = await refusal(() => store.entity('Post').create({ pid: 'b', slug: 's2', pkey1: 'p1' }));
          assert.deepEqual(refused, { code: 'JD2005', message: engine === 'postgres'
            ? `${PG_REJECTED} "Post_pkey1" at /entities/Post`
            : 'JD2005: the database rejected the operation: UNIQUE constraint failed: Post.pkey1 at /entities/Post' });
        });
      });
    });

    const bothKeyAndSlug = "JD2001: a 'Post' already exists under key \"a\" at /entities/Post";

    it('create() colliding on its key and on a unique member reads JD2001', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, postModel('string', false), async (store) => {
          const posts = store.entity('Post');
          await posts.create({ pid: 'a', slug: 's1' });
          assert.deepEqual(await refusal(() => posts.create({ pid: 'a', slug: 's1' })), { code: 'JD2001', message: bothKeyAndSlug });
          assert.equal((await refusal(() => posts.create({ pid: 'b', slug: 's1' })))?.code, 'JD2005', 'the unique member alone');
        });
      });
    });

    it('a saved add() colliding on its key and on a unique member reads JD2001', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, postModel('string', false), async (store) => {
          const posts = store.entity('Post');
          await posts.create({ pid: 'a', slug: 's1' });
          posts.add({ pid: 'a', slug: 's1' });
          assert.deepEqual(await refusal(() => store.saveChanges()), { code: 'JD2001', message: bothKeyAndSlug });
        });
      });
    });

    it('a collection insert() colliding on its key and on a unique index reads JD2001', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, rowsModel, async (store) => {
          const rows = store.collection('rows');
          await rows.insert({ id: 'a', n: 1 });
          assert.deepEqual(await refusal(() => rows.insert({ id: 'a', n: 1 })),
            { code: 'JD2001', message: "JD2001: a document already exists under key 'a' at /collections/rows" });
          assert.equal((await refusal(() => rows.insert({ id: 'b', n: 1 })))?.code, 'JD2005', 'byN alone');
        });
      });
    });

    it('a saved batch reads JD2001 naming every key it carried when one record collides on its key and a unique member', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, postModel('string', false), (store) => store.entity('Post').create({ pid: 'z', slug: 's1' }));
        // a store of its own, so the statement holds the keys in the order they were added: the colliding one last
        await withOpen(db, postModel('string', false), async (store) => {
          const posts = store.entity('Post');
          posts.add({ pid: 'c', slug: 's3' });
          posts.add({ pid: 'z', slug: 's1' });
          assert.deepEqual(await refusal(() => store.saveChanges()),
            { code: 'JD2001', message: "JD2001: a 'Post' already exists under one of the keys \"c\", \"z\" at /entities/Post" });
          assert.equal(await posts.get('c'), undefined, 'the failed save wrote nothing');
        });
      });
    });

    it('an integer key colliding with a unique member is a duplicate key as it always was', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, postModel('integer', false), async (store) => {
          await store.entity('Post').create({ pid: 1, slug: 's1' });
          assert.deepEqual(await refusal(() => store.entity('Post').create({ pid: 1, slug: 's1' })),
            { code: 'JD2001', message: "JD2001: a 'Post' already exists under key 1 at /entities/Post" });
        });
      });
    });

    it('a composite key is a duplicate key naming every member, alone or beside a unique member', async () => {
      await withDatabase(engine, async (db) => {
        await withOpen(db, pairModel, async (store) => {
          const pairs = store.entity('Pair');
          await pairs.create({ a: 1, b: 'x', s: 's1' });
          const key = { code: 'JD2001', message: "JD2001: a 'Pair' already exists under key {\"a\":1,\"b\":\"x\"} at /entities/Pair" };
          assert.deepEqual(await refusal(() => pairs.create({ a: 1, b: 'x', s: 's2' })), key, 'the key alone');
          assert.deepEqual(await refusal(() => pairs.create({ a: 1, b: 'x', s: 's1' })), key, 'the key and s');
          const member = await refusal(() => pairs.create({ a: 2, b: 'y', s: 's1' }));
          assert.equal(member?.code, 'JD2005', 's alone');
          assert.match(String(member?.message), engine === 'postgres' ? /"Pair_s"/ : /Pair\.s\b/);
          // an update that collides on a unique member is not the key's collision
          await pairs.create({ a: 2, b: 'y', s: 's2' });
          const changed = await refusal(() => pairs.update({ a: 2, b: 'y' }, { s: 's1' }));
          assert.equal(changed?.code, 'JD2005', 'an update onto another row\'s s');
          assert.match(String(changed?.message), engine === 'postgres' ? /"Pair_s"/ : /Pair\.s\b/);
        });
      });
    });
  });
}

describe('postgres: an adopted table keeps the name its own key was given', { skip: skipFor('postgres') }, () => {
  /** @param {string} schema @param {string} table */
  const itemModel = (schema, table) => ({ $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, label: { type: 'string' } } },
  physical: { schema, table, columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, label: { name: 'label', codec: 'text', null: 'reject' } } } } } });

  for (const named of [true, false]) {
    it(`a key ${named ? 'declared CONSTRAINT pk_items' : 'left unnamed (items_pkey)'} reads JD2001 for a duplicate`, async () => {
      await withDatabase('postgres', async (db) => {
        const s = `"${db.schema}"`;
        await db.raw(`CREATE TABLE ${s}.items (id integer, label text NOT NULL, ${named ? 'CONSTRAINT pk_items ' : ''}PRIMARY KEY (id)); INSERT INTO ${s}.items VALUES (1, 'a')`);
        await withOpen(db, itemModel(/** @type {string} */ (db.schema), 'items'), async (store) => {
          assert.deepEqual(await refusal(() => store.entity('Item').create({ id: 1, label: 'b' })),
            { code: 'JD2001', message: "JD2001: a 'Item' already exists under key 1 at /entities/Item" });
        }, { adopt: true });
      });
    });
  }

  it('a unique index older than the key reports first: a double collision keeps the server\'s answer, a collision on the key alone is a duplicate', async () => {
    await withDatabase('postgres', async (db) => {
      const s = `"${db.schema}"`;
      await db.raw(`CREATE TABLE ${s}.late (id integer, slug text, label text NOT NULL); CREATE UNIQUE INDEX late_slug ON ${s}.late (slug); `
        + `ALTER TABLE ${s}.late ADD PRIMARY KEY (id); INSERT INTO ${s}.late VALUES (1, 's1', 'a')`);
      const model = { $model: '0.1', entities: { Late: { schema: { type: 'object', properties: {
        id: { type: 'integer', 'x-entity': { key: true } }, slug: { type: 'string' }, label: { type: 'string' } } },
      physical: { schema: db.schema, table: 'late', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
        slug: { name: 'slug', codec: 'text', null: 'reject' }, label: { name: 'label', codec: 'text', null: 'reject' } } } } } };
      await withOpen(db, model, async (store) => {
        assert.deepEqual(await refusal(() => store.entity('Late').create({ id: 1, slug: 's1', label: 'b' })),
          { code: 'JD2005', message: `${PG_REJECTED} "late_slug" at /entities/Late` });
        assert.deepEqual(await refusal(() => store.entity('Late').create({ id: 1, slug: 's2', label: 'b' })),
          { code: 'JD2001', message: "JD2001: a 'Late' already exists under key 1 at /entities/Late" });
      }, { adopt: true });
    });
  });
});

describe('sqlite: an adopted table is read by its physical key column', () => {
  it('a write colliding on its key and on a unique column reads JD2001, the unique column alone JD2005', async () => {
    const { store, close } = await adopted(
      "CREATE TABLE item(item_id TEXT NOT NULL PRIMARY KEY, label TEXT NOT NULL UNIQUE); INSERT INTO item VALUES ('a', 'l1')",
      { Item: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, name: { type: 'string' } } },
        physical: { table: 'item', columns: { id: { name: 'item_id', codec: 'text', null: 'reject' },
          name: { name: 'label', codec: 'text', null: 'reject' } } } } });
    try {
      assert.deepEqual(await refusal(() => store.entity('Item').create({ id: 'a', name: 'l1' })),
        { code: 'JD2001', message: "JD2001: a 'Item' already exists under key \"a\" at /entities/Item" });
      assert.deepEqual(await refusal(() => store.entity('Item').create({ id: 'b', name: 'l1' })),
        { code: 'JD2005', message: 'JD2005: the database rejected the operation: UNIQUE constraint failed: item.label at /entities/Item' });
    }
    finally { await close(); }
  });
});

describe('sqlite: the key read after a UNIQUE failure runs only on the failure path', () => {
  it('a successful create(), saved add() and collection insert() run no key read; a key collision reads nothing; another unique collision reads the key once', async () => {
    await recordingStatements(async (ran) => {
      const store = await openStore({ ...postModel('string', false), collections: rowsModel.collections }, { driver: nodeDriver() });
      try {
        const posts = store.entity('Post');
        let at = ran.length;
        await posts.create({ pid: 'a', slug: 's1' });
        posts.add({ pid: 'b', slug: 's2' });
        await store.saveChanges();
        await store.collection('rows').insert({ id: 'a', n: 1 });
        assert.deepEqual(keyReads(ran.slice(at)), [], 'no key read on any success path');
        assert.equal(ran.slice(at).filter((sql) => /^INSERT INTO "Post"/.test(sql)).length, 2);

        at = ran.length;
        await refusal(() => posts.create({ pid: 'a', slug: 's9' }));
        await refusal(() => store.collection('rows').insert({ id: 'a', n: 9 }));
        assert.deepEqual(keyReads(ran.slice(at)), [], 'a collision the database attributes to the key reads nothing');

        at = ran.length;
        assert.equal((await refusal(() => posts.create({ pid: 'z', slug: 's1' })))?.code, 'JD2005');
        assert.deepEqual(keyReads(ran.slice(at)), ['SELECT 1 FROM "Post" WHERE "pid" = ? LIMIT 1'], 'a unique member alone: one read, no hit');

        at = ran.length;
        assert.equal((await refusal(() => posts.create({ pid: 'a', slug: 's1' })))?.code, 'JD2001');
        assert.deepEqual(keyReads(ran.slice(at)), ['SELECT 1 FROM "Post" WHERE "pid" = ? LIMIT 1'], 'the key and a unique member: one read, a hit');

        at = ran.length;
        assert.equal((await refusal(() => store.collection('rows').insert({ id: 'a', n: 1 })))?.code, 'JD2001');
        assert.deepEqual(keyReads(ran.slice(at)), ['SELECT 1 FROM "rows" WHERE "key" = ? LIMIT 1']);

        at = ran.length;
        posts.add({ pid: 'c', slug: 's3' });
        posts.add({ pid: 'a', slug: 's1' });
        assert.equal((await refusal(() => store.saveChanges()))?.code, 'JD2001');
        assert.deepEqual(keyReads(ran.slice(at)), ['SELECT 1 FROM "Post" WHERE ("pid" = ?) OR ("pid" = ?) LIMIT 1'], 'a batch: one bounded read over its carried keys');
      }
      finally { await store.close(); }
    });
  });

  it('a key the database allocated is never carried, so a unique collision beside it reads nothing', async () => {
    await recordingStatements(async (ran) => {
      const model = { $model: '0.1', entities: { Auto: { schema: { type: 'object', properties: {
        n: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, slug: uniqueText() } } } } };
      const store = await openStore(model, { driver: nodeDriver() });
      try {
        await store.entity('Auto').create({ slug: 's1' });
        const at = ran.length;
        assert.equal((await refusal(() => store.entity('Auto').create({ slug: 's1' })))?.code, 'JD2005');
        assert.deepEqual(keyReads(ran.slice(at)), []);
      }
      finally { await store.close(); }
    });
  });

  it('a read that fails leaves the constraint failure the database reported', async () => {
    const store = await openStore(postModel('string', false), { driver: nodeDriver() });
    try {
      await store.entity('Post').create({ pid: 'a', slug: 's1' });
      await recordingStatements(async (ran) => {
        const refused = await refusal(() => store.entity('Post').create({ pid: 'a', slug: 's1' }));
        assert.equal(refused?.code, 'JD2005');
        assert.match(String(refused?.message), /UNIQUE constraint failed: Post\.slug/);
        assert.deepEqual(keyReads(ran), ['SELECT 1 FROM "Post" WHERE "pid" = ? LIMIT 1'], 'the read was attempted, and refused');
      }, true);
    }
    finally { await store.close(); }
  });

  it('an asynchronous SQLite driver reads the key too, inside a transaction as outside one', async () => {
    const store = await openStore({ ...postModel('string', false), collections: rowsModel.collections }, { driver: wasmDriver(asyncWasmHandle()) });
    try {
      const posts = store.entity('Post');
      await posts.create({ pid: 'a', slug: 's1' });
      await store.collection('rows').insert({ id: 'a', n: 1 });
      assert.equal((await refusal(() => posts.create({ pid: 'a', slug: 's1' })))?.code, 'JD2001', 'create()');
      assert.equal((await refusal(() => store.collection('rows').insert({ id: 'a', n: 1 })))?.code, 'JD2001', 'insert()');
      assert.equal((await refusal(() => posts.create({ pid: 'b', slug: 's1' })))?.code, 'JD2005', 'a unique member alone');
      posts.add({ pid: 'a', slug: 's1' });
      assert.equal((await refusal(() => store.saveChanges()))?.code, 'JD2001', 'a saved add()');
      assert.equal((await refusal(() => store.transaction(async (tx) => { await tx.entity('Post').create({ pid: 'a', slug: 's1' }); })))?.code, 'JD2001', 'inside a transaction');
    }
    finally { await store.close(); }
  });
});
