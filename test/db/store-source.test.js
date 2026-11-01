//@ts-check
/**
 * @file Every collection and entity view of a store carries its own source
 * under `STORE_SOURCE`: the store's, a transaction's, the synchronous twin
 * at the root and inside a synchronous transaction: its kind, its name and
 * the database it reads (a file's canonical name; a shared-cache in-memory
 * database's name and VFS where this process holds it; a token of the
 * store's own for a private in-memory database). A chain built over a view reports
 * it, so a reader handed the chain can tell which rows its document names,
 * and of which database, without having built the view itself.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, STORE_SOURCE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { symlinkOrSkip } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: { schema: { type: 'object', properties: { id: { type: 'string' } } }, key: '/id' },
  },
  entities: {
    Row: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } } },
      },
    },
  },
};


/** @param {any} view - a store, or a store view a transaction received */
function sourcesOf(view) {
  return [view.collection('users')[STORE_SOURCE], view.entity('Row')[STORE_SOURCE]];
}

/**
 * Open a store into `opened`, which the test's `finally` closes: every store
 * a test opened is closed whichever later open refuses, since a worker or a
 * child process host left open keeps the test process alive.
 * @param {any[]} opened
 * @param {any} driver
 * @param {string} [path]
 */
async function openInto(opened, driver, path) {
  const store = await openStore(MODEL, path === undefined ? { driver } : { driver, path });
  opened.push(store);
  return store;
}

describe('a store view carries its own source', () => {
  it('on the store, a transaction, the synchronous twin and a synchronous transaction alike', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    try {
      assert.strictEqual(STORE_SOURCE, Symbol.for('@jarenjs/db/store-source'));
      const own = store.collection('users')[STORE_SOURCE].store;
      assert.strictEqual(typeof own, 'symbol');
      const expected = [{ kind: 'collection', name: 'users', store: own }, { kind: 'entity', name: 'Row', store: own }];
      assert.deepStrictEqual(sourcesOf(store), expected);
      assert.deepStrictEqual(sourcesOf(store.sync), expected);
      assert.deepStrictEqual(await store.transaction(async (/** @type {any} */ tx) => sourcesOf(tx)), expected);
      assert.deepStrictEqual(await store.transaction(async (/** @type {any} */ tx) => sourcesOf(tx.sync)), expected);
      assert.deepStrictEqual(store.sync.transaction((/** @type {any} */ tx) => sourcesOf(tx)), expected);
      assert.deepStrictEqual(await store.transaction(async (/** @type {any} */ tx) =>
        tx.transaction(async (/** @type {any} */ nested) => sourcesOf(nested))), expected);
      assert.ok(Object.isFrozen(store.collection('users')[STORE_SOURCE]));
      // a symbol, so a view's string members (and a hand-written provider's) are untouched
      assert.ok(!Object.keys(store.collection('users')).includes('name'));
    }
    finally { await store.close(); }
  });
});

describe('a store view names the database it reads', () => {
  it('two stores over one file are one source, through a symbolic link too; two files are two', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-store-source-'));
    const path = join(dir, 'one.sqlite');
    /** @type {any[]} */
    const opened = [];
    try {
      const first = await openInto(opened, nodeDriver(), path);
      const second = await openInto(opened, nodeDriver(), path);
      if (!symlinkOrSkip(t, path, join(dir, 'link.sqlite'))) return;
      const linked = await openInto(opened, nodeDriver(), join(dir, 'link.sqlite'));
      const other = await openInto(opened, nodeDriver(), join(dir, 'two.sqlite'));
      const [users, row] = sourcesOf(first);
      assert.strictEqual(users.store, `sqlite:${realpathSync(path)}`);
      assert.strictEqual(row.store, users.store);
      assert.deepStrictEqual(sourcesOf(second), [users, row]);
      assert.deepStrictEqual(sourcesOf(linked), [users, row]);
      assert.strictEqual(sourcesOf(other)[0].store, `sqlite:${realpathSync(join(dir, 'two.sqlite'))}`);
    }
    finally {
      for (const store of opened) await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a shared-cache in-memory database is named by its name and VFS, where this process holds it', async () => {
    const path = 'file:store-source-shared?mode=memory&cache=shared';
    // this platform's own VFS: SQLite has no `unix` on Windows, and no `win32` elsewhere
    const vfs = process.platform === 'win32' ? 'win32' : 'unix';
    /** @type {any[]} */
    const opened = [];
    try {
      const first = await openInto(opened, nodeDriver(), path);
      // the engine's own reading of the URI: parameters in any order, the path percent-decoded
      const reordered = await openInto(opened, nodeDriver(), 'file:store-source-%73hared?cache=shared&mode=memory');
      const worker = await openInto(opened, nodeWorkerDriver(), path);
      // a child process holds a database of its own under the same name
      const child = await openInto(opened, nodeProcessDriver(), path);
      const named = await openInto(opened, nodeDriver(), 'file::memory:?cache=shared');
      const withVfs = await openInto(opened, nodeDriver(), `${path}&vfs=${vfs}`);
      const other = await openInto(opened, nodeDriver(), 'file:store-source-other?mode=memory&cache=shared');
      const unshared = await openInto(opened, nodeDriver(), 'file:store-source-shared?mode=memory');
      // an empty or `localhost` authority names the same database: the path is the name
      const rooted = await openInto(opened, nodeDriver(), 'file:///store-source-root?mode=memory&cache=shared');
      const local = await openInto(opened, nodeDriver(), 'file://localhost/store-source-root?mode=memory&cache=shared');
      await first.collection('users').insert({ id: 'u1' });
      const [users, row] = sourcesOf(first);
      assert.strictEqual(users.store, 'sqlite-memory:[null,"store-source-shared"]');
      assert.strictEqual(row.store, users.store);
      for (const twin of [reordered, worker]) {
        assert.deepStrictEqual(await twin.collection('users').get('u1'), { id: 'u1' });
        assert.deepStrictEqual(sourcesOf(twin), [users, row]);
      }
      assert.strictEqual(await child.collection('users').get('u1'), undefined);
      assert.strictEqual(typeof sourcesOf(child)[0].store, 'symbol');
      assert.strictEqual(sourcesOf(named)[0].store, 'sqlite-memory:[null,":memory:"]');
      // the VFS is part of the name, so a spelling naming one stays a source of its own
      assert.strictEqual(sourcesOf(withVfs)[0].store, `sqlite-memory:["${vfs}","store-source-shared"]`);
      assert.strictEqual(sourcesOf(other)[0].store, 'sqlite-memory:[null,"store-source-other"]');
      assert.strictEqual(await unshared.collection('users').get('u1'), undefined);
      assert.strictEqual(typeof sourcesOf(unshared)[0].store, 'symbol');
      await rooted.collection('users').insert({ id: 'r1' });
      assert.deepStrictEqual(await local.collection('users').get('r1'), { id: 'r1' });
      assert.strictEqual(sourcesOf(rooted)[0].store, 'sqlite-memory:[null,"/store-source-root"]');
      assert.strictEqual(sourcesOf(local)[0].store, sourcesOf(rooted)[0].store);
    }
    finally {
      for (const store of opened) await store.close();
    }
  });

  it('a private in-memory database has no name a second store could share: a token of the store\'s own', async () => {
    /** @type {any[]} */
    const opened = [];
    try {
      const first = await openInto(opened, nodeDriver());
      const second = await openInto(opened, nodeDriver());
      const [users, row] = sourcesOf(first);
      assert.strictEqual(typeof users.store, 'symbol');
      assert.strictEqual(row.store, users.store);
      assert.notStrictEqual(sourcesOf(second)[0].store, users.store);
    }
    finally {
      for (const store of opened) await store.close();
    }
  });
});
