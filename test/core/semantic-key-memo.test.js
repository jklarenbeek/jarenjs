//@ts-check
/**
 * @file `semanticKey` remembers the key of a root whose whole tree its
 * walk proved immutable — every container frozen, dense and holding only
 * data members — and returns it on the next call without walking; a walk
 * also remembers such a tree it meets under a container it knows mutable
 * (a tuple built per call), and joins a remembered tree's key wherever it
 * meets it, counting its height against the depth bound. Every other
 * value is walked on every call. Walks are counted by the calls the walk
 * makes to `Object.keys`, one per container it opens.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { semanticKey, deepFreeze } from '../../packages/core/src/object.js';
import { createSemanticCache } from '../../packages/core/src/cache.js';

/**
 * The `Object.keys` calls one synchronous call makes.
 * @param {import('node:test').TestContext} t
 */
function walkCounter(t) {
  const keys = t.mock.method(Object, 'keys');
  return (/** @type {() => unknown} */ run) => {
    const before = keys.mock.callCount();
    run();
    return keys.mock.callCount() - before;
  };
}

/** A document holding a schema of `members` members, as a workflow holds its port schemas. */
const documentOf = (members = 40) => {
  /** @type {Record<string, any>} */
  const properties = {};
  for (let i = 0; i < members; i++)
    properties[`field${i}`] = { type: i % 2 ? 'string' : 'integer', description: `member ${i}`, enum: [i, i + 1] };
  return { name: 'flow', ports: { input: { type: 'object', properties, required: ['field0'] } } };
};

describe('semanticKey memo', () => {
  it('a deepFreeze\'d document\'s subtree hits the memo on the second lookup', (t) => {
    const document = deepFreeze(documentOf());
    const schema = document.ports.input;
    const expected = semanticKey(structuredClone(schema), { ordered: true });
    const cache = createSemanticCache(512, undefined, { ordered: true });
    const count = walkCounter(t);
    let created = 0;
    const lookup = () => cache.getOrCreate(schema, () => ++created);
    assert.ok(count(lookup) > 40, 'the first lookup walks every container');
    // the ordered form's options are checked per call; no container is opened
    assert.ok(count(lookup) <= 1, 'the second lookup does not walk');
    assert.strictEqual(created, 1);
    assert.strictEqual(semanticKey(schema, { ordered: true }), expected);
    // the default form, which takes no options, reads nothing at all
    semanticKey(schema);
    assert.strictEqual(count(() => semanticKey(schema)), 0);
    assert.strictEqual(semanticKey(schema), semanticKey(structuredClone(schema)));
  });

  it('a shallowly frozen root over an unfrozen child never memoizes and sees the child\'s change', (t) => {
    const child = { a: 1 };
    const root = Object.freeze({ child });
    const first = semanticKey(root);
    child.a = 2;
    const second = semanticKey(root);
    assert.notStrictEqual(second, first);
    assert.strictEqual(second, semanticKey({ child: { a: 2 } }));
    const count = walkCounter(t);
    assert.ok(count(() => semanticKey(root)) >= 2, 'every call walks');
  });

  it('an object frozen after a first lookup memoizes on the next', (t) => {
    const value = documentOf(4);
    const count = walkCounter(t);
    const open = count(() => semanticKey(value));
    assert.ok(open > 4);
    deepFreeze(value);
    // the first call over the frozen tree walks, proves it and remembers the key
    assert.strictEqual(count(() => semanticKey(value)), open);
    assert.strictEqual(count(() => semanticKey(value)), 0);
    assert.strictEqual(semanticKey(value), semanticKey(structuredClone(value)));
  });

  it('ordered and sorted keys of one frozen object never answer for each other', () => {
    const value = deepFreeze({ b: 1, a: { d: 2, c: 3 } });
    for (let round = 0; round < 3; round++) {
      assert.strictEqual(semanticKey(value), '{"a":{"c":3,"d":2},"b":1}');
      assert.strictEqual(semanticKey(value, { ordered: true }), '{"b":1,"a":{"d":2,"c":3}}');
    }
    const other = deepFreeze({ b: 1, a: { d: 2, c: 3 } });
    for (let round = 0; round < 3; round++) {
      assert.strictEqual(semanticKey(other, { ordered: true }), '{"b":1,"a":{"d":2,"c":3}}');
      assert.strictEqual(semanticKey(other), '{"a":{"c":3,"d":2},"b":1}');
    }
  });

  it('a refused frozen value is refused on every call', () => {
    /** @type {any} */
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    Object.freeze(cyclic);
    const withFunction = deepFreeze({ f: () => 1 });
    const withInstance = Object.freeze({ when: Object.freeze(new Date(0)) });
    /** @type {any} */
    let tooLong = Object.freeze([0, 0]);
    for (let i = 1; i < 40; i++) tooLong = Object.freeze([tooLong, tooLong]);
    const refusals = /** @type {[unknown, object][]} */ ([
      [cyclic, { name: 'JsonCycleError', code: 'JO2002' }],
      [withFunction, { name: 'TypeError', message: 'semanticKey: a function at /f cannot be a cache identity' }],
      [withInstance, { name: 'TypeError', message: 'semanticKey: a Date instance at /when cannot be a cache identity' }],
      [tooLong, { name: 'JsonLengthError', code: 'JO2009' }],
    ]);
    for (const [value, refusal] of refusals) {
      for (let call = 0; call < 3; call++) {
        assert.throws(() => semanticKey(value), refusal);
        assert.throws(() => semanticKey(value, { ordered: true }), refusal);
      }
    }
    const cache = createSemanticCache(8);
    let created = 0;
    for (let call = 0; call < 3; call++) cache.getOrCreate(cyclic, () => ++created);
    assert.strictEqual(created, 3);
    assert.strictEqual(cache.size(), 0);
  });

  it('a frozen tree with an accessor never memoizes, in an object or an array', (t) => {
    let reads = 0;
    const object = {};
    Object.defineProperty(object, 'n', { enumerable: true, get: () => ++reads });
    const root = deepFreeze({ object });
    assert.notStrictEqual(semanticKey(root), semanticKey(root));
    const array = [0];
    Object.defineProperty(array, 0, { enumerable: true, get: () => ++reads });
    const list = deepFreeze([array]);
    assert.notStrictEqual(semanticKey(list, { ordered: true }), semanticKey(list, { ordered: true }));
    const count = walkCounter(t);
    assert.ok(count(() => semanticKey(root)) >= 2);
  });

  it('a getter that keys a frozen value mid-walk does not let the outer walk memoize', () => {
    let reads = 0;
    const holder = {};
    // a fresh frozen value each read, so the inner call walks and proves it
    Object.defineProperty(holder, 'n', { enumerable: true, get: () => { semanticKey(deepFreeze({ x: [1, 2] })); return ++reads; } });
    const root = deepFreeze({ holder, tail: { z: 1 } });
    const start = reads; // deepFreeze reads members too
    const first = semanticKey(root);
    const second = semanticKey(root);
    assert.strictEqual(reads, start + 2, 'each call read the getter');
    assert.strictEqual(second, semanticKey({ holder: { n: start + 2 }, tail: { z: 1 } }));
    assert.notStrictEqual(second, first);
  });

  it('a frozen array with a hole never memoizes: the hole reads through the prototype', () => {
    // eslint-disable-next-line no-sparse-arrays
    const holey = Object.freeze([1, , 3]);
    const before = semanticKey(holey);
    assert.strictEqual(before, semanticKey([1, undefined, 3]));
    /** @type {any} */ (Array.prototype)[1] = 'x';
    try {
      assert.strictEqual(semanticKey(holey), semanticKey([1, 'x', 3]));
    }
    finally {
      delete /** @type {any} */ (Array.prototype)[1];
    }
    assert.strictEqual(semanticKey(holey), before);
  });

  it('a frozen document inside a fresh tuple is walked once, then joined, at any size', (t) => {
    const count = walkCounter(t);
    for (const members of [1000, 8000]) {
      const document = deepFreeze(documentOf(members));
      const expected = semanticKey(structuredClone([document, 'sqlite', true]));
      let first = '';
      assert.ok(count(() => { first = semanticKey([document, 'sqlite', true]); }) > members, 'the first tuple walks the document');
      assert.strictEqual(first, expected);
      // the next tuple opens itself alone: the document's key is joined
      let second = '';
      assert.strictEqual(count(() => { second = semanticKey([document, 'sqlite', true]); }), 1, `${members} members`);
      assert.strictEqual(second, expected);
      assert.strictEqual(count(() => semanticKey({ strict: false, document })), 1);
      assert.strictEqual(semanticKey({ strict: false, document }), semanticKey(structuredClone({ strict: false, document })));
      // the ordered form keeps its own memory
      assert.ok(count(() => semanticKey([document], { ordered: true })) > members);
      assert.ok(count(() => semanticKey([document], { ordered: true })) <= 2);
      assert.strictEqual(semanticKey([document], { ordered: true }), semanticKey(structuredClone([document]), { ordered: true }));
    }
  });

  it('a joined tree counts its height against the depth bound, as walking it does', () => {
    /** @param {number} levels @returns {any} */
    const chain = (levels) => { let v = /** @type {any} */ (0); for (let i = 0; i < levels; i++) v = [v]; return v; };
    for (const remembered of [true, false]) {
      const tree = deepFreeze(chain(9998));
      if (remembered) semanticKey(tree);
      // remembered or proved inside the tuple, the answers are the walk's
      assert.strictEqual(semanticKey([tree]), '['.repeat(9999) + '0' + ']'.repeat(9999));
      assert.strictEqual(semanticKey([[tree]]).length, 10000 * 2 + 1);
      assert.throws(() => semanticKey([[[tree]]]), { code: 'JO2001', message: 'JO2001: a value nested deeper than 10000 levels cannot be a cache identity' });
      assert.throws(() => semanticKey({ a: [[[tree]]] }), { code: 'JO2001' });
    }
  });

  it('a frozen tree under a frozen container with an unfrozen child sees the child\'s change', () => {
    const child = { a: 1 };
    const big = deepFreeze(documentOf(40));
    const holder = Object.freeze({ big, child });
    const first = semanticKey([holder]);
    child.a = 2;
    assert.notStrictEqual(semanticKey([holder]), first);
    assert.strictEqual(semanticKey([holder]), semanticKey(structuredClone([holder])));
    assert.strictEqual(semanticKey(holder), semanticKey(structuredClone(holder)));
  });
});
