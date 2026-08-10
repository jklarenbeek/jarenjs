//@ts-check
/**
 * @file The store: model normalization (`JD0005` with docPaths), the
 * same operation suite over all three drivers (node, the Bun adapter,
 * an all-async injected wasm handle), the synchronous fast path's
 * presence rule, identity strategies, file-backed defaults with the
 * verify-never-alter reopen (`JD0002`), and savepoint-nested
 * transactions.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fromBunModule } from '@jarenjs/db/bun';
import { wasmDriver } from '@jarenjs/db/wasm';

import { BunShapedDatabase, asyncWasmHandle, tempDbPath } from './helpers.js';

const USERS_MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          age: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      key: '/id',
      indexes: [
        { name: 'by_email', path: '$.email', unique: true },
        { name: 'by_age', path: '$.age' },
      ],
    },
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
    notes: { schema: { type: 'object' }, key: null, identity: 'uuid' },
  },
};

const bunAdapterDriver = () => ({
  name: 'bun-adapter',
  dialect: sqliteDialect,
  open: (path) => fromBunModule({ Database: BunShapedDatabase }, path),
});

describe('normalizeModel (JD0005 with docPaths)', () => {
  const reject = (model, docPath) => {
    assert.throws(() => normalizeModel(model), (error) => {
      assert.strictEqual(error.code, 'JD0005');
      assert.strictEqual(error.docPath, docPath);
      return true;
    });
  };

  it('rejects each malformed member, pointing at it', () => {
    reject(null, '');
    reject({ collections: {} }, '/$model');
    reject({ $model: '0.2', collections: {} }, '/$model');
    reject({ $model: '0.1' }, '/collections');
    reject({ $model: '0.1', collections: {} }, '/collections');
    reject({ $model: '0.1', collections: { 'bad name': { schema: {} } } }, '/collections');
    reject({ $model: '0.1', collections: { u: null } }, '/collections/u');
    reject({ $model: '0.1', collections: { u: { schema: [] } } }, '/collections/u/schema');
    reject({ $model: '0.1', collections: { u: { schema: {} } } }, '/collections/u/identity');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: null, identity: 'guess' } } },
      '/collections/u/identity');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', identity: 'uuid' } } },
      '/collections/u/identity');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: 7 } } }, '/collections/u/key');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: 'no-slash' } } },
      '/collections/u/key');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '' } } }, '/collections/u/key');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', indexes: {} } } },
      '/collections/u/indexes');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', indexes: [null] } } },
      '/collections/u/indexes/0');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', indexes: [{ name: '9x', path: '$.a' }] } } },
      '/collections/u/indexes/0/name');
    reject({
      $model: '0.1',
      collections: { u: { schema: {}, key: '/id', indexes: [
        { name: 'a', path: '$.a' }, { name: 'a', path: '$.b' }] } },
    }, '/collections/u/indexes/1/name');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', indexes: [{ name: 'a', path: [] }] } } },
      '/collections/u/indexes/0/path');
    reject({ $model: '0.1', collections: { u: { schema: {}, key: '/id', indexes: [{ name: 'a', path: 9 }] } } },
      '/collections/u/indexes/0/path');
  });

  it('accepts the reference model, normalizing identity per strategy', () => {
    const collections = normalizeModel(USERS_MODEL);
    assert.deepStrictEqual([...collections.keys()], ['users', 'events', 'notes']);
    assert.strictEqual(collections.get('users').identity, 'caller');
    assert.strictEqual(collections.get('events').identity, 'integer');
    assert.strictEqual(collections.get('notes').identity, 'uuid');
  });

  it('JD0004: a non-singular index path is rejected at open, naming it', async () => {
    const model = {
      $model: '0.1',
      collections: { u: { schema: {}, key: '/id', indexes: [{ name: 'bad', path: '$.tags[*]' }] } },
    };
    await assert.rejects(() => openStore(model, { driver: nodeDriver() }), (error) => {
      assert.strictEqual(error.code, 'JD0004');
      assert.match(error.message, /\$\.tags\[\*\]/);
      assert.strictEqual(error.docPath, '/collections/u/indexes/0/path');
      return true;
    });
  });

  it('API misuse is a TypeError, not a coded document error', async () => {
    assert.throws(() => openStore(USERS_MODEL, /** @type {any} */ ({})), TypeError);
    assert.throws(
      () => openStore(USERS_MODEL, { driver: nodeDriver(), compileSchema: /** @type {any} */ (7) }),
      TypeError);
    await assert.rejects(
      () => openStore(USERS_MODEL,
        { driver: nodeDriver(), compileSchema: () => /** @type {any} */ (7) })
        .then((store) => store.collection('users')),
      TypeError);
  });
});

describe('one operation suite, three drivers', () => {
  const drivers = [
    ['node', () => nodeDriver(), true],
    ['bun-adapter', bunAdapterDriver, true],
    ['wasm (all-async fake)', () => wasmDriver(asyncWasmHandle()), false],
  ];

  for (const [name, makeDriver, synchronous] of drivers) {
    it(`${name}: insert/get/patch/delete/transaction agree`, async () => {
      const store = await openStore(USERS_MODEL, { driver: makeDriver() });
      const users = store.collection('users');

      assert.strictEqual(await users.insert({ id: 'u1', email: 'a@b.c', age: 30, tags: [] }), 'u1');
      assert.deepStrictEqual(await users.get('u1'),
        { id: 'u1', email: 'a@b.c', age: 30, tags: [] });
      assert.strictEqual(await users.get('missing'), undefined);

      const patched = await users.patch('u1', [{ op: 'replace', path: '/age', value: 31 }]);
      assert.strictEqual(patched.age, 31);
      assert.strictEqual((await users.get('u1')).age, 31);

      await users.put({ id: 'u1', email: 'a@b.c', age: 32, tags: ['x'] });
      assert.strictEqual((await users.get('u1')).age, 32);

      const returned = await store.transaction(async (s) => {
        await s.collection('users').put({ id: 'u2', email: 'c@d.e' });
        return 'through';
      });
      assert.strictEqual(returned, 'through');
      await assert.rejects(() => store.transaction(async (s) => {
        await s.collection('users').put({ id: 'u3', email: 'x@y.z' });
        throw new Error('boom');
      }), /boom/);
      assert.notStrictEqual(await users.get('u2'), undefined, 'committed level survived');
      assert.strictEqual(await users.get('u3'), undefined, 'thrown level rolled back');

      assert.strictEqual(await users.delete('u2'), true);
      assert.strictEqual(await users.delete('u2'), false);

      // the sync fast path exists exactly where the driver is synchronous
      if (synchronous) {
        assert.notStrictEqual(store.sync, undefined);
      }
      else {
        assert.strictEqual(store.sync, undefined,
          'an asynchronous driver must NOT carry sync stubs');
      }
      await store.close();
    });
  }

  it('JD2004: an undeclared collection', async () => {
    const store = await openStore(USERS_MODEL, { driver: nodeDriver() });
    assert.throws(() => store.collection('nope'), (error) => {
      assert.strictEqual(error.code, 'JD2004');
      assert.strictEqual(error.collection, 'nope');
      return true;
    });
    await store.close();
  });
});

describe('identity strategies (D11)', () => {
  it('uuid and integer allocation, and put() against allocated keys', async () => {
    const store = await openStore(USERS_MODEL, { driver: nodeDriver() });
    const events = store.collection('events');
    const first = await events.insert({ what: 'boot' });
    const second = await events.insert({ what: 'tick' });
    assert.strictEqual(typeof first, 'number');
    assert.strictEqual(second, first + 1);
    await events.put({ what: 'boot-edited' }, first);
    assert.deepStrictEqual(await events.get(first), { what: 'boot-edited' });
    const allocated = await events.put({ what: 'fresh' });
    assert.strictEqual(typeof allocated, 'number');

    const notes = store.collection('notes');
    const noteKey = await notes.insert({ text: 'hi' });
    assert.match(String(noteKey), /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(await notes.get(noteKey), { text: 'hi' });
    await store.close();
  });

  it('JD2002: a missing or non-scalar caller key, and non-key arguments', async () => {
    const store = await openStore(USERS_MODEL, { driver: nodeDriver() });
    const users = store.collection('users');
    await assert.rejects(() => users.insert({ email: 'no-key@b.c' }), (error) => {
      assert.strictEqual(error.code, 'JD2002');
      assert.strictEqual(error.collection, 'users');
      assert.match(error.message, /'\/id'/);
      return true;
    });
    await assert.rejects(
      () => users.insert({ id: { nested: true }, email: 'x@b.c' }),
      (e) => e.code === 'JD2002');
    await assert.rejects(() => users.get(/** @type {any} */ (null)),
      (e) => e.code === 'JD2002');
    await assert.rejects(() => users.delete(/** @type {any} */ (undefined)),
      (e) => e.code === 'JD2002');
    await store.close();
  });
});

describe('file-backed stores: decided defaults and verify-never-alter', () => {
  it('busy/journal defaults are set, visible, and absent on :memory:', async () => {
    const memoryStore = await openStore(USERS_MODEL, { driver: nodeDriver() });
    assert.strictEqual(memoryStore.capabilities.busyTimeoutMs, null);
    assert.strictEqual(memoryStore.capabilities.journalMode, null);
    await memoryStore.close();

    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(USERS_MODEL, { driver: nodeDriver(), path: dbPath });
      assert.strictEqual(store.capabilities.busyTimeoutMs, 5000);
      assert.strictEqual(store.capabilities.journalMode, 'wal');
      assert.strictEqual(store.capabilities.validated, false);
      await store.collection('users').insert({ id: 'u1', email: 'a@b.c' });
      await store.close();

      // reopening with the SAME model verifies and reads the same data
      const reopened = await openStore(USERS_MODEL, { driver: nodeDriver(), path: dbPath });
      assert.deepStrictEqual(await reopened.collection('users').get('u1'),
        { id: 'u1', email: 'a@b.c' });
      await reopened.close();
    }
    finally {
      cleanup();
    }
  });

  it('JD0002: a disagreeing model refuses and alters nothing', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(USERS_MODEL, { driver: nodeDriver(), path: dbPath });
      await store.collection('users').insert({ id: 'u1', email: 'a@b.c' });
      await store.close();

      const changed = structuredClone(USERS_MODEL);
      changed.collections.users.indexes = [
        { name: 'by_email', path: '$.email' }, // uniqueness dropped
        { name: 'by_age', path: '$.age' },
      ];
      await assert.rejects(
        () => openStore(changed, { driver: nodeDriver(), path: dbPath }),
        (error) => {
          assert.strictEqual(error.code, 'JD0002');
          assert.match(error.message, /users/);
          assert.match(error.message, /migration/);
          assert.strictEqual(error.docPath, '/collections/users');
          return true;
        });

      const extraIndex = structuredClone(USERS_MODEL);
      extraIndex.collections.users.indexes.push({ name: 'by_tag0', path: '$.tags[0]' });
      await assert.rejects(
        () => openStore(extraIndex, { driver: nodeDriver(), path: dbPath }),
        (e) => e.code === 'JD0002');

      const extraColumn = structuredClone(USERS_MODEL);
      extraColumn.collections.users.schema.properties.age.type = 'number';
      await assert.rejects(
        () => openStore(extraColumn, { driver: nodeDriver(), path: dbPath }),
        (e) => e.code === 'JD0002');

      // nothing was altered: the original model still opens and reads
      const survivor = await openStore(USERS_MODEL, { driver: nodeDriver(), path: dbPath });
      assert.deepStrictEqual(await survivor.collection('users').get('u1'),
        { id: 'u1', email: 'a@b.c' });
      await survivor.close();
    }
    finally {
      cleanup();
    }
  });
});

describe('the synchronous fast path', () => {
  it('mirrors the asynchronous operations without the promise', async () => {
    const store = await openStore(USERS_MODEL, { driver: nodeDriver() });
    const users = store.sync.collection('users');
    assert.strictEqual(users.insert({ id: 'u1', email: 'a@b.c', age: 1 }), 'u1');
    assert.deepStrictEqual(users.get('u1'), { id: 'u1', email: 'a@b.c', age: 1 });
    users.put({ id: 'u1', email: 'a@b.c', age: 2 });
    assert.strictEqual(users.patch('u1', [{ op: 'replace', path: '/age', value: 3 }]).age, 3);
    assert.deepStrictEqual(users.stats(), { patchTranslated: 1, patchFallback: 0 });
    // the query surface, promise-free: the D2 provider and explain
    const hit = users.execute(
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u1'] }, $return: '$it.age' });
    assert.strictEqual(hit, 3);
    const explanation = users.explain(
      { $for: { it: '$[*]' }, $return: '$it' });
    assert.strictEqual(explanation.residual, null);
    assert.match(explanation.sql, /^SELECT/);
    const kept = store.sync.transaction(() => {
      users.put({ id: 'u2', email: 'c@d.e' });
      return 'sync-tx';
    });
    assert.strictEqual(kept, 'sync-tx');
    assert.strictEqual(users.delete('u2'), true);
    assert.strictEqual(users.delete('u2'), false);
    // the same collection through the async surface sees the same rows
    assert.strictEqual((await store.collection('users').get('u1')).age, 3);
    await store.close();
  });
});

describe('a refused open never keeps the handle', () => {
  /** A driver whose connection records whether it was closed. */
  const countingDriver = (onClose) => ({
    name: 'counting',
    dialect: nodeDriver().dialect,
    open: async (dbPath, options) => {
      const connection = await nodeDriver().open(dbPath, options);
      return Object.freeze({
        ...connection,
        exec: (sql) => connection.exec(sql),
        prepare: (sql) => connection.prepare(sql),
        transaction: (fn) => connection.transaction(fn),
        close: () => {
          onClose();
          return connection.close();
        },
      });
    },
  });

  const DISAGREEING = {
    $model: '0.1',
    collections: {
      notes: {
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        key: '/id',
        indexes: [{ name: 'by_missing', path: '$.absent' }],
      },
    },
  };
  const BASE = {
    $model: '0.1',
    collections: {
      notes: {
        schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        key: '/id',
        indexes: [],
      },
    },
  };

  it('a shape disagreement closes the connection it acquired', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openStore(BASE, { driver: nodeDriver(), path: dbPath });
      await first.close();
      let closes = 0;
      await assert.rejects(
        () => openStore(DISAGREEING, { driver: countingDriver(() => { closes += 1; }), path: dbPath }),
        (error) => /** @type {any} */ (error).code === 'JD0002');
      assert.strictEqual(closes, 1, 'closed exactly once, not zero and not twice');
    }
    finally {
      cleanup();   // would be EPERM on Windows if the handle had leaked
    }
  });

  it('a close that ALSO fails keeps the open failure primary', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openStore(BASE, { driver: nodeDriver(), path: dbPath });
      await first.close();
      const brokenClose = {
        name: 'broken-close',
        dialect: nodeDriver().dialect,
        open: async (path, options) => {
          const connection = await nodeDriver().open(path, options);
          return Object.freeze({
            ...connection,
            exec: (sql) => connection.exec(sql),
            prepare: (sql) => connection.prepare(sql),
            close: () => {
              connection.close();          // really release it
              throw new Error('close boom');
            },
          });
        },
      };
      await assert.rejects(
        () => openStore(DISAGREEING, { driver: brokenClose, path: dbPath }),
        (error) => {
          const aggregate = /** @type {any} */ (error);
          assert.ok(aggregate instanceof AggregateError);
          assert.strictEqual(aggregate.errors[0].code, 'JD0002',
            'the reason the open was refused stays first');
          assert.strictEqual(aggregate.errors[1].message, 'close boom');
          return true;
        });
    }
    finally {
      cleanup();
    }
  });
});
