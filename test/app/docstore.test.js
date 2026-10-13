//@ts-check
/**
 * @file The persisted document store + share codec (`@jarenjs/app`): a keyed
 * CRUD over an injected storage adapter, and the compressed, Unicode-safe
 * base64url share-link codec — the primitives the studio and play IDE surfaces build on.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDocStore, encodeShare, decodeShare } from '@jarenjs/app';
import { compressBytes, MAX_EXPANDED_BYTES } from '../../packages/app/src/share-codec.js';

/** The compressed body of a text, for building tokens a snapshot never produces. */
const compressText = (text) => compressBytes(new TextEncoder().encode(text));

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

  it('shares persisted collections across stores using one adapter', () => {
    let raw = null;
    let reads = 0;
    const writes = [];
    const storage = {
      read() { reads++; return raw === null ? null : JSON.parse(raw); },
      write(value) { writes.push(value); raw = JSON.stringify(value); },
    };
    const experiments = createDocStore({ storage });
    const play = createDocStore({ storage, key: 'play' });
    experiments.save('project', { v: 1 });
    play.save('session', { v: 2 });
    assert.deepStrictEqual(JSON.parse(raw), {
      experiments: { project: { v: 1 } }, play: { session: { v: 2 } },
    });
    experiments.remove('project');
    play.save('second', { v: 3 });
    assert.deepStrictEqual(JSON.parse(raw), {
      experiments: {}, play: { session: { v: 2 }, second: { v: 3 } },
    });
    const reopened = createDocStore({ storage, key: 'play' });
    assert.strictEqual(reopened.all(), play.all());
    assert.deepStrictEqual(reopened.load('session'), { v: 2 });
    assert.strictEqual(reads, 1);
    assert.ok(writes.every((value) => value === writes[0]));
  });

  it('keeps shared collections in memory when the adapter cannot persist', () => {
    const storage = { read: () => null, write: () => {} };
    const experiments = createDocStore({ storage });
    experiments.save('project', { v: 1 });
    const play = createDocStore({ storage, key: 'play' });
    play.save('session', { v: 2 });
    assert.deepStrictEqual(createDocStore({ storage }).load('project'), { v: 1 });
    assert.deepStrictEqual(createDocStore({ storage, key: 'play' }).load('session'), { v: 2 });
    const other = { read: () => null, write: () => {} };
    assert.deepStrictEqual(createDocStore({ storage: other }).names(), []);
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

describe('@jarenjs/app — a persisted slot that is not a document store', () => {
  /** An adapter whose slot holds `raw` (JSON text) until the first write. */
  function slot(raw) {
    let written;
    return {
      read: () => JSON.parse(raw),
      write: (root) => { written = JSON.stringify(root); },
      get written() { return written; },
    };
  }

  it('starts empty and saves, for a root that is a number, a string, a boolean or a list', () => {
    for (const raw of ['5', '"x"', 'true', '[]', '[1,2]']) {
      const storage = slot(raw);
      const store = createDocStore({ storage });
      assert.deepStrictEqual(store.names(), [], raw);
      store.save('a', { v: 1 });
      assert.strictEqual(storage.written, '{"experiments":{"a":{"v":1}}}', raw);
    }
  });

  it('starts empty and saves, for a collection that is not an object', () => {
    for (const raw of ['5', '"abc"', 'true', '[]', '[1,2]']) {
      const storage = slot(`{"experiments":${raw},"play":{"keep":1}}`);
      const store = createDocStore({ storage });
      assert.deepStrictEqual(store.names(), [], raw);
      store.save('a', { v: 1 });
      assert.strictEqual(storage.written, '{"experiments":{"a":{"v":1}},"play":{"keep":1}}', raw);
    }
  });
});

describe('@jarenjs/app — the share codec', () => {
  /** What the release before the compressed format wrote for a snapshot. */
  const plainToken = (snapshot) => {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const file = (name) => ({ name, kind: 'app', text: '{\n  "state": {\n    "count": 0\n  }\n}' });
  const project = { e: 'project', i: { project: { files: [file('a.json'), file('b.json')] } } };
  const projectToken = '~1PYRBlgHSA4A5A3gajAYwOhAFhANKBmoqMEhgMzoDYMA5kALYYDcAwgNo5WoBclagzMhADWdZgGQQEajBkIuGAPCQICALjMAQWq4RaXa0Lom1Ws27gQqQAOrMvjtADCxbAPtjuE7mmTZyCADEen6CNoqOlJicNqCmlMy2ur7CDOMi0LrW3OAQ5Oq08Gb07gC671AC';

  it('round-trips a Unicode snapshot through a base64url token', () => {
    const snap = { e: 'path', i: { selector: '$..naïve', data: '{"π":3}' } };
    const token = encodeShare(snap);
    assert.match(token, /^[A-Za-z0-9_~-]+$/, 'base64url, plus the version prefix when compressed');
    assert.deepStrictEqual(decodeShare(token), snap);
  });

  it('writes a compressed token behind a ~1 prefix, shorter than the plain one', () => {
    const token = encodeShare(project);
    assert.strictEqual(token, projectToken);
    assert.strictEqual(plainToken(project).length, 282);
    assert.strictEqual(token.length, 198);
    assert.deepStrictEqual(decodeShare(token), project);
  });

  it('writes a token a link query carries unchanged', () => {
    const token = encodeShare(project);
    assert.ok(token.startsWith('~1'));
    assert.strictEqual(new URLSearchParams(`s=${token}`).get('s'), token);
    assert.strictEqual(decodeURIComponent(token), token);
    assert.strictEqual(encodeURIComponent(token), token);
  });

  it('compresses what a project of text files repeats, far below the plain token', () => {
    const doc = JSON.stringify({ state: { blob: 'x'.repeat(20000) } });
    const snap = { e: 'project', i: { project: { files: [{ name: 'a.json', kind: 'app', text: doc }] } } };
    assert.strictEqual(plainToken(snap).length, 26815);
    assert.strictEqual(encodeShare(snap).length, 399);
    assert.deepStrictEqual(decodeShare(encodeShare(snap)), snap);
  });

  it('writes the plain token when compressing would not make it shorter', () => {
    for (const snap of [{ a: 1 }, {}, [], { s: 'é' }]) {
      const token = encodeShare(snap);
      assert.strictEqual(token, plainToken(snap));
      assert.ok(!token.startsWith('~'));
      assert.deepStrictEqual(decodeShare(token), snap);
    }
    assert.strictEqual(encodeShare({ a: 1 }), 'eyJhIjoxfQ');
  });

  it('writes the plain token when the compressed one is exactly as long', () => {
    const snap = { s: 'aaaaa' };
    assert.strictEqual(compressText(JSON.stringify(snap)).length + 2, plainToken(snap).length);
    assert.strictEqual(encodeShare(snap), 'eyJzIjoiYWFhYWEifQ');
    assert.strictEqual(plainToken(snap), 'eyJzIjoiYWFhYWEifQ');
    assert.deepStrictEqual(decodeShare('~1PYRBzgHSAw7qAfQg'), snap, 'the compressed spelling still decodes');
  });

  it('never writes a token longer than the plain one', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let n = 0; n < 200; n++) {
      let text = '';
      for (let i = 0, len = Math.floor(next() * 400); i < len; i++) text += String.fromCharCode(32 + Math.floor(next() * (n % 2 === 0 ? 4 : 90)));
      const snap = { t: text, n };
      assert.ok(encodeShare(snap).length <= plainToken(snap).length, `case ${n}`);
      assert.deepStrictEqual(decodeShare(encodeShare(snap)), snap, `case ${n}`);
    }
  });

  it('still decodes every plain token an earlier release wrote', () => {
    const snap = { e: 'path', i: { selector: '$..naïve', data: '{"π":3}' } };
    const old = 'eyJlIjoicGF0aCIsImkiOnsic2VsZWN0b3IiOiIkLi5uYcOvdmUiLCJkYXRhIjoie1wiz4BcIjozfSJ9fQ';
    assert.strictEqual(plainToken(snap), old);
    assert.deepStrictEqual(decodeShare(old), snap);
    assert.deepStrictEqual(decodeShare(`${old}==`), snap, 'padded, as atob always allowed');
    assert.deepStrictEqual(decodeShare(plainToken(project)), project);
  });

  it('decodes a corrupt or non-object token to null, never a throw', () => {
    assert.strictEqual(decodeShare('!!! not base64 !!!'), null);
    assert.strictEqual(decodeShare(encodeShare(42)), null, 'a non-object snapshot is rejected');
    assert.strictEqual(decodeShare(''), null);
    assert.strictEqual(decodeShare(/** @type {any} */ (undefined)), null);
  });

  it('decodes a damaged compressed token to null, never a throw', () => {
    const cases = {
      'the prefix alone': '~1',
      'a prefix of no version': '~',
      'a version this release does not know': `~2${projectToken.slice(2)}`,
      'a character outside the alphabet': `${projectToken.slice(0, 40)}+${projectToken.slice(41)}`,
      'a missing last character (no end code)': projectToken.slice(0, -1),
      'a character after the end code': `${projectToken}A`,
      'a stream that is not JSON': `~1${compressText('{"a":')}`,
      'a stream of a non-object': `~1${compressText('42')}`,
    };
    for (const [what, token] of Object.entries(cases)) assert.strictEqual(decodeShare(token), null, what);
  });

  it('refuses a link the site itself could have made that expands to megabytes', () => {
    // 2 MB of valid JSON in a token that fits the site's own share limit
    const token = `~1${compressText(`[${' '.repeat(2000000)}]`)}`;
    assert.ok(token.length < 8000, `${token.length} chars`);
    assert.strictEqual(decodeShare(token), null);
  });

  it('refuses a stream that would expand past the limit, and writes such a snapshot plain', () => {
    const limit = MAX_EXPANDED_BYTES;
    const bomb = `~1${compressText(`[${' '.repeat(limit)}]`)}`;
    assert.ok(bomb.length < 20000, 'a short token names a very long output');
    assert.strictEqual(decodeShare(bomb), null, 'valid JSON, but past the limit once expanded');
    const big = { s: 'y'.repeat(limit) };
    const token = encodeShare(big);
    assert.ok(!token.startsWith('~'), 'past the limit the plain token is written');
    assert.strictEqual(decodeShare(token)?.s.length, limit);
  });
});
