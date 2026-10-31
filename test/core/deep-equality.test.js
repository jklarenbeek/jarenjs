//@ts-check
/**
 * @file `equalsDeep` (and `isUniqueDeepArray`, which compares through it)
 * and `deepFreeze` walk a value nested past the host's call stack on a
 * stack of their own, so they answer at any depth; two values holding
 * cycles compare as the infinite values they unfold to. Every value a
 * recursive walk answered is answered the same.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deepFreeze, equalsDeep, isUniqueDeepArray } from '@jarenjs/core/object';

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
class Box { /** @param {unknown} v */ constructor(v) { this.v = v; } }
/** `n` levels alternating a Map, a class instance and an array around `leaf`. @param {number} n @param {unknown} leaf */
const nestMixed = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = i % 3 === 0 ? new Map([['k', v]]) : i % 3 === 1 ? new Box(v) : [v, i];
  return v;
};

describe('equalsDeep compares a value nested past the host stack', () => {
  it('answers 100000 levels of arrays, objects, Maps and class instances', () => {
    assert.equal(equalsDeep(nestArrays(100000, 1), nestArrays(100000, 1)), true);
    assert.equal(equalsDeep(nestObjects(100000, 1), nestObjects(100000, 1)), true);
    assert.equal(equalsDeep(nestMixed(100000, 1), nestMixed(100000, 1)), true);
  });

  it('finds a difference at the bottom, and a shape that differs anywhere', () => {
    assert.equal(equalsDeep(nestArrays(100000, 1), nestArrays(100000, 2)), false);
    assert.equal(equalsDeep(nestObjects(100000, 1), nestObjects(100000, 2)), false);
    assert.equal(equalsDeep(nestMixed(100000, 1), nestMixed(100000, 2)), false);
    assert.equal(equalsDeep(nestArrays(100000, 1), nestArrays(99999, 1)), false);
    assert.equal(equalsDeep(nestObjects(100000, new Date(5)), nestObjects(100000, new Date(5))), true);
    assert.equal(equalsDeep(nestObjects(100000, new Date(5)), nestObjects(100000, new Date(6))), false);
  });

  it('takes a Map member the source lacks, or a missing own key, as a difference past the switch', () => {
    assert.equal(equalsDeep(nestArrays(300, new Map([['k', 1]])), nestArrays(300, new Map([['j', 1]]))), false);
    assert.equal(equalsDeep(nestArrays(300, { a: 1, b: 2 }), nestArrays(300, { a: 1, c: 2 })), false);
    assert.equal(equalsDeep(nestArrays(300, { a: undefined }), nestArrays(300, { b: undefined })), false);
    assert.equal(equalsDeep(nestArrays(300, new Map([['k', undefined]])), nestArrays(300, new Map([['j', undefined]]))), false);
    assert.equal(equalsDeep(nestArrays(300, new Set([1])), nestArrays(300, new Set([2]))), false);
    assert.equal(equalsDeep(nestArrays(300, new Uint8Array([1, 2])), nestArrays(300, new Uint8Array([1, 2]))), true);
    assert.equal(equalsDeep(nestArrays(300, /a/g), nestArrays(300, /a/i)), false);
    assert.equal(equalsDeep(nestArrays(300, () => 1), nestArrays(300, () => 1)), true);
  });
});

describe('equalsDeep compares cycles as the values they unfold to', () => {
  it('reads two cycles of one shape as equal', () => {
    /** @type {any[]} */ const a = []; a.push(a);
    /** @type {any[]} */ const b = []; b.push(b);
    assert.equal(equalsDeep(a, b), true);
    /** @type {any[]} */ const c = [[]]; c[0].push(c);
    assert.equal(equalsDeep(a, c), true, 'a one-array cycle unfolds as a two-array one does');
    /** @type {any} */ const o = { x: 1 }; o.self = o;
    /** @type {any} */ const p = { x: 1 }; p.self = p;
    assert.equal(equalsDeep(o, p), true);
    const m = new Map(); m.set('next', m);
    const n = new Map(); n.set('next', n);
    assert.equal(equalsDeep(m, n), true);
  });

  it('finds a member that differs beside the cycle', () => {
    /** @type {any[]} */ const a = []; a.push(a, 1);
    /** @type {any[]} */ const b = []; b.push(b, 2);
    assert.equal(equalsDeep(a, b), false);
    /** @type {any} */ const o = { x: 1 }; o.self = o;
    /** @type {any} */ const p = { x: 2 }; p.self = p;
    assert.equal(equalsDeep(o, p), false);
    assert.equal(equalsDeep(o, { x: 1, self: { x: 1, self: {} } }), false, 'a cycle against a finite value ends where the finite one does');
  });
});

/**
 * The recursive compare `equalsDeep` was, as the oracle every value a
 * recursive walk answered must still answer by.
 * @param {any} target @param {any} source @returns {boolean}
 */
function recursiveEqualsDeep(target, source) {
  if (target === source) return true;
  if (target == null || source == null) return false;
  if (target === true || target === false || source === true || source === false) return false;
  if (typeof target === 'function') return typeof source === 'function' && target.toString() === source.toString();
  if (typeof target !== 'object') return false;
  const constructor = Object.getPrototypeOf(target)?.constructor;
  if (constructor !== Object.getPrototypeOf(source)?.constructor) return false;
  if (constructor === Map) {
    if (target.size !== source.size) return false;
    for (const [key, value] of target) if (!source.has(key) || !recursiveEqualsDeep(value, source.get(key))) return false;
    return true;
  }
  if (constructor === Array) {
    if (target.length !== source.length) return false;
    for (let i = 0; i < target.length; i++) if (!recursiveEqualsDeep(target[i], source[i])) return false;
    return true;
  }
  if (constructor === Set) {
    if (target.size !== source.size) return false;
    for (const value of target) if (!source.has(value)) return false;
    return true;
  }
  if (constructor === RegExp) return target.toString() === source.toString();
  if (constructor === Date) return Object.is(target.getTime(), source.getTime());
  if (ArrayBuffer.isView(target) && !(target instanceof DataView)) {
    if (target.length !== source.length) return false;
    for (let i = 0; i < target.length; i++) if (target[i] !== source[i]) return false;
    return true;
  }
  const tkeys = Object.keys(target);
  if (tkeys.length !== Object.keys(source).length) return false;
  for (const key of tkeys) if (!Object.hasOwn(source, key) || !recursiveEqualsDeep(target[key], source[key])) return false;
  return true;
}

/** A seeded generator, so a failure names the case that reproduces it. @param {number} seed */
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe('equalsDeep answers every value a recursive compare answered', () => {
  it('agrees with the recursive compare on 4000 generated pairs, across the switch to its own stack', () => {
    const next = random(7);
    const pick = (/** @type {any[]} */ list) => list[Math.floor(next() * list.length)];
    class Point { /** @param {number} x */ constructor(x) { this.x = x; } }
    const shared = { s: [1, 2] };
    /** @param {number} depth @returns {any} */
    const value = (depth) => {
      if (depth <= 0 || next() < 0.3)
        return pick([0, 1, -0, NaN, 'a', 'b', '', true, false, null, undefined, 1n, shared, new Date(1), new Date(2), /x/, /x/g, () => 0]);
      const kind = pick(['array', 'object', 'map', 'set', 'class', 'typed', 'chain']);
      if (kind === 'array') return Array.from({ length: Math.floor(next() * 3) }, () => value(depth - 1));
      if (kind === 'object') return Object.fromEntries(Array.from({ length: Math.floor(next() * 3) }, (_, i) => [pick(['a', 'b', '__proto__', String(i)]), value(depth - 1)]));
      if (kind === 'map') return new Map(Array.from({ length: Math.floor(next() * 3) }, () => [pick(['k', 'l', 1, shared]), value(depth - 1)]));
      if (kind === 'set') return new Set([pick([1, 2, shared]), pick([1, 3])]);
      if (kind === 'class') return new Point(value(depth - 1));
      if (kind === 'typed') return pick([new Uint8Array([1, 2]), new Uint8Array([1, 3]), new Float64Array([0.5])]);
      // a chain long enough to cross the switch to the walk's own stack
      return nestArrays(250 + Math.floor(next() * 20), value(depth - 1));
    };
    let compared = 0;
    let equal = 0;
    for (let i = 0; i < 4000; i++) {
      const a = value(4);
      // a twin built the same way half of the time, so equal pairs are common
      const b = next() < 0.5 ? structuredCloneWith(a) : value(4);
      const want = recursiveEqualsDeep(a, b);
      assert.equal(equalsDeep(a, b), want, `pair ${i}`);
      compared++;
      if (want) equal++;
    }
    assert.equal(compared, 4000);
    assert.ok(equal > 1000, `${equal} equal pairs`);
  });
});

/**
 * A copy of a generated value that keeps functions, class instances and
 * the shared subtree by identity where a recursive compare reads them so.
 * @param {any} v @returns {any}
 */
function structuredCloneWith(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (ArrayBuffer.isView(v) || v instanceof Set || Object.keys(v).length === 1 && Object.hasOwn(v, 's') && Array.isArray(v.s)) return v;
  if (Array.isArray(v)) return v.map(structuredCloneWith);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, structuredCloneWith(x)]));
  const out = Object.create(Object.getPrototypeOf(v));
  for (const key of Object.keys(v)) Object.defineProperty(out, key, { value: structuredCloneWith(v[key]), enumerable: true, writable: true, configurable: true });
  return out;
}

describe('isUniqueDeepArray compares deep items', () => {
  it('finds two equal items nested 100000 levels, and two that differ at the bottom', () => {
    assert.equal(isUniqueDeepArray([nestArrays(100000, 1), nestArrays(100000, 1)]), false);
    assert.equal(isUniqueDeepArray([nestArrays(100000, 1), nestArrays(100000, 2)]), true);
    assert.equal(isUniqueDeepArray([nestObjects(100000, 1), 1, nestObjects(100000, 1)]), false);
  });
});

describe('deepFreeze freezes a value nested past the host stack', () => {
  it('freezes every level of 100000 nested arrays and objects', () => {
    for (const nest of [nestArrays, nestObjects]) {
      const value = nest(100000, { leaf: [1] });
      assert.equal(deepFreeze(value), value);
      let at = value;
      let levels = 0;
      while (true) {
        assert.equal(Object.isFrozen(at), true, `level ${levels}`);
        const inner = Array.isArray(at) ? at[0] : at.a ?? at.leaf;
        if (inner === undefined || typeof inner !== 'object') break;
        at = inner;
        levels++;
      }
      assert.equal(levels, 100001);
    }
  });

  it('stops at a cycle deeper than the first levels, freezing every object on it', () => {
    /** @type {any} */
    const top = nestObjects(20, null);
    let bottom = top;
    while (bottom.a !== null) bottom = bottom.a;
    bottom.a = top.a.a.a.a.a.a.a.a.a.a;
    deepFreeze(top);
    assert.equal(Object.isFrozen(top), true);
    assert.equal(Object.isFrozen(bottom), true);
  });

  it('freezes in the order a recursive walk did: members before the object holding them', () => {
    const order = [];
    const value = { a: { b: {} }, c: [{}] };
    const watch = (/** @type {any} */ v, /** @type {string} */ name) => new Proxy(v, {
      preventExtensions(target) { order.push(name); return Reflect.preventExtensions(target); },
    });
    const tree = watch({ a: watch({ b: watch(value.a.b, 'b') }, 'a'), c: watch([watch({}, 'c0')], 'c') }, 'root');
    deepFreeze(tree);
    assert.deepEqual(order, ['b', 'a', 'c0', 'c', 'root']);
    // and past the levels walked on the host's stack
    order.length = 0;
    deepFreeze(nestArrays(300, watch({ a: watch({ b: watch(value.a.b, 'b') }, 'a'), c: watch([watch({}, 'c0')], 'c') }, 'root')));
    assert.deepEqual(order, ['b', 'a', 'c0', 'c', 'root']);
  });
});

describe('the deep walks answer on a small host stack', () => {
  it('compares, checks uniqueness and freezes 20000 and 100000 levels under --stack-size=500', () => {
    const script = `
      import { deepFreeze, equalsDeep, isUniqueDeepArray } from '@jarenjs/core/object';
      const nest = (n, leaf) => { let v = leaf; for (let i = 0; i < n; i++) v = i % 2 ? [v] : new Map([['k', v]]); return v; };
      const out = [];
      for (const n of [20000, 100000]) {
        out.push(equalsDeep(nest(n, 1), nest(n, 1)), equalsDeep(nest(n, 1), nest(n, 2)),
          isUniqueDeepArray([nest(n, 1), nest(n, 1)]), Object.isFrozen(deepFreeze(nest(n, 1))));
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=500', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url), env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify([true, false, false, true, true, false, false, true]));
  });
});
