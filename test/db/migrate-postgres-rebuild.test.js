//@ts-check
/**
 * @file A PostgreSQL rebuild keeps what the old table held. The allocated
 * key continues from the old table's sequence: never below the value it
 * would hand out next, past every copied key, and at least 1, so a key the
 * table already handed out is not handed out again, through any number of
 * rebuilds, and a table holding only keys at or below zero rebuilds too.
 * The rows keep their `rid`, so the default read order survives the copy.
 * The primary key takes `<table>_pkey`, the name a create gives it, when no
 * other relation holds that name (also for a table whose temporary name
 * PostgreSQL clips to its 63-byte identifier, and for a table an earlier
 * rebuild left under the temporary key name); where another relation holds
 * it, the key keeps the name PostgreSQL gave the temporary table's. The
 * duplicate-key classification recognises the key under each name
 * PostgreSQL gives it, the number it appends to a taken name included
 * (`Post_pkey1`), and no other table's. A rebuild of an entity that
 * another object depends on (a foreign key, a view) is refused, naming the
 * dependent as the server does, and changes nothing. Writers wait for a
 * rebuild: a write committed by another session while the rebuild waits for
 * the table, or while it runs, is kept, and a waiting writer continues
 * against the rebuilt table. The store reopens clean.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planModelMigration, migrate, migrationHistory, classifyDriverError } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

let schemaNumber = 0;

/** A model whose entity keys by an allocated integer, before and after an
 * enum CHECK that only a rebuild can add. @param {string} name */
function models(name) {
  const before = { $model: '0.1', entities: { [name]: { schema: { type: 'object', properties: {
    pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' } } } } } };
  const after = structuredClone(before);
  after.entities[name].schema.properties.title = /** @type {any} */ ({ type: 'string', enum: ['x', 'y', 'z'] });
  return { before, after };
}

/** An entity keyed by an allocated integer, whose title an enum may close (a
 * change only a rebuild makes). @param {string[]} [values] @param {Record<string, any>} [more] */
function postEntity(values = undefined, more = {}) {
  return { schema: { type: 'object', properties: {
    pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
    title: values === undefined ? { type: 'string' } : { type: 'string', enum: values }, ...more } } };
}

/** @param {string[]} [values] @param {Record<string, any>} [more] */
const postModel = (values = undefined, more = {}) => ({ $model: '0.1', entities: { Post: postEntity(values, more) } });

/** @param {(context: { pool: any, schema: string, driver: () => any }) => Promise<void>} run */
async function withSchema(run) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
  const schema = `jaren_rebuild_${process.pid}_${schemaNumber++}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  try { await run({ pool, schema, driver: () => postgresDriver(pool, { schema }) }); }
  finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** The primary-key constraint names of a table. @param {any} pool @param {string} schema @param {string} table */
async function keyNames(pool, schema, table) {
  const { rows } = await pool.query('SELECT c.conname AS name FROM pg_catalog.pg_constraint c '
    + 'JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace '
    + "WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p'", [schema, table]);
  return rows.map((/** @type {any} */ row) => row.name);
}

/** The migration a model change plans on PostgreSQL, without the draft
 * transform no test needs: every stored value is already one the target allows.
 * @param {any} from @param {any} to @param {string} schema @param {string} id */
function planned(from, to, schema, id) {
  const plan = planModelMigration(from, to, { dialect: postgresDialect({ schema }), id });
  plan.migration.steps = plan.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  return plan.migration;
}

/** The same, for a change that is exactly one rebuild.
 * @param {any} from @param {any} to @param {string} schema @param {string} id */
function rebuildOf(from, to, schema, id) {
  const migration = planned(from, to, schema, id);
  assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['rebuild']);
  return migration;
}

/** What creating a document answers: its key, or the code it is refused with.
 * @param {any} store @param {string} entity @param {any} doc */
async function created(store, entity, doc) {
  try { return (await store.entity(entity).create(doc)).pid; }
  catch (error) { return /** @type {any} */ (error).code; }
}

/**
 * Two rows, the rebuild, a third row and a duplicate key, on a fresh schema.
 * @param {{ pool: any, schema: string, driver: () => any }} context @param {string} name
 * @param {(pool: any) => Promise<void>} [before] - runs on the populated table, before the rebuild
 */
async function rebuildAndAllocate({ pool, schema, driver }, name, before = async () => {}) {
  const { before: from, after: to } = models(name);
  let store = await openStore(from, { driver: driver() });
  try {
    await store.entity(name).create({ title: 'x' });
    await store.entity(name).create({ title: 'y' });
  }
  finally { await store.close(); }
  await before(pool);
  assert.deepEqual((await migrate({ driver: driver() }, [rebuildOf(from, to, schema, 'rebuild')],
    { baseline: from, model: to, shadow: false })).applied, ['rebuild']);
  store = await openStore(to, { driver: driver() });
  try {
    const third = await store.entity(name).create({ title: 'z' });
    let duplicate;
    try { await store.entity(name).create({ pid: 1, title: 'x' }); }
    catch (error) { duplicate = /** @type {any} */ (error).code; }
    const rows = [];
    for (const pid of [1, 2, 3]) {
      const row = await store.entity(name).get(pid);
      rows.push([row?.pid, row?.title]);
    }
    return { third: third.pid, duplicate, keys: await keyNames(pool, schema, name), rows };
  }
  finally { await store.close(); }
}

describe('the duplicate-key classification of a PostgreSQL key name', () => {
  it('recognises the key under each name PostgreSQL gives it, and no other table\'s', () => {
    /** @param {string} constraint @param {string} [table] */
    const verdict = (constraint, table = 'Post') => classifyDriverError(Object.assign(
      new Error('duplicate key value violates unique constraint'), { code: '23505', constraint }),
    { table, column: 'pid' }).class;
    // a create's name, the number PostgreSQL appends to a taken one, a rebuild's temporary name
    const own = ['Post_pkey', 'Post_pkey1', 'Post_pkey12', 'Post__rebuild_pkey', 'Post__rebuild_pkey1', 'Post_pid_key'];
    assert.deepEqual(own.map((name) => [name, verdict(name)]), own.map((name) => [name, 'duplicate']));
    const other = ['Article_pkey', 'Posts_pkey', 'APost_pkey', 'Post_pkey0', 'Post_pkey01', 'Post_pkeyx', 'Post_pkey1x',
      'Post_pkey_1', 'Post__rebuild_pkeyx', 'Post__rebuild1_pkey', 'Post__rebuild', 'Post_slug_key', ''];
    assert.deepEqual(other.map((name) => [name, verdict(name)]), other.map((name) => [name, 'constraint']));
    // the table's name is matched as written, never as a pattern
    assert.deepEqual([verdict('Post_pkey', 'P.st'), verdict('P.st_pkey1', 'P.st'), verdict('Px_pkey', 'P*')],
      ['constraint', 'duplicate', 'constraint']);
  });
});

describe('postgres: a rebuild keeps what the old table held',
  { skip: !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
    it('the next allocated key follows the copied keys, and the key constraint keeps its natural name', async () => {
      await withSchema(async (context) => {
        assert.deepEqual(await rebuildAndAllocate(context, 'Post'), { third: 3, duplicate: 'JD2001',
          keys: ['Post_pkey'], rows: [[1, 'x'], [2, 'y'], [3, 'z']] });
      });
    });

    it('a name PostgreSQL clips, and a table an earlier rebuild left under the temporary key name', async () => {
      // 54 bytes: the longest name whose temporary table name still fits 63
      const long = `P${'x'.repeat(53)}`;
      await withSchema(async (context) => {
        assert.deepEqual(await rebuildAndAllocate(context, long), { third: 3, duplicate: 'JD2001',
          keys: [`${long}_pkey`], rows: [[1, 'x'], [2, 'y'], [3, 'z']] });
      });
      await withSchema(async (context) => {
        const leftover = (/** @type {any} */ pool) => pool.query(
          `ALTER INDEX "${context.schema}"."Post_pkey" RENAME TO "Post__rebuild_pkey"`);
        assert.deepEqual(await rebuildAndAllocate(context, 'Post', leftover), { third: 3, duplicate: 'JD2001',
          keys: ['Post_pkey'], rows: [[1, 'x'], [2, 'y'], [3, 'z']] });
      });
    });

    it('the allocated key continues from the old sequence, through every later rebuild', async () => {
      await withSchema(async ({ schema, driver }) => {
        const [v1, v2, v3, v4] = [undefined, ['x', 'y'], ['x', 'y', 'z'], ['x', 'y', 'z', 'w']].map((values) => postModel(values));
        const chain = [rebuildOf(v1, v2, schema, 'r1'), rebuildOf(v2, v3, schema, 'r2'), rebuildOf(v3, v4, schema, 'r3')];
        let store = await openStore(v1, { driver: driver() });
        try {
          for (let n = 1; n <= 5; n++) await store.entity('Post').create({ title: 'x' });
          // the sequence handed out 1..5; the highest key left is 3
          await store.entity('Post').delete(5);
          await store.entity('Post').delete(4);
        }
        finally { await store.close(); }
        const allocated = [];
        // two rebuilds with nothing allocated between them: the second continues from what the first carried
        await migrate({ driver: driver() }, chain.slice(0, 2), { baseline: v1, model: v3, shadow: false });
        store = await openStore(v3, { driver: driver() });
        try {
          allocated.push(await created(store, 'Post', { title: 'y' }));
          await store.entity('Post').delete(6);
        }
        finally { await store.close(); }
        await migrate({ driver: driver() }, chain, { baseline: v1, model: v4, shadow: false });
        store = await openStore(v4, { driver: driver() });
        try { allocated.push(await created(store, 'Post', { title: 'z' })); }
        finally { await store.close(); }
        assert.deepEqual(allocated, [6, 7]);
      });
    });

    it('a table holding only keys at or below zero rebuilds, and allocates 1 next', async () => {
      for (const keys of [[-5, -3], [0, -7]]) {
        await withSchema(async ({ schema, driver }) => {
          const [from, to] = [postModel(), postModel(['x', 'y'])];
          let store = await openStore(from, { driver: driver() });
          try { for (const pid of keys) await store.entity('Post').create({ pid, title: 'x' }); }
          finally { await store.close(); }
          let outcome;
          try {
            outcome = (await migrate({ driver: driver() }, [rebuildOf(from, to, schema, 'r')],
              { baseline: from, model: to, shadow: false })).applied;
          }
          catch (error) { outcome = /** @type {any} */ (error).message; }
          assert.deepEqual(outcome, ['r'], `keys ${keys.join(', ')}`);
          store = await openStore(to, { driver: driver() });
          try { assert.equal(await created(store, 'Post', { title: 'y' }), 1, `keys ${keys.join(', ')}`); }
          finally { await store.close(); }
        });
      }
    });

    it('the rows keep their rid, so the default read order survives the rebuild', async () => {
      await withSchema(async ({ schema, driver }) => {
        const indexed = { n: { type: 'integer', 'x-entity': { index: true } } };
        const [from, to] = [postModel(undefined, indexed), postModel(['x', 'y'], indexed)];
        const order = async (/** @type {any} */ store) =>
          (await store.entity('Post').load({})).map((/** @type {any} */ post) => post.pid);
        let store = await openStore(from, { driver: driver() });
        let before;
        try {
          for (let n = 1; n <= 6; n++) await store.entity('Post').create({ title: 'x', n });
          // an update of an indexed column writes a new row version after the others
          for (let round = 0; round < 3; round++) for (const pid of [1, 2]) await store.entity('Post').update(pid, { n: 100 + round });
          before = await order(store);
        }
        finally { await store.close(); }
        await migrate({ driver: driver() }, [rebuildOf(from, to, schema, 'r')], { baseline: from, model: to, shadow: false });
        store = await openStore(to, { driver: driver() });
        try {
          const after = await order(store);
          await store.entity('Post').create({ title: 'y', n: 7 });
          assert.deepEqual({ before, after, added: await order(store) },
            { before: [1, 2, 3, 4, 5, 6], after: [1, 2, 3, 4, 5, 6], added: [1, 2, 3, 4, 5, 6, 7] });
        }
        finally { await store.close(); }
      });
    });

    it('where another relation holds <table>_pkey, the key keeps the name PostgreSQL gave it, and a duplicate still reads JD2001', async () => {
      const v1 = { $model: '0.1', entities: { Post: postEntity() } };
      const renamed = { $model: '0.1', entities: { Article: { 'x-rename': 'Post', ...postEntity() } } };
      const v2 = { $model: '0.1', entities: { Article: postEntity() } };
      const v3 = { $model: '0.1', entities: { Article: postEntity(), Post: postEntity() } };
      const v4 = { $model: '0.1', entities: { Article: postEntity(), Post: postEntity(['x', 'y']) } };
      // an earlier release's rebuild left the new table's key under the temporary key name
      for (const leftover of [false, true]) {
        await withSchema(async ({ pool, schema, driver }) => {
          const chain = [planned(v1, renamed, schema, 'rename'), planned(v2, v3, schema, 'add'), rebuildOf(v3, v4, schema, 'rebuild')];
          let store = await openStore(v1, { driver: driver() });
          try { await store.entity('Post').create({ title: 'x' }); }
          finally { await store.close(); }
          await migrate({ driver: driver() }, chain.slice(0, 2), { baseline: v1, model: v3, shadow: false });
          store = await openStore(v3, { driver: driver() });
          try { await store.entity('Post').create({ pid: 1, title: 'x' }); }
          finally { await store.close(); }
          if (leftover) await pool.query(`ALTER INDEX "${schema}"."Post_pkey1" RENAME TO "Post__rebuild_pkey"`);
          /** @param {any} model */
          const observe = async (model) => {
            const opened = await openStore(model, { driver: driver() });
            try {
              return { keys: [await keyNames(pool, schema, 'Article'), await keyNames(pool, schema, 'Post')],
                // the renamed table keeps the key name its old name gave it, which the classification does not read
                duplicates: [await created(opened, 'Article', { pid: 1, title: 'x' }), await created(opened, 'Post', { pid: 1, title: 'x' })] };
            }
            finally { await opened.close(); }
          };
          const added = await observe(v3);
          let outcome;
          try { outcome = (await migrate({ driver: driver() }, chain, { baseline: v1, model: v4, shadow: false })).applied; }
          catch (error) { outcome = /** @type {any} */ (error).message; }
          const rebuilt = Array.isArray(outcome) ? await observe(v4) : null;
          assert.deepEqual({ added, outcome, rebuilt }, {
            added: { keys: [['Post_pkey'], [leftover ? 'Post__rebuild_pkey' : 'Post_pkey1']], duplicates: ['JD2005', 'JD2001'] },
            outcome: ['rebuild'],
            rebuilt: { keys: [['Post_pkey'], [leftover ? 'Post__rebuild_pkey1' : 'Post__rebuild_pkey']], duplicates: ['JD2005', 'JD2001'] },
          }, leftover ? 'the new table\'s key under the temporary key name' : 'the new table\'s key under the next free name');
        });
      }
    });

    it('a rebuild of an entity another object depends on is refused, naming the dependent as the server does', async () => {
      const comments = { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } };
      const comment = { schema: { type: 'object', properties: {
        cid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, postId: { type: 'integer' }, body: { type: 'string' } } } };
      const referenced = (/** @type {string[] | undefined} */ values) =>
        ({ $model: '0.1', entities: { Post: postEntity(values, { comments }), Comment: comment } });
      const children = { 'x-entity': { relation: { to: 'Category', many: true, via: 'parentId', onDelete: 'cascade' } } };
      const tree = (/** @type {string[] | undefined} */ values) => ({ $model: '0.1', entities: { Category: { schema: {
        type: 'object', properties: { cid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          name: values === undefined ? { type: 'string' } : { type: 'string', enum: values }, parentId: { type: 'integer' }, children } } } } });
      /** @type {[any, any, string, (store: any, pool: any, schema: string) => Promise<void>, string][]} */
      const cases = [
        [referenced(), referenced(['x', 'y']), 'Post', async (store) => {
          await store.entity('Post').create({ title: 'x' });
          await store.entity('Comment').create({ postId: 1, body: 'c' });
        }, 'constraint Comment_postId_fkey on table "Comment" depends on table "Post"'],
        [tree(), tree(['a', 'b']), 'Category', async (store) => {
          await store.entity('Category').create({ name: 'a' });
          await store.entity('Category').create({ name: 'b', parentId: 1 });
        }, 'constraint Category__rebuild_parentId_fkey on table "Category__rebuild" depends on table "Category"'],
        // no foreign key at all: an application's view over the entity's table
        [postModel(), postModel(['x', 'y']), 'Post', async (store, pool, schema) => {
          await store.entity('Post').create({ title: 'x' });
          await pool.query(`CREATE VIEW "${schema}"."post_titles" AS SELECT "title" FROM "${schema}"."Post"`);
        }, 'view post_titles depends on table "Post"'],
      ];
      for (const [from, to, table, seed, dependent] of cases) {
        await withSchema(async ({ pool, schema, driver }) => {
          const store = await openStore(from, { driver: driver() });
          try { await seed(store, pool, schema); }
          finally { await store.close(); }
          const rows = async () => (await pool.query(`SELECT * FROM "${schema}"."${table}" ORDER BY rid`)).rows;
          const held = await rows();
          await assert.rejects(migrate({ driver: driver() }, [rebuildOf(from, to, schema, 'r')], { baseline: from, model: to, shadow: false }), {
            code: 'JD0023',
            message: "JD0023: migration 'r' step 0 (rebuild) failed: a PostgreSQL rebuild of an entity that another object "
              + `depends on is not supported: the old '${table}' cannot be dropped while ${dependent}`,
          });
          // the link rolled back whole: nothing recorded, the rows and the key as they were
          assert.deepEqual((await migrationHistory({ driver: driver() })).history.rows, []);
          assert.deepEqual(await rows(), held);
          assert.deepEqual(await keyNames(pool, schema, table), [`${table}_pkey`]);
        });
      }
    });

    /**
     * The rebuild of `Post`, followed in its link by a host step that holds
     * the link's transaction open until `release()`, so a write meets the
     * rebuild's locks for as long as a test needs. `held` settles once the
     * rebuild ran. @param {string} schema
     */
    function heldRebuild(schema) {
      const [from, to] = [postModel(), postModel(['x', 'y'])];
      const migration = rebuildOf(from, to, schema, 'r');
      migration.steps.push({ kind: 'host', run: 'hold', version: '1' });
      let reached = () => {}, release = () => {};
      const held = new Promise((resolve) => { reached = () => resolve(undefined); });
      const released = new Promise((resolve) => { release = () => resolve(undefined); });
      const hosts = { hold: { version: '1', run: async () => { reached(); await released; } } };
      return { from, migration, hosts, held, release };
    }

    /** Wait until a session waits for a lock on a relation of the schema.
     * @param {any} pool @param {string} schema */
    async function lockWaited(pool, schema) {
      for (let poll = 0; poll < 400; poll++) {
        const { rows } = await pool.query('SELECT 1 FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation '
          + 'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT l.granted AND n.nspname = $1', [schema]);
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no session waited for a lock in ${schema}`);
    }

    it('writers wait for the rebuild: a write in flight when it starts and writes while it runs are all kept', async () => {
      await withSchema(async ({ pool, schema, driver }) => {
        const { from, migration, hosts, held, release } = heldRebuild(schema);
        const app = await openStore(from, { driver: driver() });
        try {
          for (let n = 1; n <= 3; n++) await app.entity('Post').create({ title: 'x' });
          /** @type {number[]} */ const created = [];
          /** @type {string[]} */ const errors = [];
          const create = async (/** @type {any} */ writer) => {
            try { created.push((await writer.entity('Post').create({ title: 'y' })).pid); }
            catch (error) { errors.push(/** @type {any} */ (error).code); }
          };
          // a write in flight when the rebuild starts: its transaction commits while the migration waits for the table
          let wrote = () => {}, commit = () => {};
          const written = new Promise((resolve) => { wrote = () => resolve(undefined); });
          const committing = new Promise((resolve) => { commit = () => resolve(undefined); });
          const inFlight = app.transaction(async (/** @type {any} */ tx) => { await create(tx); wrote(); await committing; });
          await written;
          const running = migrate({ driver: driver() }, [migration], { baseline: from, shadow: false, hosts });
          await lockWaited(pool, schema);
          commit();
          await inFlight;
          // writes while the rebuild's link is open: the first waits for it, then all land in the rebuilt table
          await held;
          const writes = (async () => { for (let n = 0; n < 5; n++) await create(app); })();
          await lockWaited(pool, schema);
          release();
          assert.deepEqual((await running).applied, ['r']);
          await writes;
          const rows = (await pool.query(`SELECT "pid" FROM "${schema}"."Post" ORDER BY "pid"`)).rows
            .map((/** @type {any} */ row) => Number(row.pid));
          assert.deepEqual({ created: created.length, errors, rows }, { created: 6, errors: [], rows: [1, 2, 3, ...created] });
        }
        finally { await app.close(); }
      });
    });

    it('the statement check admits the lock only as a rebuild\'s first statement, naming its own table', async () => {
      await withSchema(async ({ pool, schema, driver }) => {
        const [from, to] = [postModel(), postModel(['x', 'y'])];
        await (await openStore(from, { driver: driver() })).close();
        const planned = rebuildOf(from, to, schema, 'r');
        const lock = planned.steps[0].create[0];
        assert.equal(lock, 'LOCK TABLE "Post" IN SHARE ROW EXCLUSIVE MODE');
        /** @type {[string, (migration: any) => void][]} */
        const edits = [
          ['another table', (migration) => { migration.steps[0].create[0] = 'LOCK TABLE "Other" IN SHARE ROW EXCLUSIVE MODE'; }],
          ['another mode', (migration) => { migration.steps[0].create[0] = 'LOCK TABLE "Post" IN ACCESS EXCLUSIVE MODE'; }],
          ['not first', (migration) => { migration.steps[0].create.push(migration.steps[0].create.shift()); }],
          ['a ddl step', (migration) => { migration.steps.unshift({ kind: 'ddl', sql: lock }); }],
        ];
        const answers = [];
        for (const [label, edit] of edits) {
          const migration = structuredClone(planned);
          edit(migration);
          try { await migrate({ driver: driver() }, [migration], { baseline: from, shadow: false }); answers.push([label, 'applied']); }
          catch (error) { answers.push([label, /** @type {any} */ (error).code]); }
        }
        assert.deepEqual(answers, edits.map(([label]) => [label, 'JD0021']));
        assert.deepEqual((await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename = 'Post__rebuild'`,
          [schema])).rows, [{ n: 0 }]);
      });
    });

    it('a writer whose wait outlasts its lock_timeout is refused busy and retryable, and its retry lands', async () => {
      await withSchema(async ({ pool, schema, driver }) => {
        const { from, migration, hosts, held, release } = heldRebuild(schema);
        await (await openStore(from, { driver: driver() })).close();
        const app = await openStore(from, { driver: postgresDriver(pool, { schema, lockTimeoutMs: 200 }) });
        try {
          const running = migrate({ driver: driver() }, [migration], { baseline: from, shadow: false, hosts });
          await held;
          /** @type {any} */ let refused;
          try { await app.entity('Post').create({ title: 'y' }); }
          catch (error) { refused = error; }
          release();
          assert.deepEqual((await running).applied, ['r']);
          assert.deepEqual([refused?.code, refused?.class, refused?.retryable], ['JD2005', 'busy', true]);
          assert.equal((await app.entity('Post').create({ title: 'y' })).pid, 1);
        }
        finally { await app.close(); }
      });
    });
  });
