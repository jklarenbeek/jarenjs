//@ts-check
/**
 * @file Cache identity is STRUCTURAL, never a fingerprint.
 *
 * Every cache in this package that decides a result — the collection
 * plan, the entity plan, the entity load specification, and the
 * registered deterministic UDF — is keyed by the whole serialized
 * discriminating tuple. The documents below are the reason: they differ
 * only in a return literal and share a 32-bit `contentKey`. While that
 * hash was the identity, running the first and then the second returned
 * the FIRST document's rows, reported a cache hit, and nothing anywhere
 * said so.
 *
 * The invariant each case pins: query order never changes the answer.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { contentKey } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';
import { openStore, deterministicFragment, registerFragment } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/** Two collection documents that collide under the fingerprint. */
const COLLIDING = [
  { $for: { it: '$[*]' }, $return: '5ln9p' },
  { $for: { it: '$[*]' }, $return: 'nbe0a' },
];

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id'],
      },
      key: '/id',
      indexes: [],
    },
  },
};

const ENTITY_MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          tag: { type: 'string' },
        },
      },
    },
  },
};

describe('the fingerprint collision these caches must survive', () => {
  it('the two documents really do share a contentKey', () => {
    assert.strictEqual(contentKey(COLLIDING[0]), contentKey(COLLIDING[1]),
      'the fixture is only meaningful while the fingerprints collide');
  });

  it('a collection query answers its OWN document, in either order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const store = await openStore(MODEL, { driver: nodeDriver() });
      const users = store.collection('users');
      await users.insert({ id: 'u1', name: 'a' });
      const first = await Promise.resolve(users.execute(COLLIDING[order[0]]));
      const second = await Promise.resolve(users.execute(COLLIDING[order[1]]));
      assert.strictEqual(first, COLLIDING[order[0]].$return);
      assert.strictEqual(second, COLLIDING[order[1]].$return,
        'the second document must not be served the first one\'s plan');
      // two documents, two entries, no hit between them
      assert.strictEqual(store.stats().statementCache.hits, 0);
      assert.strictEqual(store.stats().statementCache.misses, 2);
      await store.close();
    }
  });

  it('an identical document DOES reuse its entry (the cache still works)', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver() });
    const users = store.collection('users');
    await users.insert({ id: 'u1', name: 'a' });
    await Promise.resolve(users.execute(COLLIDING[0]));
    // a fresh object, structurally equal, and with the keys reordered
    await Promise.resolve(users.execute({ $return: '5ln9p', $for: { it: '$[*]' } }));
    assert.strictEqual(store.stats().statementCache.hits, 1);
    await store.close();
  });

  it('an entity query answers its own document, in either order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
      await store.entity('User').create({ id: 'u1', name: 'a', tag: 't' });
      const docs = COLLIDING.map((d) => ({
        $for: { u: '$.User[*]' }, $return: d.$return,
      }));
      const first = await Promise.resolve(store.execute(docs[order[0]]));
      const second = await Promise.resolve(store.execute(docs[order[1]]));
      assert.strictEqual(first, docs[order[0]].$return);
      assert.strictEqual(second, docs[order[1]].$return);
      await store.close();
    }
  });

  it('an entity LOAD specification is keyed structurally too', async () => {
    const store = await openStore(ENTITY_MODEL, { driver: nodeDriver() });
    const users = store.entity('User');
    await users.create({ id: 'u1', name: 'a', tag: 't' });
    await users.create({ id: 'u2', name: 'b', tag: 't' });
    const one = await users.load({ take: 1 });
    const two = await users.load({ take: 2 });
    assert.strictEqual(one.length, 1);
    assert.strictEqual(two.length, 2, 'take:2 must not reuse take:1\'s statement');
    await store.close();
  });

  it('two colliding UDF fragments get two functions, not one', () => {
    // `deterministicFragment` keys on the fragment's identity; the SQL
    // name is a short fingerprint, so a clash there must be suffixed
    const a = deterministicFragment({ $eq: ['$it.name', COLLIDING[0].$return] });
    const b = deterministicFragment({ $eq: ['$it.name', COLLIDING[1].$return] });
    assert.ok(a !== null && b !== null);
    assert.notStrictEqual(a.key, b.key, 'two fragments, two identities');

    /** @type {Map<string, string>} */
    const registered = new Map();
    /** @type {Array<[string, Function]>} */
    const installed = [];
    const connection = {
      registerFunction: (/** @type {string} */ name, _o, /** @type {Function} */ fn) => {
        installed.push([name, fn]);
      },
    };
    const nameA = registerFragment(connection, registered, a);
    const nameB = registerFragment(connection, registered, b);
    assert.notStrictEqual(nameA, nameB, 'two fragments never share one SQL function');
    assert.strictEqual(installed.length, 2);
    // the same fragment twice still registers once
    assert.strictEqual(registerFragment(connection, registered, a), nameA);
    assert.strictEqual(installed.length, 2);
    // and each function really tests its own literal
    const [[, fnA], [, fnB]] = installed;
    assert.strictEqual(fnA(JSON.stringify({ name: COLLIDING[0].$return })), 1);
    assert.strictEqual(fnA(JSON.stringify({ name: COLLIDING[1].$return })), 0);
    assert.strictEqual(fnB(JSON.stringify({ name: COLLIDING[1].$return })), 1);
  });

  it('a fingerprint clash on the SQL NAME is suffixed, not shared', () => {
    /** @type {string[]} */
    const names = [];
    const connection = { registerFunction: (/** @type {string} */ n) => { names.push(n); } };
    const fragment = { key: 'the-real-identity', name: 'ignored', compile: () => () => 1 };
    // a DIFFERENT identity already owns the name this one fingerprints to
    const stem = `jaren_p_${hashContent(fragment.key)}`;
    /** @type {Map<string, string>} */
    const registered = new Map([['some-other-identity', stem]]);

    const name = registerFragment(connection, registered, fragment);
    assert.notStrictEqual(name, stem, 'the occupied name is never reused');
    assert.strictEqual(name, `${stem}_2`);
    assert.deepStrictEqual(names, [name]);
    // and it is now this identity's name, stably
    assert.strictEqual(registerFragment(connection, registered, fragment), name);
    assert.strictEqual(names.length, 1);
  });
});
