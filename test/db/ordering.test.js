//@ts-check
/**
 * @file Statement ordering across relations: inserts parent-first,
 * deletes child-first (proven against RESTRICT keys, where the wrong
 * order throws), join rows after both endpoints, updates that
 * reference newly inserted parents, the `JD0040` cycle refusal, and
 * the all-or-nothing rollback with the tracker left untouched.
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
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'restrict' } } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          title: { type: 'string' },
          authorId: { type: 'string' },
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

const kindOf = (sql) => (/^INSERT INTO "User"/.test(sql) ? 'user-insert'
  : /^INSERT INTO "Post"/.test(sql) ? 'post-insert'
    : /^INSERT INTO "Label"/.test(sql) ? 'label-insert'
      : /^INSERT INTO "Label_User"/.test(sql) ? 'join-insert'
        : /^UPDATE /.test(sql) ? 'update'
          : /^DELETE FROM "Post"/.test(sql) ? 'post-delete'
            : /^DELETE FROM "User"/.test(sql) ? 'user-delete' : 'other');

describe('order of operations', () => {
  it('inserts run parent-first, join rows after both endpoints', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    // added in child-first order on purpose — the planner reorders
    store.entity('Post').add({ pid: 1, title: 'p', authorId: 'u1' });
    store.entity('Label').add({ name: 'admin' });
    const u = store.entity('User').add({ id: 'u1', name: 'ada' });
    store.entity('User').put({ ...u, labels: ['admin'] });
    const report = await store.saveChanges();
    const kinds = report.statements.map((s) => kindOf(s.sql));
    assert.ok(kinds.indexOf('user-insert') < kinds.indexOf('post-insert'),
      `parent before child in ${kinds}`);
    assert.ok(kinds.indexOf('join-insert') > kinds.indexOf('user-insert'));
    assert.ok(kinds.indexOf('join-insert') > kinds.indexOf('label-insert'));
    await store.close();
  });

  it('an update may point at a parent inserted in the same save', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await store.entity('Post').create({ pid: 1, title: 'p', authorId: 'u1' });
    const post = await store.entity('Post').get(1);
    store.entity('User').add({ id: 'u2', name: 'new parent' });
    store.entity('Post').put({ ...post, authorId: 'u2' });
    const report = await store.saveChanges();
    const kinds = report.statements.map((s) => kindOf(s.sql));
    assert.ok(kinds.indexOf('user-insert') < kinds.indexOf('update'),
      'the referenced parent exists before the foreign key moves');
    await store.close();
  });

  it('deletes run child-first — RESTRICT would refuse the other order', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await store.entity('Post').create({ pid: 1, title: 'p', authorId: 'u1' });
    store.entity('User').remove('u1');
    store.entity('Post').remove(1);
    const report = await store.saveChanges();
    const kinds = report.statements.map((s) => kindOf(s.sql));
    assert.deepStrictEqual(kinds, ['post-delete', 'user-delete']);
    assert.strictEqual(report.deleted, 2);
    await store.close();
  });

  it('a foreign-key cycle among the inserts is JD0040, named', async () => {
    const cyclic = {
      $model: '0.1',
      entities: {
        A: {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              bId: { type: 'string' },
              b: { 'x-entity': { relation: { to: 'B', via: 'bId', onDelete: 'setNull' } } },
            },
          },
        },
        B: {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', 'x-entity': { key: true } },
              aId: { type: 'string' },
              a: { 'x-entity': { relation: { to: 'A', via: 'aId', onDelete: 'setNull' } } },
            },
          },
        },
      },
    };
    const store = await openStore(cyclic, { driver: nodeDriver() });
    store.entity('A').add({ id: 'a1' });
    store.entity('B').add({ id: 'b1' });
    await assert.rejects(() => store.saveChanges(), (error) => {
      assert.strictEqual(/** @type {any} */ (error).code, 'JD0040');
      assert.match(/** @type {any} */ (error).message, /A → B/);
      return true;
    });
    // one side alone is orderable — the cycle needs both in the save
    store.entity('B').remove('b1');
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, 1);
    await store.close();
  });

  it('a self-referencing entity refuses a same-save insert pair', async () => {
    const selfRef = {
      $model: '0.1',
      entities: {
        Comment: {
          schema: {
            type: 'object',
            required: ['cid'],
            properties: {
              cid: { type: 'integer', 'x-entity': { key: true } },
              parentId: { type: 'integer' },
              parent: { 'x-entity': { relation: { to: 'Comment', via: 'parentId', onDelete: 'cascade' } } },
            },
          },
        },
      },
    };
    const store = await openStore(selfRef, { driver: nodeDriver() });
    store.entity('Comment').add({ cid: 1 });
    await assert.rejects(() => store.saveChanges(),
      (error) => /** @type {any} */ (error).code === 'JD0040');
    await store.close();
  });

  it('a failure on the LAST statement rolls everything back, tracker intact', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    // an UNTRACKED post keeps the RESTRICT key populated
    await store.entity('Post').create({ pid: 9, title: 'blocker', authorId: 'u1' });

    store.entity('Label').add({ name: 'kept?' });
    store.entity('User').remove('u1'); // deletes come last; RESTRICT throws
    const before = store.stats().tracker;
    await assert.rejects(() => store.saveChanges(),
      (error) => /** @type {any} */ (error).code === 'JD2005');

    assert.strictEqual(await store.entity('Label').asNoTracking().get('kept?'),
      undefined, 'the earlier insert rolled back with the failure');
    assert.deepStrictEqual(store.stats().tracker, before,
      'the tracker is exactly as it was before the call');

    // clear the blocker; the SAME tracked state retries to success
    await store.entity('Post').delete(9);
    const report = await store.saveChanges();
    assert.strictEqual(report.inserted, 1);
    assert.strictEqual(report.deleted, 1);
    assert.deepStrictEqual(
      (await store.entity('Label').asNoTracking().get('kept?'))?.name, 'kept?');
    assert.strictEqual(await store.entity('User').asNoTracking().get('u1'), undefined);
    await store.close();
  });
});
