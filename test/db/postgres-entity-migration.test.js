//@ts-check
/**
 * @file An entity edit the migration planner admits runs on PostgreSQL with
 * the values it keeps on SQLite. A scalar moves between its column and the
 * document in either direction with its value and its JSON type intact, in
 * place and through a rebuild (a number, an integer, a string and a boolean;
 * an instant between a plain column, an epoch column and the document; an
 * inferred foreign key folded into the document); an absent member stays
 * absent, the document keeps no second copy of what moved into a column, and
 * a rebuild that retypes a member casts it to text. A member the document
 * holds as another JSON type than its declaration is left where it is, never
 * dropped. A key that gains or drops `default: "auto"` is converted by
 * planned steps, after which the database allocates (or a new entity can
 * reference the key), whatever state the key's column started in; a stored
 * key a conversion would round refuses it and changes nothing; and an
 * `auto` key over a column that allocates nothing opens, takes explicit keys
 * and refuses an allocating write by name before any statement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chain, migrate, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { ENGINES, skipFor } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

let schemaNumber = 0;

/**
 * A database of its own on `engine`: a store opener, the target a migration
 * runs against, the dialect it plans for, and raw SQL (a PostgreSQL schema
 * on the search path of its own transaction, over a pool of three sessions).
 * @typedef {{ engine: string, schema: string | null, dialect: any, doc: string, driver: () => any, pool?: any,
 *   open: (model: any, options?: any) => Promise<any>, target: (options?: any) => any,
 *   rows: (sql: string) => Promise<any[]>, exec: (sql: string) => Promise<void> }} Database
 * @param {string} engine @param {(db: Database) => Promise<void>} fn
 */
async function withDatabase(engine, fn) {
  if (engine === 'sqlite') {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await fn({ engine, schema: null, dialect: sqliteDialect, doc: 'json("doc")', driver: () => nodeDriver(),
        open: (model, options = {}) => openStore(model, { driver: nodeDriver(), path: dbPath, ...options }),
        target: () => ({ driver: nodeDriver(), path: dbPath }),
        rows: async (sql) => { const raw = new DatabaseSync(dbPath); try { return raw.prepare(sql).all(); } finally { raw.close(); } },
        exec: async (sql) => { const raw = new DatabaseSync(dbPath); try { raw.exec(sql); } finally { raw.close(); } } });
    }
    finally { cleanup(); }
    return;
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
  const schema = `jaren_entmig_${process.pid}_${schemaNumber++}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const driver = () => postgresDriver(pool, { schema });
  /** @param {string} sql */
  const inSchema = async (sql) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      const { rows } = await client.query(sql);
      await client.query('COMMIT');
      return rows;
    }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
  try {
    await fn({ engine, schema, pool, dialect: postgresDialect({ searchPath: schema }), doc: '"doc"::text', driver,
      open: (model, options = {}) => openStore(model, { driver: driver(), ...options }),
      target: () => ({ driver: driver() }), rows: inSchema, exec: async (sql) => { await inSchema(sql); } });
  }
  finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
}

/** @template T @param {Database} db @param {any} model @param {(store: any) => Promise<T>} fn @param {any} [options] @returns {Promise<T>} */
async function withOpen(db, model, fn, options = {}) {
  const store = await db.open(model, options);
  try { return await fn(store); }
  finally { await store.close(); }
}

/**
 * The migration a model change plans on `db`'s engine, without the draft
 * transform no test needs: every stored value is already one the target allows.
 * @param {Database} db @param {any} from @param {any} to @param {string} id
 */
function planned(db, from, to, id) {
  const plan = planModelMigration(from, to, { dialect: db.dialect, id });
  plan.migration.steps = plan.migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  return plan.migration;
}

/**
 * After a migration: the target planned against itself plans no step, and the
 * migration run again applies nothing.
 * @param {Database} db @param {any} before @param {any} after @param {any} migration
 */
async function settled(db, before, after, migration) {
  assert.deepEqual(planned(db, after, after, 'again').steps, []);
  assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, []);
}

/**
 * Plan and run a chain of models, the first one the baseline.
 * @param {Database} db @param {any[]} models @param {string[]} ids @param {any} [options]
 */
async function applyChain(db, models, ids, options = {}) {
  const migrations = ids.map((id, at) => planned(db, models[at], models[at + 1], id));
  const run = await migrate(db.target(), migrations, { baseline: models[0], model: models.at(-1), shadow: false, ...options });
  return { run, migrations };
}

/** What a call is refused with, or `null`. @param {() => any} run */
async function refusal(run) {
  try { await run(); }
  catch (error) { return { code: /** @type {any} */ (error).code, message: /** @type {any} */ (error).message }; }
  return null;
}

/** The statements of a plan, in order. @param {any} migration */
const statements = (migration) => migration.steps.flatMap((/** @type {any} */ step) => (step.kind === 'rebuild'
  ? [...step.create, step.copy, '<drop and rename>', ...step.indexes] : typeof step.sql === 'string' ? [step.sql] : []));

/** @param {string} word */
const article = (word) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;

/** The check a typed lift plans first, on an engine that types its extraction. */
const MEMBER_CHECK = /^WITH "_jaren_member"/;
/** The kinds of a plan's steps, the check of a lift left out. @param {any} migration */
const kindsOf = (migration) => migration.steps.filter((/** @type {any} */ step) => !MEMBER_CHECK.test(step.sql ?? '')).map((/** @type {any} */ step) => step.kind);

const INSTANT = '2026-10-08T01:02:03.004Z';
const EPOCH = 1791421323004;

/** The scalar types a column and the document both hold: the member's schema, a value, and the column value it reads as. */
const TYPES = /** @type {const} */ ([
  ['number', { type: 'number' }, 1.5, 1.5],
  ['integer', { type: 'integer' }, 7, 7],
  ['string', { type: 'string' }, 'x', 'x'],
  ['boolean', { type: 'boolean' }, true, 1],
]);

/** Where a member lives: a plain column, the document, or (an instant) an epoch column. */
const PLACE = /** @type {Record<string, any>} */ ({ column: {}, json: { 'x-entity': { column: 'json' } }, epoch: { 'x-entity': { column: 'integer' } } });

/**
 * `Post` keyed by a string, with a member `m` of schema `member` placed at
 * `where`; `closed` adds an enum to the title, which only a rebuild can do.
 * @param {any} member @param {string} where @param {boolean} [closed]
 */
const memberModel = (member, where, closed = false) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
  pid: { type: 'string', 'x-entity': { key: true } },
  title: closed ? { type: 'string', enum: ['a', 'b'] } : { type: 'string' },
  m: { ...member, ...PLACE[where] } } } } } });

/**
 * Seed `p1` (with `value`) and `p2` (without) under the model with `m` at
 * `from`, run the migration to the model with `m` at `to`, and read both rows
 * back through the store and from the tables: the document parsed, and the
 * column `m` as a plain value when the member lives in one.
 * @param {Database} db @param {any} member @param {any} value @param {string} from @param {string} to @param {boolean} closed
 * @param {'number' | 'text'} [kind] - how the column `m` is normalised (PostgreSQL answers a numeric as text)
 */
async function moved(db, member, value, from, to, closed, kind = 'text') {
  const before = memberModel(member, from);
  const after = memberModel(member, to, closed);
  await withOpen(db, before, async (store) => {
    await store.entity('Post').create({ pid: 'p1', title: 'a', m: value });
    await store.entity('Post').create({ pid: 'p2', title: 'b' });
  });
  const migration = planned(db, before, after, 'move');
  assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['move']);
  await settled(db, before, after, migration);
  const read = await withOpen(db, after, async (store) => [await store.entity('Post').get('p1'), await store.entity('Post').get('p2')]);
  const raw = (await db.rows(`SELECT "pid", ${db.doc} AS "doc"${to === 'json' ? '' : ', "m"'} FROM "Post" ORDER BY "pid"`)).map((row) => ({
    pid: row.pid, doc: JSON.parse(row.doc),
    ...(to === 'json' ? {} : { m: row.m === null ? null : kind === 'number' ? Number(row.m) : row.m }) }));
  return { kinds: kindsOf(migration), read, raw };
}

/**
 * What a move leaves, the same on both engines.
 * @param {string} to @param {any} value @param {any} column - the column's value
 */
function leaves(to, value, column) {
  const row = (/** @type {string} */ pid, /** @type {any} */ doc, /** @type {any} */ m) => ({ pid, doc, ...(to === 'json' ? {} : { m }) });
  return {
    read: [{ pid: 'p1', title: 'a', m: value }, { pid: 'p2', title: 'b' }],
    raw: to === 'json' ? [row('p1', { m: value }), row('p2', {})]
      : to === 'epoch' ? [row('p1', { m: value }, EPOCH), row('p2', {}, null)]
        : [row('p1', {}, column), row('p2', {}, null)],
  };
}

for (const engine of ENGINES) {
  describe(`${engine}: a scalar moves between its column and the document with its value and JSON type`, { skip: skipFor(engine) }, () => {
    for (const [name, member, value, column] of TYPES) {
      for (const closed of [false, true]) {
        const how = closed ? 'through a rebuild' : 'in place';
        it(`${article(name)} folds into the document ${how}, an absent one stays absent`, async () => {
          await withDatabase(engine, async (db) => {
            const out = await moved(db, member, value, 'column', 'json', closed);
            assert.deepEqual(out.kinds, closed ? ['rebuild'] : ['sql', 'ddl']);
            assert.deepEqual({ read: out.read, raw: out.raw }, leaves('json', value, column));
          });
        });

        it(`${article(name)} lifts out of the document into its column ${how}, leaving no second copy`, async () => {
          await withDatabase(engine, async (db) => {
            const out = await moved(db, member, value, 'json', 'column', closed, name === 'string' ? 'text' : 'number');
            assert.deepEqual(out.kinds, closed ? ['rebuild'] : ['ddl', 'sql']);
            assert.deepEqual({ read: out.read, raw: out.raw }, leaves('column', value, column));
          });
        });
      }
    }

    // an instant lives in the document as a string, in a plain text column, or as an epoch
    // column beside the string; every move reads back the string it began with
    for (const [from, to, kinds] of /** @type {const} */ ([
      ['json', 'epoch', ['ddl', 'sql']], ['json', 'column', ['ddl', 'sql']], ['column', 'json', ['sql', 'ddl']],
      ['column', 'epoch', ['rebuild']], ['epoch', 'column', ['rebuild']], ['epoch', 'json', ['ddl']],
    ])) {
      it(`an instant moves from ${from} to ${to}, as the string it began as`, async () => {
        await withDatabase(engine, async (db) => {
          const out = await moved(db, { type: 'string', format: 'date-time' }, INSTANT, from, to, false, to === 'epoch' ? 'number' : 'text');
          assert.deepEqual(out.kinds, kinds);
          assert.deepEqual({ read: out.read, raw: out.raw }, leaves(to, INSTANT, INSTANT));
        });
      });
    }
  });
}

/**
 * `User` and `Post`: a relation `User.posts` through `Post.authorId` (an
 * inferred foreign-key column), and the same model with the relation gone and
 * `authorId` a member the document holds.
 * @param {string} keyType - the type of `User`'s key, and so of the foreign key
 */
function foreignKeyModels(keyType) {
  const user = (/** @type {any} */ extra = {}) => ({ schema: { type: 'object', properties: { id: { type: keyType, 'x-entity': { key: true } }, ...extra } } });
  const post = (/** @type {any} */ extra = {}) => ({ schema: { type: 'object', properties: { pid: { type: 'integer', 'x-entity': { key: true } }, title: { type: 'string' }, ...extra } } });
  return {
    related: { $model: '0.1', entities: { User: user({ posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } }), Post: post() } },
    folded: { $model: '0.1', entities: { User: user(), Post: post({ authorId: { type: keyType, 'x-entity': { column: 'json' } } }) } },
  };
}

for (const engine of ENGINES) {
  describe(`${engine}: an inferred foreign key folds into the document, and a retyped member is cast through a rebuild`, { skip: skipFor(engine) }, () => {
    for (const [keyType, owner] of /** @type {const} */ ([['string', 'u1'], ['integer', 5]])) {
      it(`an inferred foreign key to ${article(keyType)} key folds into the document the target declares`, async () => {
        await withDatabase(engine, async (db) => {
          const { related, folded } = foreignKeyModels(keyType);
          await withOpen(db, related, async (store) => {
            await store.entity('User').create({ id: owner });
            await store.entity('Post').create({ pid: 1, title: 't', authorId: owner });
          });
          const migration = planned(db, related, folded, 'fold');
          assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['rebuild']);
          assert.deepEqual((await migrate(db.target(), [migration], { baseline: related, model: folded, shadow: false })).applied, ['fold']);
          await settled(db, related, folded, migration);
          assert.deepEqual(await withOpen(db, folded, (store) => store.entity('Post').get(1)), { pid: 1, title: 't', authorId: owner });
          assert.deepEqual((await db.rows(`SELECT ${db.doc} AS "doc" FROM "Post"`)).map((row) => JSON.parse(row.doc)), [{ authorId: owner }]);
        });
      });
    }

    for (const [from, to, value, cast] of /** @type {const} */ ([
      ['integer', 'string', 7, '7'], ['number', 'string', 1.5, '1.5'], ['boolean', 'string', true, '1'],
      ['string', 'integer', '7', 7], ['integer', 'number', 7, 7],
    ])) {
      it(`${article(from)} member retyped to ${to} is cast by the rebuild and reads back as ${JSON.stringify(cast)}`, async () => {
        await withDatabase(engine, async (db) => {
          const before = memberModel({ type: from }, 'column');
          const after = memberModel({ type: to }, 'column');
          await withOpen(db, before, async (store) => {
            await store.entity('Post').create({ pid: 'p1', title: 'a', m: value });
            await store.entity('Post').create({ pid: 'p2', title: 'b' });
          });
          const migration = planned(db, before, after, 'retype');
          assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['rebuild']);
          // the target column declares its collation itself: the cast names a type, never a collation
          assert.match(migration.steps[0].copy, /CAST\("m" AS [A-Za-z]+\)/);
          assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['retype']);
          await settled(db, before, after, migration);
          assert.deepEqual(await withOpen(db, after, async (store) => [await store.entity('Post').get('p1'), await store.entity('Post').get('p2')]),
            [{ pid: 'p1', title: 'a', m: cast }, { pid: 'p2', title: 'b' }]);
        });
      });
    }
  });
}

/** A statement that gives the document of `pid` the JSON `json`. @param {Database} db @param {string} pid @param {string} json */
const setDocument = (db, pid, json) => db.exec(db.engine === 'sqlite'
  ? `UPDATE "Post" SET "doc" = jsonb('${json}') WHERE "pid" = '${pid}'` : `UPDATE "Post" SET "doc" = '${json}'::jsonb WHERE "pid" = '${pid}'`);

for (const engine of ENGINES) {
  describe(`${engine}: a lift over a member the document holds as another JSON type than its column's is refused before any row changes`, { skip: skipFor(engine) }, () => {
    for (const closed of [false, true]) {
      it(`${closed ? 'through a rebuild' : 'in place'}: JD0023 and nothing changed; the document corrected, the lift applies`, async () => {
        await withDatabase(engine, async (db) => {
          const before = memberModel({ type: 'integer' }, 'json');
          const after = memberModel({ type: 'integer' }, 'column', closed);
          await withOpen(db, before, async (store) => {
            await store.entity('Post').create({ pid: 'p1', title: 'a', m: 7 });
            await store.entity('Post').create({ pid: 'p2', title: 'b', m: 8 });
          });
          // a document a store with no validator may hold: a string in an integer member
          await setDocument(db, 'p2', '{"m": "seven"}');
          const documents = async () => (await db.rows(`SELECT "pid", ${db.doc} AS "doc" FROM "Post" ORDER BY "pid"`)).map((row) => [row.pid, JSON.parse(row.doc)]);
          const migration = planned(db, before, after, 'lift');
          const failure = await refusal(() => migrate(db.target(), [migration], { baseline: before, model: after, shadow: false }));
          assert.equal(failure?.code, 'JD0023');
          assert.deepEqual(await documents(), [['p1', { m: 7 }], ['p2', { m: 'seven' }]]);
          await assert.rejects(() => db.rows('SELECT "m" FROM "Post"'), 'no column was added');
          await setDocument(db, 'p2', '{"m": 8}');
          assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['lift']);
          assert.deepEqual(await documents(), [['p1', {}], ['p2', {}]]);
          assert.deepEqual((await db.rows('SELECT "pid", "m" FROM "Post" ORDER BY 1')).map((row) => [row.pid, Number(row.m)]), [['p1', 7], ['p2', 8]]);
        });
      });
    }
  });
}

describe('postgres: a boolean, a string or a number in a member of another type is refused whichever type it is', { skip: skipFor('postgres') }, () => {
  for (const [column, held, wrong] of /** @type {const} */ ([['integer', 'number', '{"m": true}'], ['string', 'string', '{"m": 5}'], ['boolean', 'boolean', '{"m": "yes"}']])) {
    it(`a ${column} column over a document holding ${wrong}`, async () => {
      await withDatabase('postgres', async (db) => {
        const before = memberModel({ type: column }, 'json');
        const after = memberModel({ type: column }, 'column');
        await withOpen(db, before, async (store) => { await store.entity('Post').create({ pid: 'p1', title: 'a' }); });
        await setDocument(db, 'p1', wrong);
        const failure = await refusal(() => migrate(db.target(), [planned(db, before, after, 'lift')], { baseline: before, model: after, shadow: false }));
        assert.equal(failure?.code, 'JD0023');
        assert.match(failure?.message ?? '', new RegExp(`the member 'm' of 'Post' holds a JSON \\w+, where its column holds a JSON ${held}`));
        assert.deepEqual((await db.rows(`SELECT ${db.doc} AS "doc" FROM "Post"`)).map((row) => JSON.parse(row.doc)), [JSON.parse(wrong)]);
      });
    });
  }
});

/**
 * `Post`, keyed by `pid` (allocated by the database when `auto`), with a
 * unique member, an index and a database rule; `Comment` references it
 * through `postId` and `Tag` joins it through `Post_Tag`; `notes` adds a
 * `Note` that references it too, `closed` an enum on the title (a change only
 * a rebuild makes), `rules: false` leaves out the two database rules,
 * `plainComments` gives `Comment` a key the caller supplies.
 * @param {boolean} auto @param {{ notes?: boolean, closed?: boolean, rules?: boolean, plainComments?: boolean }} [options]
 */
const allocationModel = (auto, { notes = false, closed = false, rules = true, plainComments = false } = {}) => ({ $model: '0.1', entities: {
  Post: { schema: { type: 'object', properties: {
    pid: { type: 'integer', 'x-entity': auto ? { key: true, default: 'auto' } : { key: true } },
    title: closed ? { type: 'string', enum: ['x', 'y', 'z'] } : { type: 'string' },
    slug: { type: 'string', 'x-entity': { unique: true } }, rank: { type: 'integer', 'x-entity': { index: true } },
    comments: { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } },
    tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
    ...(notes ? { notes: { 'x-entity': { relation: { to: 'Note', many: true, via: 'postId', onDelete: 'cascade' } } } } : {}) } },
  ...(rules ? { invariants: [{ name: 'positive', on: ['insert', 'update'], enforcement: 'database', assert: { $gt: ['$.new.pid', 0] } }] } : {}) },
  Comment: { schema: { type: 'object', properties: { cid: { type: 'integer', 'x-entity': plainComments ? { key: true } : { key: true, default: 'auto' } }, postId: { type: 'integer' }, body: { type: 'string' } } },
    ...(rules ? { invariants: [{ name: 'owned', on: ['insert', 'update'], enforcement: 'database', assert: { $gt: ['$.new.postId', 0] } }] } : {}) },
  Tag: { schema: { type: 'object', properties: { tid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, label: { type: 'string' } } } },
  ...(notes ? { Note: { schema: { type: 'object', properties: { nid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, postId: { type: 'integer' } } } } } : {}),
} });

/** `Post` alone, keyed by `pid`. @param {boolean} auto @param {any} [more] - further `Post` members */
const lonePost = (auto, more = {}) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
  pid: { type: 'integer', 'x-entity': auto ? { key: true, default: 'auto' } : { key: true } }, title: { type: 'string' }, ...more } } } } });

/** What a dry run prints for a plan: a data step with its note, every other statement as it stands. @param {any} migration */
const listing = (migration) => migration.steps.flatMap((/** @type {any} */ step) => (step.kind === 'sql'
  ? [`-- data step (sql): ${step.note ?? ''}`, step.sql] : [step.sql]));

describe('the steps a key that gains or drops allocation plans', () => {
  const tenant = postgresDialect({ searchPath: 'tenant' });

  it('PostgreSQL converts the referencing columns, then the key, before it gives the key a sequence it owns', () => {
    const migration = planModelMigration(allocationModel(false, { rules: false }), allocationModel(true, { rules: false }), { dialect: tenant, id: 'gain' }).migration;
    const texts = statements(migration);
    assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['ddl', 'sql', 'ddl', 'ddl', 'ddl', 'ddl', 'sql']);
    // the key's table is locked against every other session first: the check and the conversions then see the
    // same keys, and a writer that holds the key's table finishes before a column that references it is touched
    assert.match(texts[0], /^DO \$jaren_allocation\$\n-- \["lock","Post","pid"\]\n/);
    assert.match(texts[0], /LOCK TABLE "Post" IN ACCESS EXCLUSIVE MODE;/);
    // a key a conversion would round is refused next, naming the key and the value
    assert.match(texts[1], /^WITH .*"pid"::numeric <> pg_catalog\.trunc\("pid"::numeric\).*::bigint FROM /);
    assert.match(texts[1], /the key ''pid'' of ''Post'' holds /);
    assert.deepEqual(texts.slice(2, 5), [
      'ALTER TABLE "Comment" ALTER COLUMN "postId" TYPE bigint',
      'ALTER TABLE "Post_Tag" ALTER COLUMN "Post_key" TYPE bigint',
      'ALTER TABLE "Post" ALTER COLUMN "pid" TYPE bigint']);
    assert.match(texts[5], /^DO \$jaren/);
    assert.match(texts[5], /pg_catalog\.pg_get_serial_sequence\('"Post"', 'pid'\)/);
    assert.match(texts[6], /^WITH "_jaren_sequence" AS \(SELECT GREATEST\(pg_catalog\.nextval\(pg_catalog\.pg_get_serial_sequence\('"Post"', 'pid'\)\)/);
    assert.equal(migration.steps.some((/** @type {any} */ step) => /CASCADE|DROP SEQUENCE/.test(step.sql ?? '')), false);
  });

  it('PostgreSQL drops the default, converts the key, then the referencing columns, then the sequence the key owned', () => {
    const migration = planModelMigration(allocationModel(true, { rules: false }), allocationModel(false, { rules: false }), { dialect: tenant, id: 'drop' }).migration;
    const texts = statements(migration);
    assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['ddl', 'ddl', 'ddl', 'ddl', 'ddl', 'ddl']);
    assert.deepEqual(texts.slice(0, 5), [
      'ALTER TABLE "Post" ALTER COLUMN "pid" DROP IDENTITY IF EXISTS',
      'ALTER TABLE "Post" ALTER COLUMN "pid" DROP DEFAULT',
      'ALTER TABLE "Post" ALTER COLUMN "pid" TYPE numeric',
      'ALTER TABLE "Comment" ALTER COLUMN "postId" TYPE numeric',
      'ALTER TABLE "Post_Tag" ALTER COLUMN "Post_key" TYPE numeric']);
    assert.match(texts[5], /^DO \$jaren/);
    assert.match(texts[5], /pg_catalog\.pg_get_serial_sequence\('"Post"', 'pid'\)/);
    assert.match(texts[5], /DROP SEQUENCE/);
  });

  it('SQLite plans nothing for either edit: its rowid allocates a key either way', () => {
    assert.deepEqual(planModelMigration(allocationModel(false), allocationModel(true), { dialect: sqliteDialect, id: 'gain' }).migration.steps, []);
    assert.deepEqual(planModelMigration(allocationModel(true), allocationModel(false), { dialect: sqliteDialect, id: 'drop' }).migration.steps, []);
  });

  it('a model planned against itself plans no step, and a table the edit rebuilds is only guarded against rounding', () => {
    for (const auto of [false, true]) {
      assert.deepEqual(planModelMigration(allocationModel(auto), allocationModel(auto), { dialect: tenant, id: 'same' }).migration.steps, []);
    }
    /** @param {any} migration */
    const kinds = (migration) => migration.steps.filter((/** @type {any} */ step) => step.draft !== true).map((/** @type {any} */ step) => step.kind);
    // the rebuild's own sequence continues the allocation; the copy would round a fractional key
    const gain = planModelMigration(lonePost(false), lonePost(true, { title: { type: 'string', enum: ['x'] } }), { dialect: tenant, id: 'gain' }).migration;
    assert.deepEqual(kinds(gain), ['ddl', 'sql', 'rebuild']);
    const drop = planModelMigration(lonePost(true), lonePost(false, { title: { type: 'string', enum: ['x'] } }), { dialect: tenant, id: 'drop' }).migration;
    assert.deepEqual(kinds(drop), ['rebuild']);
  });

  it('the rule functions of the converted tables are replaced after the conversion, so no session keeps one compiled against the old type', () => {
    for (const [from, to] of [[false, true], [true, false]]) {
      const migration = planModelMigration(allocationModel(from), allocationModel(to), { dialect: tenant, id: 'rules' }).migration;
      const replaced = statements(migration).filter((text) => /^CREATE OR REPLACE FUNCTION /.test(text));
      assert.deepEqual(replaced.map((text) => /FUNCTION "tenant"\."([^"]+)"/.exec(text)?.[1]), [
        '_jaren_rule_4_Post_insert', '_jaren_rule_4_Post_update', '_jaren_rule_7_Comment_insert', '_jaren_rule_7_Comment_update']);
      assert.deepEqual(migration.steps.slice(-4).map((/** @type {any} */ step) => step.sql), replaced, 'they come last of the conversion');
    }
  });

  it('a table renamed by the same edit is converted under its new name', () => {
    const renamed = { $model: '0.1', entities: { Article: { 'x-rename': 'Post', ...lonePost(true).entities.Post } } };
    const texts = statements(planModelMigration(lonePost(false), renamed, { dialect: tenant, id: 'rename' }).migration);
    assert.equal(texts[0], 'ALTER TABLE "Post" RENAME TO "Article"');
    assert.ok(texts.includes('ALTER TABLE "Article" ALTER COLUMN "pid" TYPE bigint'));
    assert.match(texts.at(-1) ?? '', /"Article"/);
  });

  it('a referencing entity the same edit creates meets the converted key, whichever order the model declares them in', () => {
    const first = allocationModel(false, { notes: true });
    // `Note` before `Post` in the model's order
    const entities = { Note: first.entities.Note, ...first.entities };
    const model = (/** @type {boolean} */ auto) => ({ $model: '0.1', entities: { ...entities, Post: allocationModel(auto, { notes: true }).entities.Post } });
    const migration = planModelMigration(allocationModel(true), model(false), { dialect: tenant, id: 'both' }).migration;
    const texts = statements(migration);
    const created = texts.findIndex((text) => /^CREATE TABLE "Note"/.test(text));
    const converted = texts.findIndex((text) => text === 'ALTER TABLE "Post" ALTER COLUMN "pid" TYPE numeric');
    assert.ok(created > converted && converted >= 0, 'the key is converted before a table that references it is created');
  });
});

/** The sequences a column owns, as the catalog records the ownership. @param {Database} db @param {string} table @param {string} column */
const ownedSequences = async (db, table, column) => (await db.rows(
  'SELECT s.relname AS name FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = \'S\' '
  + `JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.refobjid = '"${table}"'::regclass `
  + `AND a.attname = '${column}' AND d.deptype = 'a' ORDER BY 1`)).map((row) => row.name);

/** The catalog's account of the key and of every column that references it. @param {Database} db */
async function allocationShape(db) {
  /** @param {string} table @param {string} name */
  const column = async (table, name) => (await db.rows(
    'SELECT format_type(a.atttypid, a.atttypmod) AS type, coalesce(pg_get_expr(d.adbin, d.adrelid) ~ \'^nextval[(]\', false) AS allocates '
    + 'FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum '
    + `WHERE a.attrelid = '"${table}"'::regclass AND a.attname = '${name}' AND NOT a.attisdropped`))[0];
  return { key: await column('Post', 'pid'), comment: (await column('Comment', 'postId')).type,
    join: (await column('Post_Tag', 'Post_key')).type, sequences: await ownedSequences(db, 'Post', 'pid') };
}

const NOT_ALLOCATED = { key: { type: 'numeric', allocates: false }, comment: 'numeric', join: 'numeric', sequences: [] };
const ALLOCATED = { key: { type: 'bigint', allocates: true }, comment: 'bigint', join: 'bigint', sequences: ['Post_pid_seq'] };

/** The rows a conversion must not touch, and the index names it must keep. @param {Database} db */
async function survivors(db) {
  return {
    posts: (await db.rows('SELECT "pid", "slug", "rank" FROM "Post" ORDER BY "slug"')).map((row) => [Number(row.pid), row.slug, Number(row.rank)]),
    comments: (await db.rows('SELECT "postId", "body" FROM "Comment" ORDER BY "cid"')).map((row) => [Number(row.postId), row.body]),
    joins: (await db.rows('SELECT "Post_key", "Tag_key" FROM "Post_Tag" ORDER BY 1, 2')).map((row) => [Number(row.Post_key), Number(row.Tag_key)]),
    indexes: (await db.rows('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname NOT LIKE \'\\_jaren%\' ORDER BY 1')).map((row) => row.indexname),
  };
}

/**
 * Posts under `pids` (a key the database allocates where absent), the first
 * with a comment and a tag.
 * @param {Database} db @param {any} model @param {(number | undefined)[]} pids
 */
async function seedPopulated(db, model, pids) {
  await withOpen(db, model, async (store) => {
    await store.entity('Tag').create({ tid: 1, label: 'l1' });
    /** @type {number[]} */
    const made = [];
    for (const [at, pid] of pids.entries()) {
      made.push((await store.entity('Post').create({ ...(pid === undefined ? {} : { pid }), title: 't', slug: `s${at}`, rank: at, ...(at === 0 ? { tags: [1] } : {}) })).pid);
    }
    await store.entity('Comment').create({ postId: made[0], body: 'c' });
  });
}

/** Create a `Post` through the store and answer its key. @param {Database} db @param {any} model @param {string} slug @param {number} [pid] */
const makePost = (db, model, slug, pid = undefined) => withOpen(db, model, async (store) =>
  (await store.entity('Post').create({ ...(pid === undefined ? {} : { pid }), title: 't', slug, rank: 9 })).pid);

describe('postgres: a key that gains or drops allocation is converted by planned steps', { skip: skipFor('postgres') }, () => {
  it('gaining converts every referencing column and the key, keeps every row, index and rule, and the store allocates past the stored keys', async () => {
    await withDatabase('postgres', async (db) => {
      const from = allocationModel(false);
      const to = allocationModel(true);
      await seedPopulated(db, from, [7, 12]);
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
      const before = await survivors(db);
      const migration = planned(db, from, to, 'gain');
      // a dry run lists the statements the plan holds and changes nothing
      const dry = await migrate(db.target(), [migration], { baseline: from, model: to, shadow: false, dryRun: true });
      assert.deepEqual(dry.statements, listing(migration));
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
      assert.deepEqual((await migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })).applied, ['gain']);
      assert.deepEqual(await allocationShape(db), ALLOCATED);
      assert.deepEqual(await survivors(db), before);
      assert.equal(await makePost(db, to, 's13'), 13, 'the next key is past the highest stored one');
      assert.equal(await makePost(db, to, 's40', 40), 40, 'an explicit key is still taken');
      assert.equal(await makePost(db, to, 's14'), 14, 'the sequence goes on from where it was');
      // what the table enforced before, it enforces after
      await withOpen(db, to, async (store) => {
        assert.equal((await refusal(() => store.entity('Post').create({ title: 't', slug: 's0', rank: 1 })))?.code, 'JD2005', 'the unique member');
        assert.equal((await refusal(() => store.entity('Post').create({ pid: -5, title: 't', slug: 'neg', rank: 1 })))?.code, 'JD2096', 'the rule');
        assert.equal((await refusal(() => store.entity('Post').create({ pid: 7, title: 't', slug: 'dup', rank: 1 })))?.code, 'JD2001', 'the key');
        assert.match((await refusal(() => store.entity('Comment').create({ postId: 999, body: 'orphan' })))?.message ?? '', /foreign key/);
        assert.deepEqual(await store.entity('Post').get(7), { pid: 7, title: 't', slug: 's0', rank: 0 });
      });
      // planning the target against itself plans nothing, and the chain run again applies nothing
      assert.deepEqual(planned(db, to, to, 'again').steps, []);
      assert.deepEqual((await migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })).applied, []);
    });
  });

  it('a lone entity gains allocation: an explicit 7 is followed by 8', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(false), (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      await applyChain(db, [lonePost(false), lonePost(true)], ['gain']);
      assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'y' })).pid), 8);
    });
  });

  for (const [label, stored] of /** @type {const} */ ([['a fraction', '1.5'], ['a number beyond a bigint', '9223372036854775808']])) {
    it(`${label} among the stored keys refuses the gain, names the key and the value, and changes nothing; fixed, the gain applies`, async () => {
      await withDatabase('postgres', async (db) => {
        const from = allocationModel(false);
        const to = allocationModel(true);
        await seedPopulated(db, from, [7, 12]);
        // written around the rule, which would refuse it: a store with no rule, or an outside writer
        await db.exec(`ALTER TABLE "Post" DISABLE TRIGGER USER; INSERT INTO "Post" ("pid", "title", "slug", "rank", "doc") VALUES (${stored}, 'f', 'bad', 1, '{}'::jsonb); ALTER TABLE "Post" ENABLE TRIGGER USER`);
        const shape = await allocationShape(db);
        const rows = await survivors(db);
        const failure = await refusal(() => applyChain(db, [from, to], ['gain']));
        assert.equal(failure?.code, 'JD0023');
        assert.match(failure?.message ?? '', new RegExp(`the key 'pid' of 'Post' holds ${stored.replace('.', '\\.')}, which is not a whole number a bigint holds`));
        assert.deepEqual(await allocationShape(db), shape);
        assert.deepEqual(await survivors(db), rows);
        await db.exec(`DELETE FROM "Post" WHERE "slug" = 'bad'`);
        assert.deepEqual((await applyChain(db, [from, to], ['gain'])).run.applied, ['gain']);
        assert.deepEqual(await allocationShape(db), ALLOCATED);
        assert.equal(await makePost(db, to, 's13'), 13);
      });
    });
  }

  it('an interrupted chain resumes: the link that failed rolled back whole, the one before it stays', async () => {
    await withDatabase('postgres', async (db) => {
      const models = [allocationModel(false), allocationModel(true), allocationModel(true, { notes: true })];
      await seedPopulated(db, models[0], [7]);
      const migrations = [planned(db, models[0], models[1], 'gain'), planned(db, models[1], models[2], 'notes')];
      const sabotaged = { ...migrations[1], steps: [...migrations[1].steps, { kind: 'ddl', sql: 'ALTER TABLE "Missing" ADD COLUMN "x" integer', note: 'fails' }] };
      const failure = await refusal(() => migrate(db.target(), [migrations[0], sabotaged], { baseline: models[0], model: models[2], shadow: false }));
      assert.equal(failure?.code, 'JD0023');
      assert.deepEqual(await allocationShape(db), ALLOCATED, 'the first link stayed');
      assert.deepEqual((await db.rows(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'Note'`))[0].n, 0, 'the second rolled back');
      assert.deepEqual((await migrate(db.target(), migrations, { baseline: models[0], model: models[2], shadow: false })).applied, ['notes']);
      assert.equal(await makePost(db, models[2], 's8'), 8);
    });
  });

  it('dropping converts the key and then every referencing column back, drops the sequence the key owned, and a new entity can reference the key', async () => {
    await withDatabase('postgres', async (db) => {
      const models = [allocationModel(true), allocationModel(false), allocationModel(false, { notes: true })];
      await seedPopulated(db, models[0], [undefined, undefined]);
      assert.deepEqual(await allocationShape(db), ALLOCATED);
      const before = await survivors(db);
      assert.deepEqual((await applyChain(db, models, ['drop', 'notes'])).run.applied, ['drop', 'notes']);
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
      assert.deepEqual(await survivors(db), { ...before, indexes: [...before.indexes, 'Note_pkey', 'Note_postId'].sort() });
      await withOpen(db, models[2], async (store) => {
        await store.entity('Note').create({ postId: 1 });
        assert.match((await refusal(() => store.entity('Note').create({ postId: 99 })))?.message ?? '', /foreign key/);
        assert.equal((await refusal(() => store.entity('Post').create({ title: 't', slug: 'n', rank: 1 })))?.code, 'JD2002', 'the key is the caller\'s now');
      });
      // keys written meanwhile are not allocated again when the key gains allocation later
      assert.equal(await makePost(db, models[2], 'big', 100), 100);
      const regained = allocationModel(true, { notes: true });
      assert.deepEqual((await applyChain(db, [...models, regained], ['drop', 'notes', 'regain'])).run.applied, ['regain']);
      assert.deepEqual((await allocationShape(db)).sequences, ['Post_pid_seq']);
      assert.equal(await makePost(db, regained, 'next'), 101);
    });
  });

  it('dropping keeps every row, index, unique member and rule, lists in a dry run what it runs, and resumes after an interrupted link', async () => {
    await withDatabase('postgres', async (db) => {
      const models = [allocationModel(true), allocationModel(false), allocationModel(false, { notes: true })];
      await seedPopulated(db, models[0], [undefined, undefined]);
      const before = await survivors(db);
      const migrations = [planned(db, models[0], models[1], 'drop'), planned(db, models[1], models[2], 'notes')];
      const options = { baseline: models[0], model: models[2], shadow: false };
      // a dry run lists the statements the plan holds and changes nothing
      assert.deepEqual((await migrate(db.target(), migrations, { ...options, dryRun: true })).statements, migrations.flatMap(listing));
      assert.deepEqual(await allocationShape(db), ALLOCATED);
      // the second link fails and rolls back whole; the first stays
      const sabotaged = { ...migrations[1], steps: [...migrations[1].steps, { kind: 'ddl', sql: 'ALTER TABLE "Missing" ADD COLUMN "x" integer', note: 'fails' }] };
      assert.equal((await refusal(() => migrate(db.target(), [migrations[0], sabotaged], options)))?.code, 'JD0023');
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED, 'the first link stayed');
      assert.equal((await db.rows(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'Note'`))[0].n, 0, 'the second rolled back');
      assert.deepEqual((await migrate(db.target(), migrations, options)).applied, ['notes']);
      assert.deepEqual((await migrate(db.target(), migrations, options)).applied, []);
      assert.deepEqual(planned(db, models[2], models[2], 'again').steps, []);
      assert.deepEqual(await survivors(db), { ...before, indexes: [...before.indexes, 'Note_pkey', 'Note_postId'].sort() });
      // what the tables enforced before, they enforce after: the rule functions were replaced, not lost
      await withOpen(db, models[2], async (store) => {
        assert.equal((await refusal(() => store.entity('Post').create({ pid: -5, title: 't', slug: 'neg', rank: 1 })))?.code, 'JD2096', 'the rule');
        assert.equal(typeof (await store.entity('Comment').create({ postId: 1, body: 'after' })).cid, 'number', 'the rule of the referencing entity runs against the converted column');
        assert.equal((await refusal(() => store.entity('Post').create({ pid: 40, title: 't', slug: 's0', rank: 1 })))?.code, 'JD2005', 'the unique member');
        assert.equal((await refusal(() => store.entity('Post').create({ pid: 1, title: 't', slug: 'dup', rank: 1 })))?.code, 'JD2001', 'the key');
      });
    });
  });
});

/**
 * A PostgreSQL driver that records every statement the store prepares and
 * runs, in `ran`.
 * @param {any} driver @param {string[]} ran
 */
function recordingPostgres(driver, ran) {
  /** @param {any} statement @param {string} sql */
  const watch = (statement, sql) => new Proxy(statement, { get(target, member) {
    const value = Reflect.get(target, member);
    if (typeof value !== 'function') return value;
    return ['run', 'get', 'all', 'iterate'].includes(String(member)) ? (/** @type {any[]} */ ...args) => { ran.push(sql); return value.apply(target, args); } : value.bind(target);
  } });
  /** @param {any} target @returns {any} */
  const wrapped = (target) => Object.freeze({ ...target,
    prepare: (/** @type {string} */ sql, /** @type {any[]} */ ...rest) => chain(target.prepare(sql, ...rest), (/** @type {any} */ statement) => watch(statement, sql)),
    exec: (/** @type {string} */ sql) => { ran.push(sql); return target.exec(sql); },
    transaction: (/** @type {Function} */ fn, /** @type {any[]} */ ...rest) => target.transaction((/** @type {any} */ scope) => fn(wrapped(scope)), ...rest) });
  return { name: driver.name, dialect: driver.dialect, open: (/** @type {any} */ path, /** @type {any} */ options) => chain(driver.open(path, options), wrapped) };
}

/** The same models with `Note` declared before `Post`. @param {any} model */
const noteFirst = (model) => ({ ...model, entities: { Note: model.entities.Note, ...model.entities } });

const NOT_ALLOCATING = 'the key member \'pid\' is declared "default": "auto" but its column allocates nothing on this database '
  + '(it has no default and is not an identity, as read when the store opened)';

describe('postgres: the allocation steps meet every starting state of the key\'s column', { skip: skipFor('postgres') }, () => {
  it('dropping allocation and adding the entity that references the key in one migration works in either declaration order', async () => {
    for (const order of [(/** @type {any} */ model) => model, noteFirst]) {
      await withDatabase('postgres', async (db) => {
        const from = allocationModel(true);
        const to = order(allocationModel(false, { notes: true }));
        await seedPopulated(db, from, [undefined, undefined]);
        assert.deepEqual((await applyChain(db, [from, to], ['both'])).run.applied, ['both']);
        assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
        await withOpen(db, to, (store) => store.entity('Note').create({ postId: 2 }));
      });
    }
  });

  it('gaining allocation in a migration that also creates the entity that references the key works in either declaration order', async () => {
    for (const order of [(/** @type {any} */ model) => model, noteFirst]) {
      await withDatabase('postgres', async (db) => {
        const from = allocationModel(false);
        const to = order(allocationModel(true, { notes: true }));
        await seedPopulated(db, from, [7]);
        assert.deepEqual((await applyChain(db, [from, to], ['both'])).run.applied, ['both']);
        assert.deepEqual(await allocationShape(db), ALLOCATED);
        await withOpen(db, to, (store) => store.entity('Note').create({ postId: 7 }));
        assert.equal(await makePost(db, to, 'next'), 8);
      });
    }
  });

  it('a table the same edit renames is converted under its new name, with a sequence named after it', async () => {
    await withDatabase('postgres', async (db) => {
      const renamed = { $model: '0.1', entities: { Article: { 'x-rename': 'Post', ...lonePost(true).entities.Post } } };
      await withOpen(db, lonePost(false), (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      assert.deepEqual((await applyChain(db, [lonePost(false), renamed], ['rename'])).run.applied, ['rename']);
      assert.deepEqual(await ownedSequences(db, 'Article', 'pid'), ['Article_pid_seq']);
      assert.equal(await withOpen(db, renamed, async (store) => (await store.entity('Article').create({ title: 'y' })).pid), 8);
    });
  });

  it('dropping allocation from a rebuilt table drops the sequence the rebuild named, and gaining it in a rebuild refuses a fractional key', async () => {
    await withDatabase('postgres', async (db) => {
      const models = [lonePost(true), lonePost(true, { title: { type: 'string', enum: ['x', 'y'] } }), lonePost(false, { title: { type: 'string', enum: ['x', 'y'] } })];
      await withOpen(db, models[0], async (store) => { await store.entity('Post').create({ title: 'x' }); await store.entity('Post').create({ title: 'y' }); });
      await applyChain(db, models.slice(0, 2), ['rebuild']);
      assert.deepEqual(await ownedSequences(db, 'Post', 'pid'), ['Post__rebuild_pid_seq']);
      await applyChain(db, models, ['rebuild', 'drop']);
      assert.deepEqual(await ownedSequences(db, 'Post', 'pid'), []);
      assert.deepEqual((await db.rows(`SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname LIKE 'Post%pid_seq' AND relnamespace = current_schema()::regnamespace`))[0].n, 0);
      assert.equal(await withOpen(db, models[2], async (store) => (await store.entity('Post').create({ pid: 40, title: 'x' })).pid), 40);
    });
    await withDatabase('postgres', async (db) => {
      const from = lonePost(false);
      const to = lonePost(true, { title: { type: 'string', enum: ['x'] } });
      await withOpen(db, from, (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      await db.exec(`INSERT INTO "Post" ("pid", "title", "doc") VALUES (1.5, 'x', '{}'::jsonb)`);
      const failure = await refusal(() => applyChain(db, [from, to], ['gain']));
      assert.equal(failure?.code, 'JD0023');
      assert.match(failure?.message ?? '', /the key 'pid' of 'Post' holds 1\.5/);
      assert.deepEqual((await db.rows('SELECT "pid" FROM "Post" ORDER BY 1')).map((row) => Number(row.pid)), [1.5, 7]);
      await db.exec(`DELETE FROM "Post" WHERE "pid" = 1.5`);
      assert.deepEqual((await applyChain(db, [from, to], ['gain'])).run.applied, ['gain']);
      assert.equal(await withOpen(db, to, async (store) => (await store.entity('Post').create({ title: 'x' })).pid), 8);
    });
  });

  it('regaining allocation over a column that still owns its sequence reuses it, advances it past the keys written meanwhile, and makes no second', async () => {
    await withDatabase('postgres', async (db) => {
      const auto = allocationModel(true);
      const plain = allocationModel(false);
      await seedPopulated(db, auto, [undefined, undefined]);
      // an earlier release planned nothing for the edit that dropped `auto`
      const dropped = { ...planned(db, auto, plain, 'drop'), steps: [] };
      const regain = planned(db, plain, auto, 'regain');
      await migrate(db.target(), [dropped], { baseline: auto, model: plain, shadow: false });
      assert.equal(await makePost(db, plain, 'explicit', 50), 50, 'the sequence never saw this key');
      assert.deepEqual((await migrate(db.target(), [dropped, regain], { baseline: auto, model: auto, shadow: false })).applied, ['regain']);
      assert.deepEqual((await allocationShape(db)).sequences, ['Post_pid_seq']);
      assert.equal(await makePost(db, auto, 'next'), 51);
    });
  });

  it('regaining allocation over a rebuilt table\'s sequence reuses that one, whatever its name', async () => {
    await withDatabase('postgres', async (db) => {
      const closed = { title: { type: 'string', enum: ['x', 'y'] } };
      const models = [lonePost(true), lonePost(true, closed), lonePost(false, closed), lonePost(true, closed)];
      await withOpen(db, models[0], async (store) => { await store.entity('Post').create({ title: 'x' }); });
      const rebuild = planned(db, models[0], models[1], 'rebuild');
      const dropped = { ...planned(db, models[1], models[2], 'drop'), steps: [] };
      const regain = planned(db, models[2], models[3], 'regain');
      await migrate(db.target(), [rebuild, dropped], { baseline: models[0], model: models[2], shadow: false });
      assert.equal(await withOpen(db, models[2], async (store) => (await store.entity('Post').create({ pid: 50, title: 'x' })).pid), 50);
      assert.deepEqual((await migrate(db.target(), [rebuild, dropped, regain], { baseline: models[0], model: models[3], shadow: false })).applied, ['regain']);
      assert.deepEqual(await ownedSequences(db, 'Post', 'pid'), ['Post__rebuild_pid_seq']);
      assert.equal(await withOpen(db, models[3], async (store) => (await store.entity('Post').create({ title: 'y' })).pid), 51);
    });
  });

  it('a name the sequence would take being held by another relation, the sequence takes the next free name', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(false), (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      await db.exec('CREATE SEQUENCE "Post_pid_seq"');
      assert.deepEqual((await applyChain(db, [lonePost(false), lonePost(true)], ['gain'])).run.applied, ['gain']);
      assert.deepEqual(await ownedSequences(db, 'Post', 'pid'), ['Post_pid_seq1']);
      assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'y' })).pid), 8);
    });
  });

  it('dropping allocation from a column that owns nothing changes nothing and applies', async () => {
    await withDatabase('postgres', async (db) => {
      const auto = allocationModel(true);
      const plain = allocationModel(false);
      await seedPopulated(db, plain, [7, 12]);
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
      assert.deepEqual((await applyChain(db, [auto, plain], ['drop'])).run.applied, ['drop']);
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
      assert.deepEqual((await survivors(db)).posts.map((row) => row[0]), [7, 12]);
    });
  });

  it('an auto key over a column that allocates nothing opens and takes explicit keys, and an allocating write refuses by name before any statement', async () => {
    await withDatabase('postgres', async (db) => {
      const plain = allocationModel(false);
      const auto = allocationModel(true);
      await seedPopulated(db, plain, [7]);
      /** @type {string[]} */
      const ran = [];
      const store = await db.open(auto, { driver: recordingPostgres(db.driver(), ran) });
      try {
        ran.length = 0;
        const created = await refusal(() => store.entity('Post').create({ title: 't', slug: 'n', rank: 1 }));
        assert.equal(created?.code, 'JD2002');
        assert.ok(created?.message.includes(NOT_ALLOCATING), created?.message);
        const staged = await refusal(() => store.entity('Post').add({ title: 't', slug: 'm', rank: 1 }));
        assert.equal(staged?.code, 'JD2002');
        assert.ok(staged?.message.includes(NOT_ALLOCATING), staged?.message);
        assert.deepEqual(ran, [], 'no statement ran for either refusal');
        assert.equal((await store.entity('Post').create({ pid: 8, title: 't', slug: 'x8', rank: 1 })).pid, 8, 'an explicit key is taken');
        store.entity('Post').add({ pid: 9, title: 't', slug: 'x9', rank: 1 });
        await store.saveChanges();
        assert.deepEqual((await store.entity('Post').asNoTracking().get(9))?.pid, 9);
      }
      finally { await store.close(); }
      assert.deepEqual(await allocationShape(db), NOT_ALLOCATED);
    });
  });
});

/** `Node`, whose `parentId` references its own key. @param {boolean} auto */
const nodeModel = (auto) => ({ $model: '0.1', entities: { Node: { schema: { type: 'object', properties: {
  nid: { type: 'integer', 'x-entity': auto ? { key: true, default: 'auto' } : { key: true } }, label: { type: 'string' },
  children: { 'x-entity': { relation: { to: 'Node', many: true, via: 'parentId', onDelete: 'cascade' } } } } } } } });

/** The type of a column. @param {Database} db @param {string} table @param {string} column */
const typeOf = async (db, table, column) => (await db.rows(
  `SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attname = '${column}' AND NOT a.attisdropped`))[0]?.type;

describe('postgres: the allocation steps meet the tables around the key', { skip: skipFor('postgres') }, () => {
  it('a DO block is admitted only as the exact text the planner renders for the key it names', async () => {
    await withDatabase('postgres', async (db) => {
      const from = lonePost(false);
      const to = lonePost(true);
      await withOpen(db, from, (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      const migration = planned(db, from, to, 'gain');
      const at = migration.steps.findIndex((/** @type {any} */ step) => /^DO /.test(step.sql ?? '') && step.sql.includes('["ensure",'));
      assert.ok(at > 0);
      for (const edit of [
        (/** @type {string} */ sql) => `${sql}; DROP TABLE "Post"`,
        (/** @type {string} */ sql) => sql.replace('["ensure","Post","pid"]', '["ensure","Post","title"]'),
        (/** @type {string} */ sql) => sql.replace('AS bigint', 'AS integer'),
        () => 'DO $$ BEGIN PERFORM 1; END $$',
      ]) {
        const edited = structuredClone(migration);
        edited.steps[at].sql = edit(edited.steps[at].sql);
        assert.equal((await refusal(() => migrate(db.target(), [edited], { baseline: from, model: to, shadow: false })))?.code, 'JD0021');
      }
      assert.equal(await typeOf(db, 'Post', 'pid'), 'numeric', 'nothing ran');
      assert.deepEqual((await migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })).applied, ['gain']);
    });
  });

  it('a column that references the key is converted though the same edit drops its entity, or the relation and keeps the table', async () => {
    const without = (/** @type {boolean} */ auto) => {
      const model = structuredClone(allocationModel(auto));
      delete model.entities.Comment;
      delete model.entities.Post.schema.properties.comments;
      return model;
    };
    const unrelated = (/** @type {boolean} */ auto) => {
      const model = structuredClone(allocationModel(auto));
      delete model.entities.Post.schema.properties.comments;
      return model;
    };
    for (const [label, target] of /** @type {const} */ ([['drops its entity', without], ['drops the relation', unrelated]])) {
      await withDatabase('postgres', async (db) => {
        const from = allocationModel(false);
        await seedPopulated(db, from, [7, 12]);
        const to = target(true);
        assert.deepEqual((await applyChain(db, [from, to], ['gain'])).run.applied, ['gain'], label);
        assert.equal(await typeOf(db, 'Post', 'pid'), 'bigint');
        assert.equal(await typeOf(db, 'Post_Tag', 'Post_key'), 'bigint');
        assert.equal(await makePost(db, to, 'next'), 13);
        assert.deepEqual((await db.rows('SELECT "postId" FROM "Comment"').catch(() => [])).map((row) => Number(row.postId)), target === without ? [] : [7]);
      });
    }
  });

  it('a referenced entity the same edit renames is converted under its new name, with the columns that reference it', async () => {
    /** `Post` renamed `Article`, its join table following. @param {boolean} auto */
    const renamed = (auto) => {
      const model = structuredClone(allocationModel(auto));
      const { Post, ...rest } = model.entities;
      return { ...model, entities: { Article: { 'x-rename': 'Post', ...Post }, ...rest } };
    };
    await withDatabase('postgres', async (db) => {
      const from = allocationModel(false);
      await seedPopulated(db, from, [7, 12]);
      assert.deepEqual((await applyChain(db, [from, renamed(true)], ['rename'])).run.applied, ['rename']);
      assert.deepEqual([await typeOf(db, 'Article', 'pid'), await typeOf(db, 'Comment', 'postId'), await typeOf(db, 'Article_Tag', 'Article_key')],
        ['bigint', 'bigint', 'bigint']);
      assert.deepEqual(await ownedSequences(db, 'Article', 'pid'), ['Article_pid_seq']);
      assert.equal(await withOpen(db, renamed(true), async (store) => (await store.entity('Article').create({ title: 't', slug: 'n', rank: 1 })).pid), 13);
      assert.equal((await withOpen(db, renamed(true), (store) => refusal(() => store.entity('Article').create({ pid: -1, title: 't', slug: 'neg', rank: 1 }))))?.code, 'JD2096', 'the rule came with the table');
    });
  });

  it('two keys that gain allocation in one edit, one referencing the other, are each converted and each allocate', async () => {
    await withDatabase('postgres', async (db) => {
      const from = allocationModel(false, { plainComments: true });
      const to = allocationModel(true);
      await withOpen(db, from, async (store) => {
        await store.entity('Post').create({ pid: 7, title: 't', slug: 's7', rank: 1 });
        await store.entity('Comment').create({ cid: 3, postId: 7, body: 'c' });
      });
      assert.deepEqual((await applyChain(db, [from, to], ['both'])).run.applied, ['both']);
      assert.deepEqual([await typeOf(db, 'Post', 'pid'), await typeOf(db, 'Comment', 'cid'), await typeOf(db, 'Comment', 'postId')], ['bigint', 'bigint', 'bigint']);
      await withOpen(db, to, async (store) => {
        assert.equal((await store.entity('Post').create({ title: 't', slug: 'n', rank: 1 })).pid, 8);
        assert.equal((await store.entity('Comment').create({ postId: 8, body: 'n' })).cid, 4);
      });
      await settled(db, from, to, planned(db, from, to, 'both'));
    });
  });

  it('an entity that references its own key is converted, both ways', async () => {
    await withDatabase('postgres', async (db) => {
      const models = [nodeModel(false), nodeModel(true), nodeModel(false)];
      await withOpen(db, models[0], async (store) => {
        await store.entity('Node').create({ nid: 1, label: 'root' });
        await store.entity('Node').create({ nid: 2, label: 'child', parentId: 1 });
      });
      await applyChain(db, models.slice(0, 2), ['gain']);
      assert.deepEqual([await typeOf(db, 'Node', 'nid'), await typeOf(db, 'Node', 'parentId')], ['bigint', 'bigint']);
      assert.equal(await withOpen(db, models[1], async (store) => (await store.entity('Node').create({ label: 'leaf', parentId: 2 })).nid), 3);
      await applyChain(db, models, ['gain', 'drop']);
      assert.deepEqual([await typeOf(db, 'Node', 'nid'), await typeOf(db, 'Node', 'parentId')], ['numeric', 'numeric']);
      assert.deepEqual(await ownedSequences(db, 'Node', 'nid'), []);
      assert.deepEqual((await db.rows('SELECT "nid", "parentId" FROM "Node" ORDER BY 1')).map((row) => [Number(row.nid), row.parentId === null ? null : Number(row.parentId)]),
        [[1, null], [2, 1], [3, 2]]);
    });
  });
});

/**
 * A driver over `driver` that runs `hook(sql)` once each statement a migration
 * executes has returned, inside its transaction too.
 * @param {any} driver @param {(sql: string) => any} hook
 */
function afterExec(driver, hook) {
  /** @param {any} target @returns {any} */
  const wrapped = (target) => Object.freeze({ ...target,
    exec: (/** @type {string} */ sql) => chain(target.exec(sql), (/** @type {any} */ result) => chain(hook(sql), () => result)),
    transaction: (/** @type {Function} */ fn, /** @type {any[]} */ ...rest) => target.transaction((/** @type {any} */ scope) => fn(wrapped(scope)), ...rest),
    ...(typeof target.exclusively === 'function'
      ? { exclusively: (/** @type {Function} */ fn, /** @type {any[]} */ ...rest) => target.exclusively((/** @type {any} */ scope) => fn(wrapped(scope)), ...rest) } : {}) });
  return { name: driver.name, dialect: driver.dialect, open: (/** @type {any} */ path, /** @type {any} */ options) => chain(driver.open(path, options), wrapped) };
}

/** Whether a session waits on a lock. @param {Database} db */
const lockWaiting = async (db) => (await db.rows(
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = \'Lock\''))[0].n > 0;

describe('postgres: the conversion holds the key\'s table against every other session from its first step', { skip: skipFor('postgres') }, () => {
  /** @type {[string, () => [any, any]][]} */
  const VARIANTS = [
    ['a lone entity, in place', () => [lonePost(false), lonePost(true)]],
    ['an entity others reference, in place', () => [allocationModel(false, { rules: false }), allocationModel(true, { rules: false })]],
    ['a lone entity, through a rebuild', () => [lonePost(false), lonePost(true, { title: { type: 'string', enum: ['x'] } })]],
  ];
  for (const [label, models] of VARIANTS) {
    it(`a writer cannot commit a fractional key between the check and the conversion: ${label}`, async () => {
      await withDatabase('postgres', async (db) => {
        const [from, to] = models();
        if (from.entities.Comment === undefined) await withOpen(db, from, (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
        else await seedPopulated(db, from, [7]);
        const migration = planned(db, from, to, 'gain');
        /** @type {{ code: string } | undefined} */
        let racer;
        const driver = afterExec(db.driver(), async (sql) => {
          if (racer !== undefined || !/^WITH "_jaren_key"/.test(sql)) return;
          // another session writes the key's table as soon as the check has returned: it waits for the lock,
          // or it commits a row the check never saw and the conversion then rounds
          racer = (await refusal(() => db.exec('SET LOCAL lock_timeout = \'300ms\'; INSERT INTO "Post" ("pid", "title", "doc") VALUES (2.5, \'f\', \'{}\'::jsonb)')))
            ?? { code: 'committed' };
        });
        assert.deepEqual((await migrate({ driver }, [migration], { baseline: from, model: to, shadow: false })).applied, ['gain']);
        assert.equal(racer?.code, '55P03', 'the writer was held off until the migration ended');
        assert.deepEqual((await db.rows('SELECT "pid" FROM "Post" ORDER BY 1')).map((row) => Number(row.pid)), [7], 'no row was rounded');
      });
    });
  }

  it('a session that wrote the key\'s table and then a table that references it finishes while the migration waits, and the migration applies', async () => {
    await withDatabase('postgres', async (db) => {
      const from = allocationModel(false, { rules: false });
      const to = allocationModel(true, { rules: false });
      await seedPopulated(db, from, [7]);
      const migration = planned(db, from, to, 'gain');
      const writer = await db.pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(`SET LOCAL search_path TO "${db.schema}"`);
        await writer.query('INSERT INTO "Post" ("pid", "title", "doc") VALUES (100, \'w\', \'{}\'::jsonb)');
        const migrating = migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })
          .then((run) => run.applied, (error) => `${error.code}: ${error.message}`);
        // the migration queues for the key's table behind the writer, holding nothing the writer needs
        for (let at = 0; at < 100 && !(await lockWaiting(db)); at++) await new Promise((resolve) => setTimeout(resolve, 50));
        await writer.query('INSERT INTO "Comment" ("postId", "body", "doc") VALUES (100, \'c\', \'{}\'::jsonb)');
        await writer.query('COMMIT');
        assert.deepEqual(await migrating, ['gain']);
      }
      finally { writer.release(); }
      assert.deepEqual((await db.rows('SELECT "pid" FROM "Post" ORDER BY 1')).map((row) => Number(row.pid)), [7, 100]);
      assert.deepEqual((await db.rows('SELECT "postId" FROM "Comment" ORDER BY 1')).map((row) => Number(row.postId)), [7, 100]);
      assert.deepEqual((await allocationShape(db)), ALLOCATED);
    });
  });
});

describe('postgres: the conversion queues behind a session that read the key\'s table first', { skip: skipFor('postgres') }, () => {
  it('a session that read the key\'s table and then a table that references it finishes while the migration waits, and the migration applies', async () => {
    await withDatabase('postgres', async (db) => {
      const from = allocationModel(false, { rules: false });
      const to = allocationModel(true, { rules: false });
      await seedPopulated(db, from, [7]);
      const migration = planned(db, from, to, 'gain');
      const reader = await db.pool.connect();
      try {
        await reader.query('BEGIN');
        await reader.query(`SET LOCAL search_path TO "${db.schema}"`);
        await reader.query('SELECT count(*) FROM "Post"');
        const migrating = migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })
          .then((run) => run.applied, (error) => `${error.code}: ${error.message}`);
        for (let at = 0; at < 100 && !(await lockWaiting(db)); at++) await new Promise((resolve) => setTimeout(resolve, 50));
        // the migration holds nothing the reader needs: its second read is not made to wait
        assert.equal((await reader.query('SELECT count(*)::int AS n FROM "Comment"')).rows[0].n, 1);
        await reader.query('COMMIT');
        assert.deepEqual(await migrating, ['gain']);
      }
      finally { reader.release(); }
      assert.deepEqual(await allocationShape(db), ALLOCATED);
    });
  });
});

describe('postgres: an allocating write is refused only for what the open proved, and says so', { skip: skipFor('postgres') }, () => {
  for (const [label, statements] of /** @type {const} */ ([
    ['a nextval inside an expression', 'ALTER TABLE "Post" ALTER COLUMN "pid" SET DEFAULT (nextval(\'"Post_pid_seq"\'::regclass) + 0)'],
    ['a function of the application\'s', 'CREATE FUNCTION next_pid() RETURNS bigint LANGUAGE sql AS $$ SELECT nextval(\'"Post_pid_seq"\') $$; ALTER TABLE "Post" ALTER COLUMN "pid" SET DEFAULT next_pid()'],
  ])) {
    it(`a key column whose default is ${label} allocates: nothing is refused`, async () => {
      await withDatabase('postgres', async (db) => {
        await withOpen(db, lonePost(true), (store) => store.entity('Post').create({ title: 'seed' }));
        await db.exec(statements);
        assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'x' })).pid), 2);
      });
    });
  }

  it('a store opened before the column was converted says what it read and to reopen, and a reopened store allocates', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(false), (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      const live = await db.open(lonePost(true));
      try {
        await applyChain(db, [lonePost(false), lonePost(true)], ['gain']);
        const refused = await refusal(() => live.entity('Post').create({ title: 'y' }));
        assert.equal(refused?.code, 'JD2002');
        assert.match(refused?.message ?? '', /it has no default and is not an identity, as read when the store opened/);
        assert.match(refused?.message ?? '', /reopen the store/);
      }
      finally { await live.close(); }
      assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'y' })).pid), 8);
    });
  });
});

describe('postgres: the allocation steps meet an identity key column', { skip: skipFor('postgres') }, () => {
  /** An identity where a serial default was, or on a table an earlier release created. @param {Database} db */
  const makeIdentity = (db) => db.exec('ALTER TABLE "Post" ALTER COLUMN "pid" DROP DEFAULT; DROP SEQUENCE IF EXISTS "Post_pid_seq"; '
    + 'ALTER TABLE "Post" ALTER COLUMN "pid" TYPE bigint; ALTER TABLE "Post" ALTER COLUMN "pid" ADD GENERATED BY DEFAULT AS IDENTITY');
  const identityOf = async (/** @type {Database} */ db) => (await db.rows(
    'SELECT a.attidentity AS identity, pg_get_expr(d.adbin, d.adrelid) AS "default" FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum '
    + 'WHERE a.attrelid = \'"Post"\'::regclass AND a.attname = \'pid\''))[0];

  it('an identity opens under the auto model, which allocates through it', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(true), (store) => store.entity('Post').create({ pid: 100, title: 'seed' }));
      await makeIdentity(db);
      assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'x' })).pid), 1, 'the identity\'s own sequence');
    });
  });

  it('gaining over an identity leaves it as the allocation and advances its sequence past the stored keys', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(true), (store) => store.entity('Post').create({ pid: 7, title: 'seed' }));
      await makeIdentity(db);
      assert.deepEqual((await applyChain(db, [lonePost(false), lonePost(true)], ['gain'])).run.applied, ['gain']);
      assert.deepEqual(await identityOf(db), { identity: 'd', default: null });
      assert.equal(await withOpen(db, lonePost(true), async (store) => (await store.entity('Post').create({ title: 'x' })).pid), 8);
    });
  });

  it('dropping over an identity removes it, and the sequence it owned', async () => {
    await withDatabase('postgres', async (db) => {
      await withOpen(db, lonePost(true), (store) => store.entity('Post').create({ title: 'seed' }));
      await makeIdentity(db);
      assert.deepEqual((await applyChain(db, [lonePost(true), lonePost(false)], ['drop'])).run.applied, ['drop']);
      assert.deepEqual(await identityOf(db), { identity: '', default: null });
      assert.deepEqual((await db.rows('SELECT c.relname FROM pg_class c WHERE c.relkind = \'S\' AND c.relnamespace = current_schema()::regnamespace AND c.relname LIKE \'Post%pid%\'')), []);
      assert.equal(await withOpen(db, lonePost(false), async (store) => (await store.entity('Post').create({ pid: 40, title: 'x' })).pid), 40);
    });
  });
});

describe('postgres: the conversions meet renames, retypes and the checks around them', { skip: skipFor('postgres') }, () => {
  it('a rename that rebuilds the join table in the other endpoint order, in one edit with the key gaining or dropping allocation', async () => {
    for (const [fromAuto, toAuto] of [[true, false], [false, true]]) {
      await withDatabase('postgres', async (db) => {
        /** @param {boolean} auto @param {string} tagName */
        const model = (auto, tagName) => ({ $model: '0.1', entities: {
          Post: { schema: { type: 'object', properties: {
            pid: { type: 'integer', 'x-entity': auto ? { key: true, default: 'auto' } : { key: true } }, title: { type: 'string' },
            tags: { 'x-entity': { relation: { to: tagName, many: true } } } } } },
          [tagName]: { ...(tagName === 'Tag' ? {} : { 'x-rename': 'Tag' }), schema: { type: 'object', properties: {
            tid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, label: { type: 'string' } } } },
        } });
        const from = model(fromAuto, 'Tag');
        const to = model(toAuto, 'Aardvark'); // sorts before Post: the join table is rebuilt in the new order
        await withOpen(db, from, async (store) => {
          await store.entity('Tag').create({ tid: 1, label: 'l' });
          await store.entity('Post').create({ pid: 5, title: 't', tags: [1] });
        });
        assert.deepEqual((await applyChain(db, [from, to], ['flip'])).run.applied, ['flip']);
        assert.deepEqual((await db.rows('SELECT "Aardvark_key", "Post_key" FROM "Aardvark_Post"')).map((row) => [Number(row.Aardvark_key), Number(row.Post_key)]), [[1, 5]]);
        assert.equal(await typeOf(db, 'Post', 'pid'), toAuto ? 'bigint' : 'numeric');
        assert.equal(await typeOf(db, 'Aardvark_Post', 'Post_key'), toAuto ? 'bigint' : 'numeric');
      });
    }
  });

  for (const [label, type, stored] of /** @type {const} */ ([['a number key', 'number', '1.5'], ['a string key', 'string', '\'2.5\'']])) {
    it(`${label} holding a fraction, retyped to an allocated integer by a rebuild, refuses the migration naming the key and the value`, async () => {
      await withDatabase('postgres', async (db) => {
        /** @param {string} keyType @param {boolean} auto */
        const keyed = (keyType, auto) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
          pid: { type: keyType, 'x-entity': auto ? { key: true, default: 'auto' } : { key: true } }, title: { type: 'string' } } } } } });
        const from = keyed(type, false);
        const to = keyed('integer', true);
        await withOpen(db, from, (store) => store.entity('Post').create({ pid: type === 'string' ? '7' : 7, title: 'a' }));
        await db.exec(`INSERT INTO "Post" ("pid", "title", "doc") VALUES (${stored}, 'f', '{}'::jsonb)`);
        const migration = planned(db, from, to, 'retype');
        assert.deepEqual(kindsOf(migration), ['ddl', 'sql', 'rebuild']);
        const failure = await refusal(() => migrate(db.target(), [migration], { baseline: from, model: to, shadow: false }));
        assert.equal(failure?.code, 'JD0023');
        assert.match(failure?.message ?? '', new RegExp(`the key 'pid' of 'Post' holds ${stored.replaceAll('\'', '').replace('.', '\\.')}, which is not a whole number a bigint holds`));
        assert.deepEqual((await db.rows('SELECT "pid" FROM "Post" ORDER BY 1')).map((row) => Number(row.pid)), [Number(stored.replaceAll('\'', '')), 7]);
        await db.exec('DELETE FROM "Post" WHERE "title" = \'f\'');
        assert.deepEqual((await migrate(db.target(), [migration], { baseline: from, model: to, shadow: false })).applied, ['retype']);
        assert.deepEqual((await db.rows('SELECT "pid" FROM "Post" ORDER BY 1')).map((row) => Number(row.pid)), [7]);
      });
    });
  }

  it('a block the planner rendered differently is refused with a hint to plan again, and a lock of any other shape is refused', async () => {
    await withDatabase('postgres', async (db) => {
      const from = lonePost(false);
      const to = lonePost(true);
      await withOpen(db, from, (store) => store.entity('Post').create({ pid: 7, title: 'x' }));
      const migration = planned(db, from, to, 'gain');
      const block = migration.steps.findIndex((/** @type {any} */ step) => /^DO /.test(step.sql ?? '') && step.sql.includes('["ensure",'));
      const lock = migration.steps.findIndex((/** @type {any} */ step) => /^DO /.test(step.sql ?? '') && step.sql.includes('["lock",'));
      assert.ok(block > 0 && lock === 0);
      for (const [at, edit, hinted] of /** @type {[number, (sql: string) => string, boolean][]} */ ([
        [block, (sql) => sql.replace('AS bigint', 'AS integer'), true],
        [lock, (sql) => sql.replace('ACCESS EXCLUSIVE', 'SHARE'), true],
        [lock, (sql) => `${sql}; DROP TABLE "Post"`, true],
        // the bare statements are not admitted in the block's place, whatever table they name
        [lock, () => 'LOCK TABLE "Post" IN ACCESS EXCLUSIVE MODE', false],
        [lock, () => 'LOCK TABLE "Post", "Comment" IN ACCESS EXCLUSIVE MODE', false],
      ])) {
        const edited = structuredClone(migration);
        edited.steps[at].sql = edit(edited.steps[at].sql);
        const failure = await refusal(() => migrate(db.target(), [edited], { baseline: from, model: to, shadow: false }));
        assert.equal(failure?.code, 'JD0021');
        if (hinted) assert.match(failure?.message ?? '', /plan the migration again/);
      }
      assert.equal(await typeOf(db, 'Post', 'pid'), 'numeric', 'nothing ran');
    });
  });
});

for (const engine of ENGINES) {
  describe(`${engine}: an epoch member retyped to a number keeps the epoch in its new column`, { skip: skipFor(engine) }, () => {
    for (const type of ['integer', 'number']) {
      it(`a date-time epoch member retyped to ${type}: the rebuild copies the epoch, not the document's string`, async () => {
        await withDatabase(engine, async (db) => {
          const before = memberModel({ type: 'string', format: 'date-time' }, 'epoch');
          const after = memberModel({ type }, 'column');
          await withOpen(db, before, async (store) => {
            await store.entity('Post').create({ pid: 'p1', title: 'a', m: INSTANT });
            await store.entity('Post').create({ pid: 'p2', title: 'b' });
          });
          const migration = planned(db, before, after, 'retype');
          assert.deepEqual(kindsOf(migration), ['rebuild']);
          assert.doesNotMatch(migration.steps.find((/** @type {any} */ step) => step.kind === 'rebuild').copy, /jsonb_extract|#>/);
          assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['retype']);
          assert.deepEqual((await db.rows('SELECT "pid", "m" FROM "Post" ORDER BY 1')).map((row) => [row.pid, row.m === null ? null : Number(row.m)]), [['p1', EPOCH], ['p2', null]]);
        });
      });
    }
  });
}

describe('a rebuild that lifts many members out of the document plans a copy that grows with their number, not past it', () => {
  it('twelve lifted members plan a copy of a few kilobytes on either engine', () => {
    /** @param {string} place @param {boolean} closed */
    const model = (place, closed) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
      pid: { type: 'string', 'x-entity': { key: true } }, title: closed ? { type: 'string', enum: ['a', 'b'] } : { type: 'string' },
      ...Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`m${at}`, { type: 'string', ...PLACE[place] }])) } } } } });
    /** @param {any} dialect */
    const copy = (dialect) => planModelMigration(model('json', false), model('column', true), { dialect, id: 'lift' }).migration.steps
      .find((/** @type {any} */ step) => step.kind === 'rebuild').copy;
    assert.ok(copy(postgresDialect({ searchPath: 'tenant' })).length < 20_000);
    assert.ok(copy(sqliteDialect).length < 20_000);
  });
});

for (const engine of ENGINES) {
  describe(`${engine}: a relation's join table through an edit that renames its endpoint`, { skip: skipFor(engine) }, () => {
    /** @param {any} extra */
    const entity = (extra = {}) => ({ schema: { type: 'object', required: ['pid'], properties: {
      pid: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
    const many = (/** @type {string} */ to) => ({ 'x-entity': { relation: { to, many: true, through: 'Tagging' } } });

    it('a rename that reorders the endpoint columns rebuilds a table that keeps its `through` name', async () => {
      await withDatabase(engine, async (db) => {
        const before = { $model: '0.1', entities: { Post: entity({ tags: many('Tag') }), Tag: entity() } };
        const after = { $model: '0.1', entities: { Post: entity({ tags: many('Label') }), Label: { 'x-rename': 'Tag', ...entity() } } };
        await withOpen(db, before, async (store) => {
          await store.entity('Post').create({ pid: 'p1' });
          await store.entity('Tag').create({ pid: 't1' });
          await store.entity('Tag').create({ pid: 't2' });
          await store.saveChanges();
          store.entity('Post').link('p1', 'tags', 't2');
          store.entity('Post').link('p1', 'tags', 't1');
          await store.saveChanges();
        });
        const migration = planned(db, before, after, 'flip');
        assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['flip']);
        await settled(db, before, after, migration);
        assert.deepEqual((await db.rows('SELECT "Label_key", "Post_key" FROM "Tagging" ORDER BY 1')).map((row) => [row.Label_key, row.Post_key]),
          [['t1', 'p1'], ['t2', 'p1']]);
        const tables = (await db.rows(db.engine === 'sqlite'
          ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
          : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name NOT LIKE '\\_%' ORDER BY 1"))
          .map((row) => row.name);
        assert.deepEqual(tables.filter((name) => !/^(Post|Label|Tagging)$/.test(name)), []);
        if (db.engine === 'postgres') {
          assert.deepEqual((await db.rows("SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('\"Tagging\"') AND contype = 'p'"))
            .map((row) => row.conname), ['Tagging_pkey']);
        }
        const [post] = await withOpen(db, after, (store) => store.entity('Post').asNoTracking()
          .load({ where: { $eq: ['$it.pid', 'p1'] }, include: { tags: true } }));
        assert.deepEqual(post.tags.map((/** @type {any} */ tag) => tag.pid).sort(), ['t1', 't2']);
      });
    });

    it('entities added child-first are created parent-first, which PostgreSQL requires', async () => {
      await withDatabase(engine, async (db) => {
        const other = entity();
        const before = { $model: '0.1', entities: { Other: other } };
        const after = { $model: '0.1', entities: { Other: other, Book: entity({ authorId: { type: 'string' } }),
          Author: entity({ books: { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete: 'cascade' } } } }) } };
        await withOpen(db, before, async () => undefined);
        const migration = planned(db, before, after, 'grow');
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => /^CREATE TABLE "(\w+)"/.exec(step.sql ?? '')?.[1]).filter(Boolean), ['Author', 'Book']);
        assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['grow']);
        await settled(db, before, after, migration);
        await withOpen(db, after, async (store) => {
          await store.entity('Author').create({ pid: 'a1' });
          await store.entity('Book').create({ pid: 'b1', authorId: 'a1' });
          await assert.rejects(store.entity('Book').create({ pid: 'b2', authorId: 'nobody' }), { code: 'JD2005' });
        });
      });
    });

    it('declaring (or no longer declaring) the via property of a relation adds and drops no column', async () => {
      await withDatabase(engine, async (db) => {
        const edges = {
          one: { 'x-entity': { relation: { to: 'Profile', via: 'profileId', onDelete: 'setNull' } } },
          many: { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete: 'cascade' } } },
        };
        const inferred = { $model: '0.1', entities: { Author: entity({ profile: edges.one, books: edges.many }), Profile: entity(), Book: entity() } };
        const declared = { $model: '0.1', entities: { Author: entity({ profile: edges.one, books: edges.many, profileId: { type: 'string' } }),
          Profile: entity(), Book: entity({ authorId: { type: 'string', 'x-entity': { index: true } } }) } };
        await withOpen(db, inferred, async (store) => {
          await store.entity('Profile').create({ pid: 'pr1' });
          await store.entity('Author').create({ pid: 'a1', profileId: 'pr1' });
          await store.entity('Book').create({ pid: 'b1', authorId: 'a1' });
        });
        const chain = [];
        for (const [from, to, id] of [[inferred, declared, 'declare'], [declared, inferred, 'infer']]) {
          const migration = planned(db, from, to, id);
          assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind !== 'jslt'), [], `${id}: no DDL at all`);
          chain.push(migration);
          assert.deepEqual((await migrate(db.target(), chain, { baseline: inferred, model: to, shadow: false })).applied, [id]);
          const [author] = await withOpen(db, to, (store) => store.entity('Author').asNoTracking()
            .load({ where: { $eq: ['$it.pid', 'a1'] }, include: { profile: true, books: true } }));
          assert.deepEqual([author.profile?.pid, author.books.map((/** @type {any} */ book) => book.pid)], ['pr1', ['b1']], id);
        }
        assert.deepEqual((await migrate(db.target(), chain, { baseline: inferred, model: inferred, shadow: false })).applied, []);
      });
    });

    it('an entity dropped with its relation drops the join table first, which still references it', async () => {
      await withDatabase(engine, async (db) => {
        const before = { $model: '0.1', entities: { Post: entity({ tags: many('Tag') }), Tag: entity() } };
        const after = { $model: '0.1', entities: { Tag: entity() } };
        await withOpen(db, before, async (store) => {
          await store.entity('Post').create({ pid: 'p1' });
          await store.entity('Tag').create({ pid: 't1' });
          await store.saveChanges();
          store.entity('Post').link('p1', 'tags', 't1');
          await store.saveChanges();
        });
        const migration = planned(db, before, after, 'gone');
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), ['DROP TABLE "Tagging"', 'DROP TABLE "Post"']);
        assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['gone']);
        await settled(db, before, after, migration);
        assert.deepEqual((await withOpen(db, after, (store) => store.entity('Tag').get('t1')))?.pid, 't1');
      });
    });

    it('a relation dropped in that edit drops the table it still has', async () => {
      await withDatabase(engine, async (db) => {
        const before = { $model: '0.1', entities: { Post: entity({ tags: many('Tag') }), Tag: entity() } };
        const after = { $model: '0.1', entities: { Article: { 'x-rename': 'Post', ...entity() }, Tag: entity() } };
        await withOpen(db, before, async (store) => { await store.entity('Post').create({ pid: 'p1' }); });
        const migration = planned(db, before, after, 'drop');
        assert.deepEqual(migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl').map((/** @type {any} */ step) => step.sql).slice(-1),
          ['DROP TABLE "Tagging"']);
        assert.deepEqual((await migrate(db.target(), [migration], { baseline: before, model: after, shadow: false })).applied, ['drop']);
        await settled(db, before, after, migration);
        assert.deepEqual((await withOpen(db, after, (store) => store.entity('Article').get('p1')))?.pid, 'p1');
      });
    });
  });
}
