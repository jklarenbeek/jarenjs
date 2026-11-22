//@ts-check
/**
 * @file On PostgreSQL, a change the planner expresses as a rebuild, of a
 * table another table references (or that references itself), is made in
 * place where the change has an in-place form: a column's `enum` (its CHECK
 * dropped and added again) and a retype the copy makes by a cast (`ALTER
 * COLUMN … TYPE … USING` that cast, after the check of the stored values a
 * rebuild takes). The rebuild could not drop such a table (`JD0023`); in
 * place, the referencing rows, their foreign key and its cascade survive,
 * the store opens on the result and reads it back as a fresh create of the
 * target model reads, a stored value the change would break fails the link
 * as the rebuild's copy failed it, and a table nothing references, or a
 * change without such a form, plans the rebuild as before. On the server
 * `JAREN_PG_URL` names, a schema per case, dropped after.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, planModelMigration, migrate, migrationHistory } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

const PG_URL = process.env.JAREN_PG_URL;
let schemaNumber = 0;

/** @param {(context: { pool: any, schema: string, driver: () => any }) => Promise<void>} run */
async function withSchema(run) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  const schema = `jaren_alter_in_place_${process.pid}_${schemaNumber++}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  try { await run({ pool, schema, driver: () => postgresDriver(pool, { schema }) }); }
  finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** The link from `from` to `to` on PostgreSQL, without its draft steps; `searchPath` names the schema as a
 * model with database rules needs it. @param {any} from @param {any} to @param {string} schema @param {boolean} [searchPath] */
function planned(from, to, schema, searchPath = false) {
  const { migration } = planModelMigration(from, to, { dialect: postgresDialect(searchPath ? { searchPath: schema } : { schema }), id: 'change' });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  return migration;
}

const comments = { 'x-entity': { relation: { to: 'Comment', many: true, via: 'postId', onDelete: 'cascade' } } };
const comment = { schema: { type: 'object', properties: {
  cid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, postId: { type: 'integer' }, body: { type: 'string' } } } };
/** A post another entity references, whose members are `members`. @param {Record<string, any>} members @param {any[]} [indexes] */
const referenced = (members, indexes = undefined) => ({ $model: '0.1', entities: {
  Post: { schema: { type: 'object', properties: { pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, comments, ...members } },
    ...(indexes === undefined ? {} : { indexes }) },
  Comment: comment } });
/** A post nothing references. @param {Record<string, any>} members */
const alone = (members) => ({ $model: '0.1', entities: { Post: { schema: { type: 'object', properties: {
  pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, ...members } } } } });
const children = { 'x-entity': { relation: { to: 'Category', many: true, via: 'parentId', onDelete: 'cascade' } } };
/** A category that references itself. @param {any} name */
const tree = (name) => ({ $model: '0.1', entities: { Category: { schema: { type: 'object', properties: {
  cid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, name, parentId: { type: 'integer' }, children } } } } });

/** The model `store` reads back, as JSON whose member order does not count. @param {any} store */
const readBack = async (store) => {
  const sorted = (/** @type {any} */ value) => (Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value);
  return JSON.stringify(sorted((await store.introspect()).model));
};

/** What a fresh create of `model` reads back as. @param {any} model */
const freshly = (model) => withSchemaResult(async ({ driver }) => {
  const store = await openStore(model, { driver: driver() });
  try { return await readBack(store); }
  finally { await store.close(); }
});
/** @template T @param {(context: { pool: any, schema: string, driver: () => any }) => Promise<T>} run @returns {Promise<T>} */
const withSchemaResult = async (run) => {
  /** @type {any} */
  let result;
  await withSchema(async (context) => { result = await run(context); });
  return result;
};

describe('postgres: a referenced table changed in place', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('an enum added to a referenced table: the comments, their key and its cascade survive, and the store reads it back as created', async () => {
    const [from, to] = [referenced({ title: { type: 'string' } }), referenced({ title: { type: 'string', enum: ['x', 'y'] } })];
    const fresh = await freshly(to);
    await withSchema(async ({ pool, schema, driver }) => {
      const store = await openStore(from, { driver: driver() });
      await store.entity('Post').create({ title: 'x' });
      await store.entity('Comment').create({ postId: 1, body: 'c' });
      await store.close();
      const migration = planned(from, to, schema);
      assert.ok(migration.steps.every((/** @type {any} */ step) => step.kind !== 'rebuild'), 'no rebuild');
      await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false });
      const after = await openStore(to, { driver: driver() });
      try {
        assert.equal(await readBack(after), fresh);
        assert.deepEqual((await after.entity('Comment').asNoTracking().get(1))?.postId, 1);
        assert.equal((await after.entity('Post').create({ title: 'y' })).pid, 2);
        await assert.rejects(pool.query(`INSERT INTO "${schema}"."Post" ("title", "doc") VALUES ('z', '{}')`), { code: '23514' });
        await assert.rejects(pool.query(`INSERT INTO "${schema}"."Comment" ("postId", "doc") VALUES (9, '{}')`), { code: '23503' });
        await after.entity('Post').delete(1);
        assert.equal(await after.entity('Comment').asNoTracking().get(1), undefined);
      }
      finally { await after.close(); }
    });
  });

  it('an enum changed on a table that references itself, whose CHECK a rebuild named after its temporary table', async () => {
    const [from, to] = [tree({ type: 'number', enum: [1, 2] }), tree({ type: 'number', enum: [1, 2, 3] })];
    const fresh = await freshly(to);
    await withSchema(async ({ pool, driver, schema }) => {
      await (await openStore(from, { driver: driver() })).close();
      // the name a rebuild leaves a column's CHECK under, a number appended where it was taken
      await pool.query(`ALTER TABLE "${schema}"."Category" RENAME CONSTRAINT "Category_name_check" TO "Category__rebuild_name_check1"`);
      const seeded = await openStore(from, { driver: driver() });
      await seeded.entity('Category').create({ name: 1 });
      await seeded.entity('Category').create({ name: 2, parentId: 1 });
      await seeded.close();
      const migration = planned(from, to, schema);
      assert.ok(migration.steps.every((/** @type {any} */ step) => step.kind !== 'rebuild'), 'no rebuild');
      await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false });
      const after = await openStore(to, { driver: driver() });
      try {
        assert.equal(await readBack(after), fresh);
        assert.equal((await after.entity('Category').create({ name: 3, parentId: 2 })).cid, 3);
        await after.entity('Category').delete(1);
        for (const cid of [1, 2, 3]) assert.equal(await after.entity('Category').asNoTracking().get(cid), undefined);
      }
      finally { await after.close(); }
    });
  });

  it('a stored value the new enum refuses fails the link as the rebuild fails it, and nothing changes', async () => {
    /** What a migration from `from` to `to` over a post titled `z` answers, and the titles after. @param {any} from @param {any} to */
    const outcome = (from, to) => withSchemaResult(async ({ pool, schema, driver }) => {
      const store = await openStore(from, { driver: driver() });
      await store.entity('Post').create({ title: 'z' });
      await store.close();
      const migration = planned(from, to, schema);
      const answer = await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false })
        .then(() => 'migrated', (/** @type {any} */ error) => ({ code: error.code, class: error.class, retryable: error.retryable }));
      return { kinds: migration.steps.map((/** @type {any} */ step) => step.kind === 'rebuild' ? 'rebuild' : 'alter'),
        answer, history: (await migrationHistory({ driver: driver() })).history.rows.length,
        titles: (await pool.query(`SELECT "title" FROM "${schema}"."Post"`)).rows };
    });
    const inPlace = await outcome(referenced({ title: { type: 'string' } }), referenced({ title: { type: 'string', enum: ['x', 'y'] } }));
    const rebuilt = await outcome(alone({ title: { type: 'string' } }), alone({ title: { type: 'string', enum: ['x', 'y'] } }));
    assert.deepEqual(rebuilt.kinds, ['rebuild']);
    assert.ok(inPlace.kinds.every((kind) => kind === 'alter'));
    assert.deepEqual(inPlace.answer, rebuilt.answer);
    assert.deepEqual(inPlace.answer, { code: 'JD0023', class: 'constraint', retryable: false });
    for (const { history, titles } of [inPlace, rebuilt]) assert.deepEqual({ history, titles }, { history: 0, titles: [{ title: 'z' }] });
  });

  it('a text retyped into a number by its cast, its stored values checked first as the rebuild checks them', async () => {
    const [from, to] = [referenced({ score: { type: 'string' } }), referenced({ score: { type: 'number' } })];
    const fresh = await freshly(to);
    for (const [score, expected] of /** @type {[string, any][]} */ ([[' 5', 5], [' 2.5', 2.5], ['abc', 'JD0023']])) {
      await withSchema(async ({ pool, schema, driver }) => {
        const store = await openStore(from, { driver: driver() });
        await store.entity('Post').create({ score });
        await store.entity('Comment').create({ postId: 1, body: 'c' });
        await store.close();
        const migration = planned(from, to, schema);
        assert.ok(migration.steps.every((/** @type {any} */ step) => step.kind !== 'rebuild'), 'no rebuild');
        const answer = await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false })
          .then(() => 'migrated', (/** @type {any} */ error) => error.code
            + (error.message.includes(`the member 'score' of 'Post' holds ${score}, which is not a finite number`) ? ' named' : ''));
        if (typeof expected === 'string') {
          assert.equal(answer, `${expected} named`);
          assert.deepEqual((await pool.query(`SELECT "score" FROM "${schema}"."Post"`)).rows, [{ score }]);
          return;
        }
        assert.equal(answer, 'migrated');
        const after = await openStore(to, { driver: driver() });
        try {
          assert.equal(await readBack(after), fresh);
          assert.equal((await after.entity('Post').asNoTracking().get(1))?.score, expected);
          assert.equal((await after.entity('Comment').asNoTracking().get(1))?.postId, 1);
        }
        finally { await after.close(); }
      });
    }
  });

  it('every retype a cast makes answers in place as the rebuild of a table nothing references answers it', async () => {
    /** @type {[string, string, any][]} */
    const pairs = [['string', 'integer', '12'], ['string', 'integer', '12.5'], ['string', 'boolean', '1'], ['string', 'boolean', 'true'],
      ['string', 'number', ' 5'], ['number', 'integer', 5], ['number', 'integer', 2.5], ['integer', 'number', 7],
      ['boolean', 'string', true], ['boolean', 'integer', false], ['boolean', 'number', true]];
    /** What the retype of `value` from `fromType` to `toType` answers over `make`'s model, and the value it reads back.
     * @param {(members: Record<string, any>) => any} make @param {string} fromType @param {string} toType @param {any} value */
    const outcome = (make, fromType, toType, value) => withSchemaResult(async ({ driver, schema }) => {
      const [from, to] = [make({ v: { type: fromType } }), make({ v: { type: toType } })];
      const store = await openStore(from, { driver: driver() });
      await store.entity('Post').create({ v: value });
      await store.close();
      const migration = planned(from, to, schema);
      const kinds = [...new Set(migration.steps.map((/** @type {any} */ step) => (step.kind === 'rebuild' ? 'rebuild' : 'alter')))];
      const answer = await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false })
        .then(() => 'migrated', (/** @type {any} */ error) => `${error.code} ${error.class}`);
      if (answer !== 'migrated') return { kinds, answer };
      const after = await openStore(to, { driver: driver() });
      try { return { kinds, answer, read: (await after.entity('Post').asNoTracking().get(1))?.v }; }
      finally { await after.close(); }
    });
    for (const [fromType, toType, value] of pairs) {
      const inPlace = await outcome(referenced, fromType, toType, value);
      const rebuilt = await outcome(alone, fromType, toType, value);
      const label = `${fromType} ${JSON.stringify(value)} into ${toType}`;
      assert.deepEqual([inPlace.kinds, rebuilt.kinds], [['alter'], ['rebuild']], label);
      assert.deepEqual({ ...inPlace, kinds: undefined }, { ...rebuilt, kinds: undefined }, label);
    }
  });

  it('the rules of the changed table and of the table that references it hold after an in-place retype', async () => {
    const rule = (/** @type {any} */ declared) => {
      const model = structuredClone(declared);
      model.entities.Post.invariants = [{ name: 'titled', on: ['insert', 'update'], enforcement: 'database', assert: { $ne: ['$.new.title', 'bad'] } }];
      model.entities.Comment.invariants = [{ name: 'posted', on: ['insert'], enforcement: 'database',
        assert: { '$exists-row': { entity: 'Post', match: { pid: '$.new.postId' } } } }];
      return model;
    };
    const [from, to] = [rule(referenced({ title: { type: 'string' }, score: { type: 'string' } })),
      rule(referenced({ title: { type: 'string' }, score: { type: 'number' } }))];
    await withSchema(async ({ driver, schema }) => {
      const store = await openStore(from, { driver: driver() });
      await store.entity('Post').create({ title: 'ok', score: '5' });
      await store.entity('Comment').create({ postId: 1, body: 'c' });
      await store.close();
      const migration = planned(from, to, schema, true);
      assert.ok(migration.steps.every((/** @type {any} */ step) => step.kind !== 'rebuild'), 'no rebuild');
      await migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false });
      const after = await openStore(to, { driver: driver() });
      try {
        const verdict = (/** @type {Promise<any>} */ write) => write.then(() => 'ok', (/** @type {any} */ error) => error.code);
        // the rule's own refusal, as a fresh create of the target model answers it
        const fresh = await withSchemaResult(async (created) => {
          const store = await openStore(to, { driver: created.driver() });
          try { return await verdict(store.entity('Post').create({ title: 'bad', score: 1 })); }
          finally { await store.close(); }
        });
        assert.notEqual(fresh, 'ok');
        assert.equal(await verdict(after.entity('Post').create({ title: 'bad', score: 1 })), fresh);
        const { pid } = await after.entity('Post').create({ title: 'fine', score: 2 });
        assert.equal(await verdict(after.entity('Comment').create({ postId: pid, body: 'd' })), 'ok');
        assert.notEqual(await verdict(after.entity('Comment').create({ postId: pid + 100, body: 'e' })), 'ok');
        assert.equal((await after.entity('Post').asNoTracking().get(1))?.score, 5);
      }
      finally { await after.close(); }
    });
  });

  it('a table nothing references, an indexed column and a retype into text keep the rebuild', () => withSchemaResult(async ({ schema }) => {
    const kinds = (/** @type {any} */ from, /** @type {any} */ to) => planned(from, to, schema).steps.map((/** @type {any} */ step) => step.kind);
    assert.deepEqual(kinds(alone({ title: { type: 'string' } }), alone({ title: { type: 'string', enum: ['x'] } })), ['rebuild']);
    const index = [{ name: 'by_title', path: '$.title' }];
    assert.deepEqual(kinds(referenced({ title: { type: 'string' } }, index), referenced({ title: { type: 'string', enum: ['x'] } }, index)), ['rebuild']);
    assert.deepEqual(kinds(referenced({ n: { type: 'number' } }), referenced({ n: { type: 'string' } })), ['rebuild']);
    assert.deepEqual(kinds(referenced({ n: { type: 'integer' } }), referenced({ n: { type: 'string' } })), ['rebuild']);
  }));
});
