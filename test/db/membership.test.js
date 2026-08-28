//@ts-check
/**
 * @file The membership API (MODEL-FORMAT §11.7): `link`/`unlink` on an
 * entity set record one many-to-many membership change each, and
 * `saveChanges()` writes the join rows against the join table AS READ
 * at save time — so a repeated save changes nothing (the two-run
 * property), the last word on one target wins, a delta beside a
 * `put`-based sync of the same member folds into it, an unsaved own
 * key is refused with the tracker's own message, and a failed save
 * leaves the pending changes exactly as they were.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
          tags: { 'x-entity': { relation: { to: 'Label', many: true, through: 'post_tags' } } },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

async function seeded() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  await store.entity('User').create({ id: 'u1', name: 'ada' });
  for (const name of ['admin', 'dev', 'ops']) await store.entity('Label').create({ name });
  return store;
}

/** The label names a user is a member of, read back through the join table. */
const labelsOf = async (store, id) => {
  const [user] = await store.entity('User').asNoTracking()
    .load({ where: { $eq: ['$it.id', id] }, include: { labels: true } });
  return user.labels.map((label) => label.name).sort();
};

const joinStatements = (report, kind) =>
  report.statements.filter((s) => new RegExp(`^${kind} `).test(s.sql)
    && /Label_User|post_tags/.test(s.sql));

describe('link and unlink through the unit of work (§11.7)', () => {
  it('link writes one join row; the same link saved again changes nothing (two-run)', async () => {
    const store = await seeded();
    const users = store.entity('User');
    users.link('u1', 'labels', 'admin');
    assert.strictEqual(store.stats().tracker.pendingMemberships, 1);
    const first = await store.saveChanges();
    assert.strictEqual(first.joinInserted, 1);
    assert.strictEqual(joinStatements(first, 'INSERT INTO').length, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['admin']);
    assert.strictEqual(store.stats().tracker.pendingMemberships, 0);

    users.link('u1', 'labels', 'admin');
    const second = await store.saveChanges();
    assert.strictEqual(second.joinInserted, 0);
    assert.strictEqual(second.statements.length, 0, 'a member that exists is a no-op');
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['admin']);
    await store.close();
  });

  it('unlink deletes the row; unlinking a non-member is a no-op', async () => {
    const store = await seeded();
    const users = store.entity('User');
    users.link('u1', 'labels', 'admin');
    users.link('u1', 'labels', 'dev');
    await store.saveChanges();
    users.unlink('u1', 'labels', 'admin');
    users.unlink('u1', 'labels', 'ops');
    const report = await store.saveChanges();
    assert.strictEqual(report.joinDeleted, 1);
    assert.strictEqual(joinStatements(report, 'DELETE FROM').length, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['dev']);
    await store.close();
  });

  it('the last word on one target wins within a unit of work', async () => {
    const store = await seeded();
    const users = store.entity('User');
    users.link('u1', 'labels', 'admin');
    await store.saveChanges();
    // link then unlink of a member: unlink
    users.link('u1', 'labels', 'admin');
    users.unlink('u1', 'labels', 'admin');
    // unlink then link of a non-member: link
    users.unlink('u1', 'labels', 'dev');
    users.link('u1', 'labels', 'dev');
    const report = await store.saveChanges();
    assert.strictEqual(report.joinDeleted, 1);
    assert.strictEqual(report.joinInserted, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['dev']);
    await store.close();
  });

  it('own and target sides take a key or a document carrying the key', async () => {
    const store = await seeded();
    const users = store.entity('User');
    const ada = await users.get('u1');
    users.link(ada, 'labels', { name: 'ops' });
    users.link({ id: 'u1' }, 'labels', 'dev');
    const report = await store.saveChanges();
    assert.strictEqual(report.joinInserted, 2);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['dev', 'ops']);
    // a target carrying no usable key is the membership array's refusal
    assert.throws(() => users.link('u1', 'labels', { nope: 'x' }),
      (e) => e.code === 'JD2003' && /carries no usable 'name' key/.test(e.message));
    assert.throws(() => users.link('u1', 'labels', null),
      (e) => e.code === 'JD2003');
    await store.close();
  });

  it('a delta beside a put of the same member folds into one key-set difference', async () => {
    const store = await seeded();
    const users = store.entity('User');
    const ada = await users.get('u1');
    users.put({ ...ada, labels: ['admin'] });
    users.link(ada, 'labels', 'dev');
    const report = await store.saveChanges();
    assert.strictEqual(report.joinInserted, 2);
    assert.strictEqual(joinStatements(report, 'INSERT INTO').length, 1,
      'one statement carries both rows — never two racing for one member');
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['admin', 'dev']);
    // and an unlink beside a put that would re-add the same key: the delta wins
    const again = await users.get('u1');
    users.put({ ...again, name: 'ada2', labels: ['admin', 'dev'] });
    users.unlink(again, 'labels', 'admin');
    const second = await store.saveChanges();
    assert.strictEqual(second.updated, 1);
    assert.strictEqual(second.joinDeleted, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['dev']);
    await store.close();
  });

  it('a pending insert with a caller-supplied key links in the same save; an auto key cannot', async () => {
    const store = await seeded();
    const users = store.entity('User');
    users.add({ id: 'u9', name: 'new' });
    users.link('u9', 'labels', 'admin');
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, 1);
    assert.strictEqual(report.joinInserted, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u9'), ['admin']);
    // the auto-keyed post has no key to attach to before the save
    const posts = store.entity('Post');
    const draft = posts.add({ title: 'draft', authorId: 'u1' });
    assert.throws(() => posts.link(draft, 'tags', 'admin'),
      (e) => e.code === 'JD2003'
        && /'tags' membership needs the entity's own key at link\(\) time — save the entity first, then attach/.test(e.message));
    // …and the tracker's add() path says the same thing in its own words,
    // at save time (a membership array rides the pending insert)
    const other = await seeded();
    other.entity('Post').add({ title: 'x', authorId: 'u1', tags: ['admin'] });
    await assert.rejects(other.saveChanges(),
      (e) => e.code === 'JD2003' && /at add\(\) time — save the entity first, then attach/.test(e.message));
    await other.close();
    await store.saveChanges();
    const saved = (await posts.asNoTracking().load({ orderBy: '$it.pid' })).at(-1);
    posts.link(saved.pid, 'tags', 'admin');
    const tagged = await store.saveChanges();
    assert.strictEqual(tagged.joinInserted, 1);
    assert.match(tagged.statements[0].sql, /"post_tags"/, 'a through name is the join table');
    await store.close();
  });

  it('refuses a member that is not a many-to-many relation, naming the kind', async () => {
    const store = await seeded();
    const users = store.entity('User');
    assert.throws(() => users.link('u1', 'posts', 1),
      (e) => e.code === 'JD2003' && /'posts' is a oneToMany relation/.test(e.message)
        && /many-to-many memberships only/.test(e.message));
    assert.throws(() => users.unlink('u1', 'name', 'x'),
      (e) => e.code === 'JD2003' && /'name' is not a relation member of 'User'/.test(e.message));
    assert.throws(() => store.entity('Nope').link('u1', 'labels', 'admin'),
      (e) => e.code === 'JD2004');
    assert.strictEqual(store.stats().tracker.pendingMemberships, 0, 'a refusal records nothing');
    await store.close();
  });

  it('discard drops the pending memberships of the key; a failed save leaves them pending', async () => {
    const store = await seeded();
    const users = store.entity('User');
    users.link('u1', 'labels', 'admin');
    users.discard('u1');
    assert.strictEqual(store.stats().tracker.pendingMemberships, 0);
    assert.strictEqual((await store.saveChanges()).statements.length, 0);

    users.link('u1', 'labels', 'ghost');
    await assert.rejects(store.saveChanges(), (e) => e.code === 'JD2005');
    assert.strictEqual(store.stats().tracker.pendingMemberships, 1, 'the tracker is untouched by a failed save');
    await store.entity('Label').create({ name: 'ghost' });
    const retried = await store.saveChanges();
    assert.strictEqual(retried.joinInserted, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['ghost']);
    await store.close();
  });

  it('the promise-free twin links and unlinks the same way', async () => {
    const store = await seeded();
    const users = store.sync.entity('User');
    users.link('u1', 'labels', 'admin');
    users.link('u1', 'labels', 'dev');
    assert.strictEqual(store.sync.saveChanges().joinInserted, 2);
    users.unlink('u1', 'labels', 'admin');
    assert.strictEqual(store.sync.saveChanges().joinDeleted, 1);
    assert.deepStrictEqual(await labelsOf(store, 'u1'), ['dev']);
    await store.close();
  });
});
