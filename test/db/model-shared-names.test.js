//@ts-check
/**
 * @file Two objects of a model never share a name the engine cannot tell
 * apart. A join table holds the memberships of ONE edge -- its two inverse
 * declarations at most; the same pair declared twice, or two pairs given one
 * `through`, once opened as a model whose relations read and wrote a single
 * table (a link through `labels` showed in `tags`, and the second pair's
 * writes met a raw foreign-key failure). And no collection, entity or join
 * table takes the name of an engine table (the migration history, the change
 * ledger, the job queue, the owner lease): such a model once opened and then
 * shared, or lost, that table.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore, normalizeEntities, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const ent = (extra = {}) => ({ schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
const many = (/** @type {string} */ to, /** @type {string} */ through = undefined) => ({ 'x-entity': { relation: { to, many: true, ...(through === undefined ? {} : { through }) } } });
const model = (/** @type {any} */ entities) => ({ $model: '0.1', entities });

/** @param {() => any} run */
const refusal = (run) => { try { run(); } catch (error) { return /** @type {any} */ (error); } return null; };

describe('a join table belongs to one edge', () => {
  it('the same pair declared twice shares its implicit table: refused JD0031 naming both', () => {
    const error = refusal(() => normalizeEntities(model({ Post: ent({ tags: many('Tag'), labels: many('Tag') }), Tag: ent() })));
    assert.strictEqual(error?.code, 'JD0031');
    assert.strictEqual(error?.message, "JD0031: relation 'Post.tags' and 'Post.labels' both use the join table 'Post_Tag' "
      + 'but do not declare one edge: give each edge its own through at /entities/Post/schema/properties/labels/x-entity/relation');
  });

  it('two pairs given one through are refused, and a through of its own for each is fine', () => {
    const shared = refusal(() => normalizeEntities(model({
      Post: ent({ tags: many('Tag', 'Link') }), Tag: ent(), Author: ent({ notes: many('Note', 'Link') }), Note: ent() })));
    assert.strictEqual(shared?.code, 'JD0031');
    assert.match(shared?.message, /^JD0031: relation 'Post\.tags' and 'Author\.notes' both use the join table 'Link' /);
    const own = normalizeEntities(model({
      Post: ent({ tags: many('Tag', 'PostTags') }), Tag: ent(), Author: ent({ notes: many('Note', 'AuthorNotes') }), Note: ent() }));
    assert.strictEqual(own.get('Post')?.relations[0].relation.joinTable, 'PostTags');
  });

  it('a third declaration of an inverse pair is refused; the pair itself still shares its table', () => {
    const pair = { Post: ent({ tags: many('Tag') }), Tag: ent({ posts: many('Post') }) };
    const pairModel = normalizeEntities(model(pair));
    assert.strictEqual(pairModel.get('Post')?.relations[0].relation.joinTable, 'Post_Tag');
    assert.strictEqual(pairModel.get('Tag')?.relations[0].relation.joinTable, 'Post_Tag');
    const third = refusal(() => normalizeEntities(model({ ...pair, Tag: ent({ posts: many('Post'), more: many('Post') }) })));
    assert.strictEqual(third?.code, 'JD0031');
    assert.match(third?.message, /^JD0031: relation 'Post\.tags' and 'Tag\.more' both use the join table 'Post_Tag' /);
  });

  it('a store is not opened over relations that shared a table', async () => {
    await assert.rejects(openStore(model({ Post: ent({ tags: many('Tag'), labels: many('Tag') }), Tag: ent() }), { driver: nodeDriver() }),
      { code: 'JD0031' });
  });
});

describe('the engine\'s own table names are not a model\'s', () => {
  const ENGINE = ['_jaren_migrations', '_jaren_migration_identity', '_jaren_changes', '_jaren_changes_state', '_jaren_jobs',
    '_jaren_job_checkpoints', '_jaren_owner'];

  for (const name of ENGINE) {
    it(`${name}: a collection, an entity and a join table of that name are refused JD0004 at open`, async () => {
      const models = [
        { $model: '0.1', collections: { [name]: { key: '/id', schema: { type: 'object' } } } },
        model({ [name]: ent() }),
        model({ Post: ent({ tags: many('Tag', name) }), Tag: ent() }),
      ];
      for (const candidate of models) {
        await assert.rejects(openStore(candidate, { driver: nodeDriver() }), (error) => {
          assert.strictEqual(/** @type {any} */ (error).code, 'JD0004');
          assert.match(/** @type {Error} */ (error).message, new RegExp(`would be named '${name}', the name of the engine's own table '${name}'`));
          return true;
        });
      }
    });
  }

  it('ASCII case folded, as every name of a database is compared; and a migration refuses it too', () => {
    const from = model({ A: ent() });
    const to = model({ A: ent(), _JAREN_JOBS: ent() });
    assert.throws(() => planModelMigration(from, to, { dialect: sqliteDialect, id: 'm' }),
      { code: 'JD0004', message: /would be named '_JAREN_JOBS', the name of the engine's own table '_jaren_jobs' \('_jaren_jobs': names are compared with ASCII case folded.*rename the entity/ });
  });

  it('another name with the prefix is the model\'s own', async () => {
    const store = await openStore(model({ _jaren_mine: ent() }), { driver: nodeDriver() });
    await store.entity('_jaren_mine').create({ id: 'a' });
    assert.strictEqual((await store.entity('_jaren_mine').get('a'))?.id, 'a');
    await store.close();
  });
});
