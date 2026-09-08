//@ts-check
/**
 * @file The persisted document store + share codec (`@jarenjs/app`): a keyed
 * CRUD over an injected storage adapter, and the Unicode-safe base64url
 * share-link codec — the primitives the studio and play IDE surfaces build on.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDocStore, encodeShare, decodeShare } from '@jarenjs/app';

/** An in-memory storage adapter (the host injection), deep-copied on write. */
function memStorage(initial = null) {
  let data = initial;
  return {
    read: () => data,
    write: (store) => { data = JSON.parse(JSON.stringify(store)); },
    peek: () => data,
  };
}

describe('@jarenjs/app — createDocStore', () => {
  it('round-trips save / load / names / remove over injected storage', () => {
    const storage = memStorage();
    const store = createDocStore({ storage });
    assert.deepStrictEqual(store.names(), []);
    store.save('beta', { v: 2 });
    store.save('alpha', { v: 1 });
    assert.deepStrictEqual(store.names(), ['alpha', 'beta'], 'names come back sorted');
    assert.deepStrictEqual(store.load('alpha'), { v: 1 });
    assert.strictEqual(store.load('missing'), undefined);
    store.remove('alpha');
    assert.deepStrictEqual(store.names(), ['beta']);
    assert.deepStrictEqual(storage.peek().experiments, { beta: { v: 2 } }, 'persisted through storage');
  });

  it('reads an existing store and preserves sibling keys on write-back', () => {
    const storage = memStorage({ experiments: { seed: { v: 9 } }, other: 1 });
    const store = createDocStore({ storage });
    assert.deepStrictEqual(store.names(), ['seed']);
    store.save('fresh', { v: 0 });
    assert.strictEqual(storage.peek().other, 1, 'an unrelated key survives the write-back');
  });

  it('honours a custom collection key', () => {
    const storage = memStorage();
    const store = createDocStore({ storage, key: 'sessions' });
    store.save('s1', { a: 1 });
    assert.deepStrictEqual(Object.keys(storage.peek()), ['sessions']);
  });

  it('round-trips document names that also name prototype members', () => {
    const storage = memStorage();
    const store = createDocStore({ storage });
    const names = ['__proto__', 'constructor', 'toString'];
    for (const name of names) {
      assert.strictEqual(store.load(name), undefined);
      store.save(name, { name });
    }
    const reloaded = createDocStore({ storage });
    assert.deepStrictEqual(reloaded.names(), names);
    for (const name of names) {
      assert.deepStrictEqual(reloaded.load(name), { name });
      reloaded.remove(name);
      assert.strictEqual(reloaded.load(name), undefined);
    }
    assert.deepStrictEqual(reloaded.names(), []);
  });

  it('creates own collections for prototype-member keys and preserves them on reload', () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const storage = memStorage();
      const store = createDocStore({ storage, key });
      assert.strictEqual(Object.getPrototypeOf(store.all()), Object.prototype);
      assert.notStrictEqual(store.all(), Object.prototype);
      store.save('document', { v: 1 });
      assert.ok(Object.hasOwn(storage.peek(), key));
      assert.deepStrictEqual(createDocStore({ storage, key }).load('document'), { v: 1 });
    }
  });
});

describe('@jarenjs/app — the share codec', () => {
  it('round-trips a Unicode snapshot through a base64url token', () => {
    const snap = { e: 'path', i: { selector: '$..naïve', data: '{"π":3}' } };
    const token = encodeShare(snap);
    assert.ok(!/[+/=]/.test(token), 'base64url — no +, / or = in the token');
    assert.deepStrictEqual(decodeShare(token), snap);
  });

  it('decodes a corrupt or non-object token to null, never a throw', () => {
    assert.strictEqual(decodeShare('!!! not base64 !!!'), null);
    assert.strictEqual(decodeShare(encodeShare(42)), null, 'a non-object snapshot is rejected');
    assert.strictEqual(decodeShare(''), null);
  });
});
