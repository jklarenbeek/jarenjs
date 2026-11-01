//@ts-check
/**
 * @file `cloneJson` (`@jarenjs/core/object`) copies a value nested past the
 * host's call stack on a stack of its own, so it answers at any depth, and
 * refuses a cycle, which has no copy, as the other walks of the package do:
 * `JsonCycleError` `JO2002` at the member that closes it. Every value a
 * recursive copy answered is copied the same.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cloneJson } from '@jarenjs/core/object';

/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nestArrays = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** `n` nested `{ a, n }` objects around `leaf`. @param {number} n @param {unknown} leaf */
const nestObjects = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = { a: v, n: i };
  return v;
};
/** The containers down the first member of each level. @param {any} v @returns {any[]} */
const spine = (v) => {
  const out = [];
  while (v !== null && typeof v === 'object') {
    out.push(v);
    v = Array.isArray(v) ? v[0] : v.a;
  }
  return out;
};

describe('cloneJson copies a value nested past the host stack', () => {
  it('copies 100000 levels of arrays and of objects, sharing no container', () => {
    for (const source of [nestArrays(100000, 'leaf'), nestObjects(100000, 'leaf')]) {
      const copy = cloneJson(source);
      const from = spine(source);
      const to = spine(copy);
      assert.equal(to.length, 100000);
      for (const level of [0, 255, 256, 257, 50000, 99999]) assert.notEqual(to[level], from[level]);
      assert.equal(Array.isArray(to[99999]) ? to[99999][0] : to[99999].a, 'leaf');
    }
    const objects = spine(cloneJson(nestObjects(100000, 'leaf')));
    assert.deepEqual([objects[0].n, objects[1].n, objects[99999].n], [99999, 99998, 0]);
  });

  it('copies past 256 levels member for member as it copies above them', () => {
    const level = () => JSON.parse('{"2":true,"z":[1,null,"s",{"q":[]}],"__proto__":{"x":1},"a":-0.5}');
    /** @type {any} */
    let source = level();
    for (let i = 0; i < 300; i++) source = { ...level(), next: source };
    const copy = cloneJson(source);
    assert.equal(JSON.stringify(copy), JSON.stringify(source));
    let at = copy;
    let from = source;
    for (let i = 0; i < 300; i++) {
      assert.deepEqual(Object.keys(at), ['2', 'z', '__proto__', 'a', 'next']);
      assert.ok(Object.hasOwn(at, '__proto__'));
      assert.equal(Object.getPrototypeOf(at), Object.prototype);
      assert.notEqual(at.z, from.z);
      at = at.next;
      from = from.next;
    }
    assert.deepEqual(Object.keys(at), ['2', 'z', '__proto__', 'a']);
  });

  it('copies a container reached twice once per reach, at any depth', () => {
    const shared = { v: [1, 2] };
    const copy = cloneJson({ a: shared, b: shared });
    assert.deepEqual(copy, { a: { v: [1, 2] }, b: { v: [1, 2] } });
    assert.notEqual(copy.a, copy.b);
    const deep = cloneJson(nestArrays(400, { l: shared, r: shared }));
    const bottom = spine(deep)[399][0];
    assert.deepEqual(bottom, { l: { v: [1, 2] }, r: { v: [1, 2] } });
    assert.notEqual(bottom.l, bottom.r);
  });

  it('returns a scalar as it is, and takes nothing but the value', () => {
    for (const scalar of [null, 0, 'x', true, undefined]) assert.equal(cloneJson(scalar), scalar);
    const copies = [[1], { a: [2] }].map(cloneJson);
    assert.deepEqual(copies, [[1], { a: [2] }]);
  });
});

describe('cloneJson refuses a cycle', () => {
  const refusal = { name: 'JsonCycleError', code: 'JO2002' };

  it('names the member that closes it, in the order the copy meets members', () => {
    const self = /** @type {any} */ ({ a: 1 });
    self.self = self;
    assert.throws(() => cloneJson(self), { ...refusal, docPath: '/self', message: 'JO2002: a circular reference cannot be copied at /self' });
    const list = /** @type {any[]} */ ([1]);
    list.push(list);
    assert.throws(() => cloneJson(list), { ...refusal, docPath: '/1' });
    // members in the order the value holds them, not sorted: `z` is met first
    const both = /** @type {any} */ ({ z: null, a: null });
    both.z = both;
    both.a = both;
    assert.throws(() => cloneJson(both), { ...refusal, docPath: '/z' });
  });

  it('refuses a cycle that closes past 256 levels, and one past 10000', () => {
    for (const length of [300, 20000]) {
      const root = /** @type {any} */ ({ x: null });
      let at = root;
      for (let i = 0; i < length; i++) at = (at.x = { x: null });
      at.x = root;
      assert.throws(() => cloneJson(root), { ...refusal, docPath: '/x'.repeat(length + 1) });
      assert.throws(() => cloneJson({ keep: [1], loop: root }), { ...refusal, docPath: `/loop${'/x'.repeat(length + 1)}` });
    }
  });
});
