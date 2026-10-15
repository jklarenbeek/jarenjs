//@ts-check
/**
 * @file `equalsJson` and `stableStringify` walk any nesting a default host
 * stack could, without that stack: past 10000 levels they refuse with
 * `JO2001` instead of overflowing it, and on a cycle with `JO2002` at the
 * member that closes it, the pointer `locateCycle` answers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { contentKey, equalsJson, locateCycle, semanticKey, stableStringify } from '@jarenjs/core/object';

/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nestArrays = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** `n` nested `{ a }` objects around `leaf`. @param {number} n @param {unknown} leaf */
const nestObjects = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};
/** @param {string} verb */
const refused = (verb) => ({
  name: 'JsonDepthError',
  code: 'JO2001',
  message: `JO2001: a value nested deeper than 10000 levels cannot be ${verb}`,
});
/** @param {string} reason @param {string} at */
const circular = (reason, at) => ({
  name: 'JsonCycleError',
  code: 'JO2002',
  reason,
  docPath: at,
  message: `JO2002: ${reason} at ${at}`,
});

describe('equalsJson walks deep values without the host stack', () => {
  it('compares 10000 levels both ways', () => {
    assert.equal(equalsJson(nestArrays(10000, 1), nestArrays(10000, 1)), true);
    assert.equal(equalsJson(nestObjects(10000, 1), nestObjects(10000, 1)), true);
    assert.equal(equalsJson(nestObjects(10000, 1), nestObjects(10000, 2)), false);
    assert.equal(equalsJson(nestArrays(10000, 1), nestArrays(10000, [1])), false);
  });

  it('refuses the 10001st level with JO2001', () => {
    assert.throws(() => equalsJson(nestArrays(10001, 1), nestArrays(10001, 1)), refused('compared'));
    assert.throws(() => equalsJson(nestObjects(10001, 1), nestObjects(10001, 2)), refused('compared'));
  });

  it('refuses a pair of cycles as a circular reference, naming the value and the member', () => {
    /** @type {any} */
    const a = { x: 1 };
    a.self = a;
    /** @type {any} */
    const b = { x: 1 };
    b.self = b;
    assert.throws(() => equalsJson(a, b), circular('a circular reference in the first value cannot be compared', '/self'));
    // the walk meets the cycle of the second value beside a first value as deep as the bound
    assert.throws(() => equalsJson(nestObjects(10005, 1), (() => { /** @type {any} */ const c = { a: {} }; c.a.a = c; return c; })()),
      circular('a circular reference in the second value cannot be compared', '/a/a'));
    // a difference beside the cycle answers before the walk goes deep
    assert.equal(equalsJson(a, { x: 2, self: b }), false);
    assert.equal(equalsJson(a, a), true);
  });

  it('still answers one reference compared with itself at any depth', () => {
    const deep = nestArrays(100000, 1);
    assert.equal(equalsJson(deep, deep), true);
  });
});

describe('stableStringify walks deep values without the host stack', () => {
  it('serializes 10000 levels', () => {
    assert.equal(stableStringify(nestArrays(10000, 1)), '['.repeat(10000) + '1' + ']'.repeat(10000));
    assert.equal(stableStringify(nestObjects(10000, 1)), '{"a":'.repeat(10000) + '1' + '}'.repeat(10000));
  });

  it('refuses the 10001st level with JO2001', () => {
    assert.throws(() => stableStringify(nestObjects(10001, 1)), refused('serialized'));
    assert.throws(() => contentKey(nestArrays(10001, 1)), refused('serialized'));
  });

  it('refuses a cycle as a circular reference at the member that closes it', () => {
    /** @type {any} */
    const cycle = [1];
    cycle.push(cycle);
    assert.throws(() => stableStringify(cycle), circular('a circular reference cannot be serialized', '/1'));
    // contentKey serializes through stableStringify: a cycle is the same refusal, not an overflow
    assert.throws(() => contentKey(cycle), circular('a circular reference cannot be serialized', '/1'));
    /** @type {any} */
    const self = { self: null };
    self.self = self;
    assert.throws(() => contentKey(self), circular('a circular reference cannot be serialized', '/self'));
  });

  it('a loop longer than the bound is a value as deep as the bound', () => {
    /** @type {any} */
    const head = { a: null };
    let tail = head;
    for (let i = 0; i < 10005; i++) tail = tail.a = { a: null };
    tail.a = head;
    assert.throws(() => stableStringify(head), refused('serialized'));
    assert.equal(locateCycle(head), undefined);
  });

  it('keeps every other answer byte for byte', () => {
    const fn = () => 1;
    const date = new Date(0);
    // eslint-disable-next-line no-sparse-arrays
    const holes = [1, , 3];
    assert.equal(stableStringify({ b: [undefined, fn, Symbol('s'), NaN, -0, Infinity], a: { u: undefined, f: fn } }),
      '{"a":{},"b":[null,null,null,null,0,null]}');
    assert.equal(stableStringify(holes), '[1,null,3]');
    assert.equal(stableStringify({ d: date, j: { toJSON: () => 'x', k: 1 } }), '{"d":{},"j":{"k":1}}');
    assert.equal(stableStringify(JSON.parse('{"__proto__":[1],"z":{"y":2,"x":[{}]}}')),
      '{"__proto__":[1],"z":{"x":[{}],"y":2}}');
    assert.equal(stableStringify({ 10: 1, 9: 2, b: 3, a: 4 }), '{"10":1,"9":2,"a":4,"b":3}');
    assert.equal(stableStringify(undefined), undefined);
    assert.equal(stableStringify(fn), undefined);
    assert.equal(stableStringify('s'), '"s"');
    assert.throws(() => stableStringify({ a: [1n] }), TypeError);
  });
});

describe('locateCycle names the member that closes a cycle', () => {
  it('answers the pointer of the first member whose value is open above it', () => {
    /** @type {any} */
    const self = { x: 1 };
    self.self = self;
    /** @type {any} */
    const list = [{ x: 0 }];
    list[0].x = list;
    /** @type {any} */
    const ring = { b: { c: {} } };
    ring.b.c.a = ring;
    /** @type {any} */
    const escaped = { 'a/b': { 'm~n': null }, z: 1 };
    escaped['a/b']['m~n'] = escaped;
    /** @type {any} */
    const inner = { a: [1, { b: null }] };
    inner.a[1].b = inner.a[1];
    // members in sorted order: `b` is met before `z`
    /** @type {any} */
    const two = { z: null, b: null };
    two.z = two;
    two.b = two;
    assert.deepEqual([self, list, ring, escaped, inner, two].map(locateCycle),
      ['/self', '/0/x', '/b/c/a', '/a~1b/m~0n', '/a/1/b', '/b']);
  });

  it('answers undefined for every value without a cycle', () => {
    const shared = { k: [1, 2] };
    for (const value of [null, 1, 'a', [], {}, { a: shared, b: shared, c: [shared, shared] }, nestArrays(10000, 1)])
      assert.equal(locateCycle(value), undefined);
  });

  it('searches a shared subtree once, so a value with 2^60 paths answers', () => {
    /** @type {any} */
    let dag = [];
    for (let i = 0; i < 60; i++) dag = [dag, dag];
    assert.equal(locateCycle(dag), undefined);
    /** @type {any} */
    const loop = { at: null };
    loop.at = { back: loop };
    assert.equal(locateCycle([dag, dag, loop]), '/2/at/back');
  });

  it('leaves the values that answered before answering', () => {
    /** @type {any} */
    const self = { x: 1 };
    self.self = self;
    // semanticKey keeps its own cycle refusal
    assert.throws(() => semanticKey(self), /semanticKey: a cycle at \/self cannot be a cache identity/);
    assert.equal(stableStringify({ a: { k: 1 }, b: { k: 1 } }), '{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('the bound holds on a small host stack', () => {
  it('passes 10000 levels and refuses 10001 under --stack-size=900', () => {
    const script = `
      import { equalsJson, stableStringify } from '@jarenjs/core/object';
      const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = { a: [v] }; return v; };
      const codeOf = (f) => { try { f(); return 'answered'; } catch (e) { return e.code ?? e.name; } };
      process.stdout.write(JSON.stringify([
        equalsJson(nest(5000), nest(5000)),
        stableStringify(nest(5000)).length,
        codeOf(() => equalsJson(nest(5001), nest(5001))),
        codeOf(() => stableStringify(nest(5001))),
      ]));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=900', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify([true, 5000 * 6 + 1 + 5000 * 2, 'JO2001', 'JO2001']));
  });
});
