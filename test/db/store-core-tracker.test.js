//@ts-check
/**
 * @file The unit of work keeps the last staged word on a key, and meets a
 * duplicate key with the code every other write path gives it — on SQLite
 * and on PostgreSQL alike (MODEL-FORMAT §11.1, §7).
 *
 * A `put()` after a pending `remove()` of the same key is the replacement
 * the `add()` refusal points to: it clears the removal and the save updates
 * the row. A save inside a transaction that deletes a key, followed by an
 * `add()` of that key and a rollback, leaves both pending — the save's
 * removal staged again and the later insert as it was staged — and the next
 * save runs them in that order: the delete, then the insert, after the
 * removals of the rows that reference the key. The opposite pair — a row the
 * save inserted, removed after the save, then a rollback — is a `remove()` of
 * a pending add: both are withdrawn, as `add(); remove()` leaves nothing.
 * Nothing includes the `link()`s and `unlink()`s staged under that key, before
 * or after the add: the save wrote their join rows for a row it never
 * inserted, and failed on the foreign key.
 *
 * Every word staged after a rolled-back save stays with the row it belongs
 * to, whichever key the save gave that row: an update the transaction read
 * again or discarded is pending again, an edit, a link or an unlink by an
 * allocated key goes back to the pending insert (without that key), and a
 * removal is guarded by the version the row had before the save. The update
 * of a child that references a row deleted ahead runs before that delete.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ENGINES, skipFor, withStore, counted } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' } } } },
    Note: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      rev: { type: 'integer', 'x-entity': { version: true } } } } },
  },
};

/** An allocated key with a many-to-many membership. */
const ALLOCATED = {
  $model: '0.1',
  entities: {
    Post: { schema: { type: 'object', properties: {
      pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, title: { type: 'string' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  },
};

/** A many-to-many membership under explicit keys. */
const LINKED = {
  $model: '0.1',
  entities: {
    Item: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Tag: { schema: { type: 'object', properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  },
};

/** Each post's title and the names of its tags, sorted. @param {any} store */
const postsOf = async (store) => (await store.entity('Post').asNoTracking().load({ include: { tags: true } }))
  .map((/** @type {any} */ post) => [post.title, post.tags.map((/** @type {any} */ tag) => tag.name).sort()])
  .sort((/** @type {any} */ a, /** @type {any} */ b) => (a[0] < b[0] ? -1 : 1));

/** Parents and versioned children, the reference deleting as `onDelete` says. @param {string} onDelete */
const FAMILY = (onDelete) => ({
  $model: '0.1',
  entities: {
    Parent: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete } } } } } },
    Kid: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: ['string', 'null'] }, v: { type: 'integer' },
      rev: { type: 'integer', 'x-entity': { version: true } } } } },
  },
});

/** Parents, versioned children and their children, deleting as `onDelete` says. @param {string} onDelete */
const LINEAGE = (onDelete) => ({
  $model: '0.1',
  entities: {
    Parent: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, v: { type: 'integer' },
      kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete } } } } } },
    Kid: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: ['string', 'null'] }, v: { type: 'integer' },
      rev: { type: 'integer', 'x-entity': { version: true } },
      pups: { 'x-entity': { relation: { to: 'Pup', many: true, via: 'kidId', onDelete } } } } } },
    Pup: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, kidId: { type: ['string', 'null'] } } } },
  },
});

/** Parents keyed by an integer, and their versioned children. @param {string} onDelete */
const NUMBERED = (onDelete) => ({
  $model: '0.1',
  entities: {
    Parent: { schema: { type: 'object', properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, v: { type: 'integer' },
      kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'parentId', onDelete } } } } } },
    Kid: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: ['integer', 'null'] },
      rev: { type: 'integer', 'x-entity': { version: true } } } } },
  },
});

/** Every row of the lineage, as `id→reference:v`. @param {any} store */
const lineageOf = async (store) => Object.fromEntries(await Promise.all(['Parent', 'Kid', 'Pup'].map(async (name) => [name,
  (await store.entity(name).asNoTracking().load({})).map((/** @type {any} */ row) =>
    `${row.id}${row.parentId !== undefined ? `→${row.parentId}` : ''}${row.kidId !== undefined ? `→${row.kidId}` : ''}${row.v === undefined ? '' : `:${row.v}`}`).sort()])));

/** A save statement as its verb and table. @param {{ sql: string }} statement */
const statementOf = (statement) => {
  const [, verb, table] = /^(\w+) (?:INTO|FROM) (?:"[^"]*"\.)?"([^"]+)"/.exec(statement.sql) ?? [];
  return `${verb} ${table}`;
};

/** The tracker's pending counts. @param {any} store */
const pending = (store) => {
  const { pendingInserts, pendingDeletes } = store.stats().tracker;
  return { pendingInserts, pendingDeletes };
};

for (const engine of ENGINES) {
  describe(`the last staged word on a key wins (${engine})`, { skip: skipFor(engine) }, () => {
    it('put() after a pending remove() is a replacement: the removal is cleared and the save updates the row', () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'c', v: 1 });
        const c = await items.get('c');
        items.remove('c');
        assert.throws(() => items.add({ id: 'c', v: 2 }), { code: 'JD2003' }, 'add() still refuses a pending removal');
        assert.deepStrictEqual(items.put({ ...c, v: 5 }), { id: 'c', v: 5 });
        assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 0 });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 1, deleted: 0 });
        assert.deepStrictEqual(await items.get('c'), { id: 'c', v: 5 });
      }));

    it('a remove() after that put() is the last word again: the row is deleted', () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'c', v: 1 });
        const c = await items.get('c');
        items.remove('c');
        items.put({ ...c, v: 5 });
        items.remove('c');
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 1 });
        assert.strictEqual(await items.get('c'), undefined);
      }));

    it('a removal saved in a rolled-back transaction comes back beside the add() staged after it, and the next save deletes then inserts', () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'd', v: 1 });
        await items.get('d');
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Item').remove('d');
          await tx.saveChanges();
          tx.entity('Item').add({ id: 'd', v: 2 });
          throw new Error('undo');
        }), /undo/);
        assert.deepStrictEqual(pending(store), { pendingInserts: 1, pendingDeletes: 1 });
        assert.deepStrictEqual(await items.asNoTracking().get('d'), { id: 'd', v: 1 }, 'the rollback kept the row');
        const report = await store.saveChanges();
        assert.deepStrictEqual(counted(report), { inserted: 1, updated: 0, deleted: 1 });
        assert.deepStrictEqual(report.statements.map((/** @type {any} */ s) => s.sql.split(' ')[0]), ['DELETE', 'INSERT']);
        assert.deepStrictEqual(await items.get('d'), { id: 'd', v: 2 });
        assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 0 });
      }));

    it('the same holds for a removal of a key never read, and for a versioned entity whose delete is guarded', () =>
      withStore(engine, MODEL, async (store) => {
        await store.entity('Item').create({ id: 'u', v: 1 });
        await store.entity('Note').create({ id: 'n', v: 1 });
        await store.entity('Note').get('n');
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Item').remove('u');
          tx.entity('Note').remove('n');
          await tx.saveChanges();
          tx.entity('Item').add({ id: 'u', v: 2 });
          tx.entity('Note').add({ id: 'n', v: 2 });
          throw new Error('undo');
        }), /undo/);
        const report = await store.saveChanges();
        assert.deepStrictEqual(counted(report), { inserted: 2, updated: 0, deleted: 2 });
        assert.deepStrictEqual(await store.entity('Item').get('u'), { id: 'u', v: 2 });
        assert.deepStrictEqual(await store.entity('Note').get('n'), { id: 'n', v: 2, rev: 0 });
      }));

    it('a save of such a pair that rolls back again leaves the same pair, and the retry still runs it', () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'd', v: 1 });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Item').remove('d');
          await tx.saveChanges();
          tx.entity('Item').add({ id: 'd', v: 2 });
          throw new Error('undo');
        }), /undo/);
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          await tx.saveChanges();
          throw new Error('undo again');
        }), /undo again/);
        assert.deepStrictEqual(pending(store), { pendingInserts: 1, pendingDeletes: 1 });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 1, updated: 0, deleted: 1 });
        assert.deepStrictEqual(await items.get('d'), { id: 'd', v: 2 });
      }));

    it('a remove() staged after a save of that pair, then a rollback, is the last word: the next save deletes the row', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          const set = store.entity(name);
          await set.create({ id: 'd', v: 1 });
          await set.get('d');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity(name).remove('d');
            await tx.saveChanges();
            tx.entity(name).add({ id: 'd', v: 2 });
            throw new Error('undo');
          }), /undo/);
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            await tx.saveChanges();
            tx.entity(name).remove('d');
            throw new Error('undo again');
          }), /undo again/);
          assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 1 }, name);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 1 }, name);
          assert.strictEqual(await set.get('d'), undefined, name);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
        }
      }));

    it('an add() saved in a rolled-back transaction and removed after the save is cancelled with that removal, as remove() cancels a pending add', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          const set = store.entity(name);
          // the same words without a transaction
          set.add({ id: 'u', v: 1 });
          set.remove('u');
          assert.throws(() => set.put({ id: 'u', v: 2 }), { code: 'JD2006' }, name);
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity(name).add({ id: 'k', v: 1 });
            await tx.saveChanges();
            tx.entity(name).remove('k');
            throw new Error('undo');
          }), /undo/);
          assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 0 }, name);
          assert.throws(() => set.put({ id: 'k', v: 2 }), { code: 'JD2006' }, name);
          // a removal of the key the rollback left absent deletes nothing, guard or none
          set.remove('k');
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
          assert.strictEqual(await set.get('k'), undefined, name);
        }
      }));

    it('an allocated insert cancelled that way takes its staged memberships along', () =>
      withStore(engine, ALLOCATED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          const post = tx.entity('Post').add({ title: 'draft' });
          tx.entity('Post').link(post, 'tags', 'red');
          await tx.saveChanges();
          const [saved] = await tx.entity('Post').load({});
          tx.entity('Post').remove(saved.pid);
          throw new Error('undo');
        }), /undo/);
        const { pendingInserts, pendingDeletes, pendingMemberships } = store.stats().tracker;
        assert.deepStrictEqual({ pendingInserts, pendingDeletes, pendingMemberships },
          { pendingInserts: 0, pendingDeletes: 0, pendingMemberships: 0 });
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.deleted, report.joinInserted], [0, 0, 0]);
        assert.deepStrictEqual(await store.entity('Post').asNoTracking().load({}), []);
      }));

    it('remove() of a pending add cancels the link() and unlink() staged under its key — before the add or after it, by key or by document', () =>
      withStore(engine, ALLOCATED, async (store) => {
        const posts = store.entity('Post');
        await store.entity('Tag').create({ name: 'red' });
        await store.entity('Tag').create({ name: 'blue' });
        posts.add({ pid: 5, title: 'five' });
        posts.link(5, 'tags', 'red');
        posts.unlink(5, 'tags', 'blue');
        posts.remove(5);
        posts.link(6, 'tags', 'red');
        posts.add({ pid: 6, title: 'six' });
        posts.remove(6);
        const seven = posts.add({ pid: 7, title: 'seven' });
        posts.link(seven, 'tags', 'blue');
        posts.remove(seven);
        const { pendingInserts, pendingMemberships } = store.stats().tracker;
        assert.deepStrictEqual({ pendingInserts, pendingMemberships }, { pendingInserts: 0, pendingMemberships: 0 });
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.joinInserted, report.joinDeleted], [0, 0, 0]);
        assert.deepStrictEqual(await posts.asNoTracking().load({}), []);
        // a row that is saved keeps what is staged under its key
        await posts.create({ pid: 8, title: 'eight' });
        posts.link(8, 'tags', 'red');
        assert.strictEqual((await store.saveChanges()).joinInserted, 1);
      }));

    it('a rollback that cancels an insert that way drops the link()s staged under its key too — before the save or after it', () =>
      withStore(engine, ALLOCATED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await store.entity('Tag').create({ name: 'blue' });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Post').add({ pid: 5, title: 'five' });
          tx.entity('Post').link(5, 'tags', 'red');
          await tx.saveChanges();
          tx.entity('Post').link(5, 'tags', 'blue');
          tx.entity('Post').remove(5);
          throw new Error('undo');
        }), /undo/);
        const { pendingInserts, pendingDeletes, pendingMemberships } = store.stats().tracker;
        assert.deepStrictEqual({ pendingInserts, pendingDeletes, pendingMemberships },
          { pendingInserts: 0, pendingDeletes: 0, pendingMemberships: 0 });
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.deleted, report.joinInserted], [0, 0, 0]);
        assert.deepStrictEqual(await store.entity('Post').asNoTracking().load({}), []);
      }));

    it('and so does one whose key the save allocated, linked by that key after the save', () =>
      withStore(engine, ALLOCATED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Post').add({ title: 'draft' });
          await tx.saveChanges();
          const [saved] = await tx.entity('Post').load({});
          tx.entity('Post').link(saved.pid, 'tags', 'red');
          tx.entity('Post').remove(saved.pid);
          throw new Error('undo');
        }), /undo/);
        const { pendingInserts, pendingDeletes, pendingMemberships } = store.stats().tracker;
        assert.deepStrictEqual({ pendingInserts, pendingDeletes, pendingMemberships },
          { pendingInserts: 0, pendingDeletes: 0, pendingMemberships: 0 });
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.deleted, report.joinInserted], [0, 0, 0]);
        assert.deepStrictEqual(await store.entity('Post').asNoTracking().load({}), []);
      }));
  });

  describe(`a rolled-back save puts every word staged after it on the row it belongs to (${engine})`, { skip: skipFor(engine) }, () => {
    it('an update the save wrote is pending again when the row was read again or discarded after the save, with an edit made after it', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          const set = store.entity(name);
          for (const after of ['get', 'discard', 'get and put']) {
            const id = `${name} ${after}`;
            const made = await set.create({ id, v: 0 });
            set.put({ ...made, v: 1 });
            await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
              await tx.saveChanges();
              if (after === 'discard') tx.entity(name).discard(id);
              else {
                const read = await tx.entity(name).get(id);
                if (after === 'get and put') tx.entity(name).put({ ...read, v: 2 });
              }
              throw new Error('undo');
            }), /undo/);
            assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 1, deleted: 0 }, id);
            assert.strictEqual((await set.asNoTracking().get(id)).v, after === 'get and put' ? 2 : 1, id);
            assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, id);
          }
        }
      }));

    it('a remove() staged after the save is guarded by the version the row had before it, and deletes the row', () =>
      withStore(engine, MODEL, async (store) => {
        const notes = store.entity('Note');
        await notes.create({ id: 'n', v: 1 });
        const n = await notes.get('n');
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Note').put({ ...n, v: 2 });
          await tx.saveChanges();
          tx.entity('Note').remove('n');
          throw new Error('undo');
        }), /undo/);
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 1 });
        assert.strictEqual(await notes.get('n'), undefined);
      }));

    it('add(), a save, remove(), a save and add() again of one key, rolled back, leave only the last add()', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity(name).add({ id: 'k', v: 1 });
            await tx.saveChanges();
            tx.entity(name).remove('k');
            await tx.saveChanges();
            tx.entity(name).add({ id: 'k', v: 2 });
            throw new Error('undo');
          }), /undo/);
          assert.deepStrictEqual(pending(store), { pendingInserts: 1, pendingDeletes: 0 }, name);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 1, updated: 0, deleted: 0 }, name);
          assert.deepStrictEqual(await store.entity(name).asNoTracking().get('k'),
            name === 'Note' ? { id: 'k', v: 2, rev: 0 } : { id: 'k', v: 2 }, name);
        }
      }));

    it('an add() staged after the save over the key it wrote, then a remove(), rolled back, leaves nothing: the remove() cancels both', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity(name).add({ id: 'c', v: 2 });
            await tx.saveChanges();
            tx.entity(name).add({ id: 'c', v: 3 });
            tx.entity(name).remove('c');
            throw new Error('undo');
          }), /undo/);
          assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 0 }, name);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
          assert.strictEqual(await store.entity(name).asNoTracking().get('c'), undefined, name);
          // an update staged before the save, replaced by such an add, goes the same way
          const made = await store.entity(name).create({ id: 'u', v: 0 });
          store.entity(name).put({ ...made, v: 1 });
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            await tx.saveChanges();
            tx.entity(name).add({ id: 'u', v: 5 });
            tx.entity(name).remove('u');
            throw new Error('undo');
          }), /undo/);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
          assert.strictEqual((await store.entity(name).asNoTracking().get('u')).v, 0, name);
        }
      }));

    it('a link() or unlink() staged by the key the save allocated follows the row back to its pending insert', () =>
      withStore(engine, ALLOCATED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await store.entity('Tag').create({ name: 'blue' });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Post').add({ title: 'one', tags: ['blue', 'red'] });
          await tx.saveChanges();
          const [one] = await tx.entity('Post').load({});
          tx.entity('Post').link(one.pid, 'tags', 'red');
          tx.entity('Post').unlink(one.pid, 'tags', 'blue');
          tx.entity('Post').add({ title: 'two' });
          throw new Error('undo');
        }), /undo/);
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.joinInserted, report.joinDeleted], [2, 1, 0]);
        assert.deepStrictEqual(await postsOf(store), [['one', ['red']], ['two', []]]);
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
      }));

    it('an edit staged after the save carries no allocated key back, and the document add() returned still names the pending insert', () =>
      withStore(engine, ALLOCATED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        /** @type {any} */
        let added;
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          added = tx.entity('Post').add({ title: 'one' });
          await tx.saveChanges();
          const [one] = await tx.entity('Post').load({});
          tx.entity('Post').add({ title: 'two' });
          tx.entity('Post').put({ ...one, title: 'one, edited' });
          throw new Error('undo');
        }), /undo/);
        store.entity('Post').link(added, 'tags', 'red');
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.joinInserted], [2, 1]);
        assert.deepStrictEqual(await postsOf(store), [['one, edited', ['red']], ['two', []]]);
      }));

    it('a link() staged after the add() that follows a saved removal attaches to the added row, a target the removed row held included', () =>
      withStore(engine, LINKED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await store.entity('Tag').create({ name: 'blue' });
        await store.entity('Item').create({ id: 'p', v: 1, tags: ['red', 'blue'] });
        await store.entity('Item').get('p');
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Item').remove('p');
          await tx.saveChanges();
          tx.entity('Item').add({ id: 'p', v: 2 });
          tx.entity('Item').link('p', 'tags', 'red');
          throw new Error('undo');
        }), /undo/);
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.inserted, report.deleted, report.joinInserted], [1, 1, 1]);
        const [p] = await store.entity('Item').asNoTracking().load({ include: { tags: true } });
        assert.deepStrictEqual([p.v, p.tags.map((/** @type {any} */ tag) => tag.name)], [2, ['red']]);
      }));

    it('a link() of a member held and an unlink() of one not held are settled by the save that finds them so', () =>
      withStore(engine, LINKED, async (store) => {
        const items = store.entity('Item');
        await store.entity('Tag').create({ name: 'red' });
        await store.entity('Tag').create({ name: 'blue' });
        await items.create({ id: 'i', v: 1, tags: ['red'] });
        items.link('i', 'tags', 'red');
        items.unlink('i', 'tags', 'blue');
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        assert.strictEqual(store.stats().tracker.pendingMemberships, 0);
        // nothing is pending, so SQL the store did not plan may write (JD2041
        // refused it), and no later save writes the settled words again
        await store.transaction((/** @type {any} */ tx) => tx.sql.prepare('DELETE FROM "Item_Tag"', { access: 'write' }).run([]));
        const report = await store.saveChanges();
        assert.deepStrictEqual([report.joinInserted, report.joinDeleted], [0, 0]);
        const [i] = await items.asNoTracking().load({ include: { tags: true } });
        assert.deepStrictEqual(i.tags, []);
      }));

    it('a put() of a pending insert keeps the version add() started it at, so later tracked updates save', () =>
      withStore(engine, MODEL, async (store) => {
        const notes = store.entity('Note');
        notes.add({ id: 'c', v: 1 });
        assert.deepStrictEqual(notes.put({ id: 'c', v: 2 }), { id: 'c', v: 2, rev: 0 });
        await store.saveChanges();
        const c = await notes.get('c');
        assert.deepStrictEqual(c, { id: 'c', v: 2, rev: 0 });
        notes.put({ ...c, v: 3 });
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 1, deleted: 0 });
        assert.deepStrictEqual(await notes.asNoTracking().get('c'), { id: 'c', v: 3, rev: 1 });
      }));

    it('a put() staged after the save on the row it deleted, written again inside the transaction, replaces it: the removal is cancelled', () =>
      withStore(engine, MODEL, async (store) => {
        const notes = store.entity('Note');
        await notes.create({ id: 'b', v: 0 });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Note').remove('b');
          await tx.saveChanges();
          const made = await tx.entity('Note').create({ id: 'b', v: 2 });
          tx.entity('Note').put({ ...made, v: 3 });
          throw new Error('undo');
        }), /undo/);
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 1, deleted: 0 });
        assert.deepStrictEqual(await notes.asNoTracking().get('b'), { id: 'b', v: 3, rev: 1 });
        // where no row held the key, the put stays staged and the save meets the row's absence
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          tx.entity('Note').remove('c');
          await tx.saveChanges();
          const made = await tx.entity('Note').create({ id: 'c', v: 2 });
          tx.entity('Note').put({ ...made, v: 3 });
          throw new Error('undo');
        }), /undo/);
        await assert.rejects(store.saveChanges(), { code: 'JD2040' });
        notes.discard('c');
        assert.strictEqual(await notes.asNoTracking().get('c'), undefined);
      }));

    it('a link() staged on a row create() wrote inside a rolled-back transaction goes with the row', () =>
      withStore(engine, LINKED, async (store) => {
        await store.entity('Tag').create({ name: 'red' });
        await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
          await tx.entity('Item').create({ id: 'k', v: 1 });
          tx.entity('Item').link('k', 'tags', 'red');
          throw new Error('undo');
        }), /undo/);
        assert.strictEqual(store.stats().tracker.pendingMemberships, 0);
        assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
      }));

    it('a row create() wrote inside a rolled-back transaction is no longer tracked', () =>
      withStore(engine, MODEL, async (store) => {
        for (const name of ['Item', 'Note']) {
          /** @type {any} */
          let made;
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            made = await tx.entity(name).create({ id: 'c', v: 1 });
            throw new Error('undo');
          }), /undo/);
          assert.throws(() => store.entity(name).put({ ...made, v: 2 }), { code: 'JD2006' }, name);
          store.entity(name).remove('c');
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 }, name);
        }
      }));
  });

  for (const onDelete of ['restrict', 'cascade', 'setNull']) {
    describe(`a delete run ahead of its re-insert takes the removals of the rows that reference it along (${onDelete}, ${engine})`, { skip: skipFor(engine) }, () => {
      it('a parent removed with its children, saved, added back and rolled back saves as staged', () =>
        withStore(engine, FAMILY(onDelete), async (store) => {
          const parents = store.entity('Parent');
          const kids = store.entity('Kid');
          await parents.create({ id: 'p', v: 1 });
          await parents.create({ id: 'q', v: 1 });
          await kids.create({ id: 'k', parentId: 'p' });
          await kids.create({ id: 'k9', parentId: 'q' });
          await kids.create({ id: 'k7', parentId: 'p' });
          await parents.get('p');
          await kids.get('k');
          await kids.get('k9');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            // 'k7' is removed by key, never read
            for (const key of ['k', 'k9', 'k7']) tx.entity('Kid').remove(key);
            tx.entity('Parent').remove('p');
            await tx.saveChanges();
            tx.entity('Parent').add({ id: 'p', v: 2 });
            throw new Error('undo');
          }), /undo/);
          assert.deepStrictEqual(pending(store), { pendingInserts: 1, pendingDeletes: 4 });
          const report = await store.saveChanges();
          assert.deepStrictEqual(counted(report), { inserted: 1, updated: 0, deleted: 4 });
          // a set-null reference does not stand in the way of the delete ahead, so
          // those removals keep their place; the others run ahead, child-first —
          // and 'k9', whose parent stays, keeps its place either way
          assert.deepStrictEqual(report.statements.map(statementOf), onDelete === 'setNull'
            ? ['DELETE Parent', 'INSERT Parent', 'DELETE Kid', 'DELETE Kid', 'DELETE Kid']
            : ['DELETE Kid', 'DELETE Kid', 'DELETE Parent', 'INSERT Parent', 'DELETE Kid']);
          assert.deepStrictEqual(await parents.get('p'), { id: 'p', v: 2 });
          assert.deepStrictEqual(await kids.asNoTracking().load({}), []);
          assert.deepStrictEqual(pending(store), { pendingInserts: 0, pendingDeletes: 0 });
        }));

      it('a child moved to a parent that stays, or edited under the removed one, saves as the straight delete would', () =>
        withStore(engine, FAMILY(onDelete), async (store) => {
          const parents = store.entity('Parent');
          const kids = store.entity('Kid');
          await parents.create({ id: 'p', v: 1 });
          await parents.create({ id: 'q', v: 1 });
          await kids.create({ id: 'moved', parentId: 'p' });
          // a restricting reference refuses the delete of a parent a child stays under
          if (onDelete !== 'restrict') await kids.create({ id: 'edited', parentId: 'p' });
          await parents.get('p');
          const moved = await kids.get('moved');
          const edited = onDelete === 'restrict' ? null : await kids.get('edited');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity('Kid').put({ ...moved, parentId: 'q' });
            if (edited !== null) tx.entity('Kid').put({ ...edited, v: 2 });
            tx.entity('Parent').remove('p');
            await tx.saveChanges();
            tx.entity('Parent').add({ id: 'p', v: 2 });
            throw new Error('undo');
          }), /undo/);
          const report = await store.saveChanges();
          assert.deepStrictEqual(counted(report), { inserted: 1, updated: onDelete === 'restrict' ? 1 : 2, deleted: 1 });
          assert.deepStrictEqual(await parents.get('p'), { id: 'p', v: 2 });
          const left = (await kids.asNoTracking().load({}))
            .map((/** @type {any} */ kid) => [kid.id, kid.parentId ?? null, kid.v ?? null, kid.rev]).sort();
          // the cascade takes the edited child along; set-null keeps it, unparented
          assert.deepStrictEqual(left, onDelete === 'setNull'
            ? [['edited', null, 2, 1], ['moved', 'q', null, 1]] : [['moved', 'q', null, 1]]);
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        }));

      it('a child the tracker holds nothing for is taken along by its entity alone', () =>
        withStore(engine, FAMILY(onDelete), async (store) => {
          const parents = store.entity('Parent');
          const kids = store.entity('Kid');
          await parents.create({ id: 'p', v: 1 });
          await kids.create({ id: 'k', parentId: 'p' });
          // create() tracks the row it wrote; after discard() its removal
          // carries no snapshot to read the reference from
          kids.discard('k');
          await parents.get('p');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity('Kid').remove('k');
            tx.entity('Parent').remove('p');
            await tx.saveChanges();
            tx.entity('Parent').add({ id: 'p', v: 2 });
            throw new Error('undo');
          }), /undo/);
          const report = await store.saveChanges();
          assert.deepStrictEqual(counted(report), { inserted: 1, updated: 0, deleted: 2 });
          assert.deepStrictEqual(report.statements.map(statementOf), onDelete === 'setNull'
            ? ['DELETE Parent', 'INSERT Parent', 'DELETE Kid']
            : ['DELETE Kid', 'DELETE Parent', 'INSERT Parent']);
          assert.deepStrictEqual(await parents.get('p'), { id: 'p', v: 2 });
          assert.deepStrictEqual(await kids.asNoTracking().load({}), []);
        }));
    });
  }

  for (const onDelete of ['cascade', 'setNull']) {
    describe(`a child moved to a parent the save inserts, while the one it leaves is deleted ahead (${onDelete}, ${engine})`, { skip: skipFor(engine) }, () => {
      it('moved between two parents both deleted ahead and added back: it lands on the one added back', () =>
        withStore(engine, LINEAGE(onDelete), async (store) => {
          await store.entity('Parent').create({ id: 'p', v: 1 });
          await store.entity('Parent').create({ id: 'q', v: 1 });
          await store.entity('Kid').create({ id: 'k', parentId: 'p', v: 1 });
          await store.entity('Pup').create({ id: 'u', kidId: 'k' });
          await store.entity('Parent').get('p');
          await store.entity('Parent').get('q');
          const k = await store.entity('Kid').get('k');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity('Parent').remove('p');
            tx.entity('Parent').remove('q');
            await tx.saveChanges();
            tx.entity('Parent').add({ id: 'p', v: 2 });
            tx.entity('Parent').add({ id: 'q', v: 2 });
            throw new Error('undo');
          }), /undo/);
          store.entity('Kid').put({ ...k, parentId: 'q' });
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 2, updated: 1, deleted: 2 });
          assert.deepStrictEqual(await lineageOf(store), { Parent: ['p:2', 'q:2'], Kid: ['k→q:1'], Pup: ['u→k'] });
        }));

      it('moved to a parent added in the same save: it lands there, and the parent it left is added back', () =>
        withStore(engine, LINEAGE(onDelete), async (store) => {
          await store.entity('Parent').create({ id: 'p', v: 1 });
          await store.entity('Kid').create({ id: 'k', parentId: 'p', v: 1 });
          await store.entity('Parent').get('p');
          const k = await store.entity('Kid').get('k');
          await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
            tx.entity('Parent').remove('p');
            await tx.saveChanges();
            tx.entity('Parent').add({ id: 'p', v: 2 });
            throw new Error('undo');
          }), /undo/);
          store.entity('Parent').add({ id: 'n', v: 1 });
          store.entity('Kid').put({ ...k, parentId: 'n' });
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 2, updated: 1, deleted: 1 });
          assert.deepStrictEqual(await lineageOf(store), { Parent: ['n:1', 'p:2'], Kid: ['k→n:1'], Pup: [] });
          assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 0, updated: 0, deleted: 0 });
        }));
    });
  }

  for (const onDelete of ['restrict', 'cascade']) {
    describe(`a parent removed under a decimal spelling of its key takes its children's removals ahead along (${onDelete}, ${engine})`, { skip: skipFor(engine) }, () => {
      for (const spelling of [' 16', '16.0']) {
        it(JSON.stringify(spelling), () =>
          withStore(engine, NUMBERED(onDelete), async (store) => {
            await store.entity('Parent').create({ id: 16, v: 1 });
            await store.entity('Kid').create({ id: 'k', parentId: 16 });
            await store.entity('Parent').get(16);
            await store.entity('Kid').get('k');
            await assert.rejects(store.transaction(async (/** @type {any} */ tx) => {
              tx.entity('Kid').remove('k');
              tx.entity('Parent').remove(spelling);
              await tx.saveChanges();
              tx.entity('Parent').add({ id: 16, v: 2 });
              throw new Error('undo');
            }), /undo/);
            assert.deepStrictEqual(counted(await store.saveChanges()), { inserted: 1, updated: 0, deleted: 2 });
            assert.deepStrictEqual(await store.entity('Parent').asNoTracking().load({}), [{ id: 16, v: 2 }]);
            assert.deepStrictEqual(await store.entity('Kid').asNoTracking().load({}), []);
          }));
      }
    });
  }

  describe(`a save of tens of thousands of staged rows runs its statements one after another (${engine})`, { skip: skipFor(engine) }, () => {
    const count = 20000;
    /** Run a save and bound its time, generously. @param {any} store @param {string} what */
    const bounded = async (store, what) => {
      const started = performance.now();
      const report = await store.saveChanges();
      const took = performance.now() - started;
      assert.ok(took < 120000, `${what} took ${Math.round(took)} ms`);
      return report;
    };
    it(`${count} updates in one save, then ${count} removals`, () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        for (let i = 0; i < count; i++) items.add({ id: `i${i}`, v: 0 });
        assert.strictEqual((await store.saveChanges()).inserted, count);
        for (const item of await items.load({})) items.put({ ...item, v: 1 });
        assert.strictEqual((await bounded(store, 'the updates')).updated, count);
        for (let i = 0; i < count; i++) items.remove(`i${i}`);
        assert.strictEqual((await bounded(store, 'the removals')).deleted, count);
        assert.deepStrictEqual(await items.asNoTracking().load({}), []);
      }));

    // PostgreSQL pays a round trip per link, so its half is shorter: the
    // statements still run one after another, which is what is under test
    const links = engine === 'postgres' ? 2000 : count;
    it(`${links} link() changes in one save, each read against the join table`, () =>
      withStore(engine, LINKED, async (store) => {
        const items = store.entity('Item');
        await store.entity('Tag').create({ name: 'red' });
        for (let i = 0; i < links; i++) items.add({ id: `i${i}`, v: 0 });
        await store.saveChanges();
        for (let i = 0; i < links; i++) items.link(`i${i}`, 'tags', 'red');
        assert.strictEqual((await bounded(store, 'the links')).joinInserted, links);
      }));
  });

  describe(`a duplicate key met by saveChanges() is JD2001 (${engine})`, { skip: skipFor(engine) }, () => {
    it('as create() and a collection insert meet it, naming the key, and the failed save leaves the tracker as it was', () =>
      withStore(engine, { ...MODEL, collections: { c: { schema: { type: 'object' }, key: '/id' } } }, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'a', v: 1 });
        await assert.rejects(items.create({ id: 'a', v: 2 }), { code: 'JD2001', class: 'duplicate' });
        await store.collection('c').insert({ id: 'x' });
        await assert.rejects(store.collection('c').insert({ id: 'x' }), { code: 'JD2001' });
        items.add({ id: 'a', v: 3 });
        await assert.rejects(store.saveChanges(), (/** @type {any} */ error) => error.code === 'JD2001'
          && error.class === 'duplicate' && error.key === 'a' && error.collection === 'Item'
          && /a 'Item' already exists under key "a"/.test(error.message));
        assert.deepStrictEqual(pending(store), { pendingInserts: 1, pendingDeletes: 0 });
        assert.deepStrictEqual(await items.get('a'), { id: 'a', v: 1 });
      }));

    it('a batched insert names every key it carried', () =>
      withStore(engine, MODEL, async (store) => {
        const items = store.entity('Item');
        await items.create({ id: 'b', v: 1 });
        items.add({ id: 'a', v: 1 });
        items.add({ id: 'b', v: 2 });
        // in the statement's row order: 'b' was tracked (by create) before 'a' was staged
        await assert.rejects(store.saveChanges(), (/** @type {any} */ error) => error.code === 'JD2001'
          && error.key === undefined && /a 'Item' already exists under one of the keys "b", "a"/.test(error.message));
        assert.strictEqual(await items.get('a'), undefined, 'the batch rolled back whole');
      }));
  });
}

describe('the tracker source spells its separator', () => {
  it('as an escape, never as a raw control byte', () => {
    const bytes = readFileSync(new URL('../../packages/db/src/tracker.js', import.meta.url));
    const control = [...bytes].flatMap((byte, at) => (byte < 9 || byte === 11 || byte === 12 || (byte >= 14 && byte < 32) ? [at] : []));
    assert.deepStrictEqual(control, []);
    const declaration = /const UNIT_SEPARATOR = '([^']*)';/.exec(bytes.toString('utf8'));
    assert.strictEqual(declaration?.[1], '\\x1f');
    assert.strictEqual(JSON.parse(`"${declaration[1].replace('\\x', '\\u00')}"`), String.fromCharCode(0x1f));
  });
});
