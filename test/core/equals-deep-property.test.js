//@ts-check
/**
 * @file The properties `equalsDeep` holds over generated values, JSON
 * values and every kind no JSON text carries, nested, with cycles: two
 * values built alike are equal (unless they hold a NaN compared by value),
 * a value with one state changed is unequal, every pair answers the same in
 * both orders and never throws, a pair nested past the compare's switch to
 * its own stack answers as at the root, and `isUniqueDeepArray` takes a
 * list as unique exactly when no two of its items are equal.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

import { equalsDeep, isUniqueDeepArray } from '@jarenjs/core/object';

/**
 * A value by its recipe: `make` builds it anew (two builds share no
 * container), `change` builds it with one state changed, and `nan` says it
 * holds a NaN compared by value, which no build equals.
 * @typedef {{ make: () => any, change: () => any, nan: boolean }} Recipe
 */

class Point {}
class Other {}
class Sub extends Array {}
class Stamp extends Date {}
class Registry extends Map {}
const realm = vm.createContext({});

/** A seeded generator, so a failure names the case that reproduces it. @param {number} seed */
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nest = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

/**
 * The recipes of one seed.
 * @param {number} seed
 */
function recipes(seed) {
  const next = random(seed);
  const int = (/** @type {number} */ n) => Math.floor(next() * n);
  const pick = (/** @type {any[]} */ list) => list[int(list.length)];
  let builds = 0;

  /** @param {unknown} value @param {unknown} changed @returns {Recipe} */
  const leaf = (value, changed) => ({ make: () => value, change: () => changed, nan: value !== value });
  /** A value of one state `at`, built by `build`. @param {(at: number) => any} build @param {number} at @param {boolean} [nan] @returns {Recipe} */
  const state = (build, at, nan = false) => ({ make: () => build(at), change: () => build(at + 1), nan });
  /**
   * A container of `parts`, built by `build` from their values: changed by one part changed, or by `grow` where it holds none.
   * @param {Recipe[]} parts @param {(values: any[]) => any} build @param {(values: any[]) => any} grow @returns {Recipe}
   */
  const holding = (parts, build, grow) => {
    const at = int(Math.max(1, parts.length));
    return {
      make: () => build(parts.map((part) => part.make())),
      change: () => parts.length === 0 ? grow([]) : build(parts.map((part, i) => i === at ? part.change() : part.make())),
      nan: parts.some((part) => part.nan),
    };
  };
  /** The members of an object, in an order that turns with every build. @param {any} object @param {any[]} values @param {string[]} names */
  const fill = (object, values, names) => {
    const order = values.map((_, i) => i);
    if (builds++ % 2) order.reverse();
    for (const i of order) object[names[i]] = values[i];
    return object;
  };
  const NAMES = ['a', 'b', 'c', '__proto__x', '0', 'length'];
  const names = (/** @type {number} */ n) => NAMES.slice(0, n);
  /** @param {number} n */
  const bytes = (n) => Array.from({ length: n }, (_, i) => (i * 7 + n) % 256);

  /** @param {number} depth @returns {Recipe} */
  const value = (depth) => {
    const parts = (/** @type {number} */ most) => Array.from({ length: int(most + 1) }, () => value(depth - 1));
    switch (depth <= 0 ? int(11) : int(40)) {
      case 0: return leaf(null, 0);
      case 1: return leaf(pick([true, false]), 'true');
      case 2: return leaf(pick([0, -0, 1, 1.5, -2, 1e21, Infinity]), 7);
      case 3: return leaf(pick(['', 'a', 'b', 'true', '1', 'null']), 'changed');
      case 4: return leaf(NaN, 1);
      case 5: return leaf(pick([1n, 2n]), 3n);
      case 6: return leaf(undefined, null);
      // a registered symbol, or one of this recipe alone: every build holds the same one
      case 7: return leaf(pick([Symbol.for('a'), Symbol.for('b'), Symbol('a')]), Symbol.for('c'));
      case 8: return state((at) => new Function(`return ${at};`), int(3));
      case 9: return state((at) => new Date(at), int(3));
      case 10: return leaf(new Date(NaN), new Date(0));
      case 11: case 12: case 13: return holding(parts(3), (values) => values, () => [null]);
      case 14: case 15: case 16: { const p = parts(3); const n = names(p.length); return holding(p, (values) => fill({}, values, n), () => ({ a: null })); }
      case 17: { const p = parts(2); const n = names(p.length); return holding(p, (values) => fill(Object.create(null), values, n), () => Object.assign(Object.create(null), { a: null })); }
      case 18: { const p = parts(2); const n = names(p.length); return holding(p, (values) => fill(new Point(), values, n), () => new Other()); }
      case 19: return holding(parts(3), (values) => Sub.from(values), () => new Sub(2));
      case 20: return state((at) => Object.assign(new Sub(2 + at), { x: 1 }), int(2));
      case 21: { const p = parts(3); return holding(p, (values) => new Map(values.map((v, i) => [['k', 1, true][i], v])), () => new Map([['k', 1]])); }
      case 22: { const p = parts(2); return holding(p, (values) => new Registry(values.map((v, i) => [i, v])), () => new Registry([[0, 0]])); }
      case 23: return state((at) => new Set(['a', at, at + 10]), int(3));
      case 24: return state((at) => new Uint8Array([1, at]), int(3));
      case 25: return state((at) => new Float64Array([0.5, at]), int(3));
      case 26: return leaf(new Float64Array([NaN]), new Float64Array([1]));
      case 27: return state((at) => Uint8Array.from(bytes(1 + at)).buffer, int(3));
      case 28: return state((at) => { const memory = new SharedArrayBuffer(2); new Uint8Array(memory)[1] = at; return memory; }, int(3));
      case 29: return state((at) => new DataView(Uint8Array.from([9, at, at + 1]).buffer, 1), int(3));
      case 30: return state((at) => new Stamp(at), int(3));
      case 31: { const flags = pick(['', 'g']); return state((at) => new RegExp(`a{${at}}`, flags), int(3)); }
      case 32: return state(pick([(/** @type {number} */ at) => new Number(at), (/** @type {number} */ at) => new String(['a', 'b', 'true', '1'][at]),
        (/** @type {number} */ at) => Object(BigInt(at)), (/** @type {number} */ at) => Object(Symbol.for(`s${at}`))]), int(3));
      case 33: return leaf(new Boolean(true), new Boolean(false));
      case 34: { const p = parts(1); return holding(p, (values) => Object.assign(new TypeError('refused', values.length ? { cause: values[0] } : undefined), { code: 1 }), () => new TypeError('refused otherwise')); }
      case 35: { const p = parts(2); return holding(p, (values) => new AggregateError(values, 'all'), () => new AggregateError([], 'none')); }
      case 36: { const p = [value(depth - 1)]; return holding(p, (values) => ({ get a() { return values[0]; }, b: 1 }), () => null); }
      // a member the relation does not read, of another value in every build
      case 37: { const p = parts(2); const n = names(p.length); return holding(p, (values) => Object.defineProperty(fill({}, values, n), 'hidden', { value: builds++, enumerable: false }), () => ({ a: null })); }
      case 38: { const p = parts(2); const n = names(p.length); return holding(p, (values) => new Proxy(fill({}, values, n), {}), () => new Proxy({ a: null }, {})); }
      // two members lead back into the value, and it holds its own parent
      default: {
        const p = parts(2);
        const n = names(p.length);
        const loop = (/** @type {any[]} */ values) => { const o = fill({}, values, n); o.self = o; o.again = o; o.kid = { parent: o, top: o }; return o; };
        return holding(p, loop, () => loop([null]).kid);
      }
    }
  };
  /** A value of another realm. @returns {Recipe} */
  const foreign = () => {
    const build = pick([
      (/** @type {number} */ at) => `new Date(${at})`, (/** @type {number} */ at) => `new Map([[1, ${at}]])`,
      (/** @type {number} */ at) => `new Set([${at}])`, (/** @type {number} */ at) => `({ a: ${at} })`, (/** @type {number} */ at) => `[1, ${at}]`,
      (/** @type {number} */ at) => `new Array(${at + 1})`, (/** @type {number} */ at) => `new Number(${at})`, (/** @type {number} */ at) => `new RangeError('e${at}')`,
      (/** @type {number} */ at) => `Uint8Array.from([${at}]).buffer`, (/** @type {number} */ at) => `/a{${at}}/`,
    ]);
    return state((at) => vm.runInContext(build(at), realm), int(3));
  };
  return { value: () => next() < 0.06 ? foreign() : value(1 + int(3)), int };
}

/**
 * The relation's answer for a pair, asked every way: both orders, nested
 * past the switch to the compare's own stack in both orders, and from the
 * uniqueness check on both sides of its 8-item switch.
 * @param {any} a @param {any} b @param {string} label
 */
function answer(a, b, label) {
  const equal = equalsDeep(a, b);
  assert.equal(equalsDeep(b, a), equal, `${label}: both orders`);
  assert.equal(equalsDeep(nest(300, a), nest(300, b)), equal, `${label}: nested`);
  assert.equal(equalsDeep(nest(300, b), nest(300, a)), equal, `${label}: nested, reversed`);
  assert.equal(isUniqueDeepArray([a, b]), !equal, `${label}: unique`);
  assert.equal(isUniqueDeepArray([b, a]), !equal, `${label}: unique, reversed`);
  assert.equal(isUniqueDeepArray([a, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', b]), !equal, `${label}: unique among 9`);
  assert.equal(isUniqueDeepArray([b, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', a]), !equal, `${label}: unique among 9, reversed`);
  return equal;
}

describe('equalsDeep over generated values', () => {
  // The recipes hold a cycle two members lead into. A compare that did not
  // return for it would hold every test here, so it is asked first, in a
  // child with a time limit.
  before(() => {
    const script = `
      import { equalsDeep } from '@jarenjs/core/object';
      const build = () => { const o = { a: 1 }; o.self = o; o.again = o; o.kid = { parent: o, top: o }; return o; };
      process.stdout.write(String(equalsDeep(build(), build())));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 20000, cwd: new URL('../..', import.meta.url), env: { ...process.env, FORCE_COLOR: '0' } });
    assert.equal(child.status, 0, `the compare did not return in 20 s, or threw: ${child.stderr}`);
    assert.equal(child.stdout, 'true');
  });

  it('takes two builds of one recipe as equal, and a build with one state changed as unequal', () => {
    const { value } = recipes(11);
    let equal = 0;
    let unequal = 0;
    let byNaN = 0;
    for (let i = 0; i < 3000; i++) {
      const recipe = value();
      const built = recipe.make();
      assert.equal(answer(built, recipe.make(), `recipe ${i}, two builds`), !recipe.nan, `recipe ${i}: two builds`);
      assert.equal(answer(built, recipe.change(), `recipe ${i}, one state changed`), false, `recipe ${i}: one state changed`);
      // one reference is equal to itself, whatever it holds, unless it is NaN
      assert.equal(equalsDeep(built, built), built === built, `recipe ${i}: one reference`);
      if (recipe.nan) byNaN++;
      else equal++;
      unequal++;
    }
    assert.equal(equal + byNaN, 3000);
    assert.equal(unequal, 3000);
    assert.ok(equal > 2000, `${equal} equal pairs`);
    assert.ok(byNaN > 100, `${byNaN} recipes holding NaN`);
  });

  it('answers every pair the same in both orders, without throwing', () => {
    const { value } = recipes(23);
    const pool = Array.from({ length: 240 }, () => value().make());
    let equal = 0;
    let compared = 0;
    pool.forEach((a, i) => pool.forEach((b, j) => {
      if (i > j) return;
      compared++;
      if (answer(a, b, `values ${i} and ${j}`)) equal++;
    }));
    assert.equal(compared, 240 * 241 / 2);
    assert.ok(equal >= 240 - 60, `${equal} equal pairs`);
  });

  it('takes a list as unique exactly when no two of its items are equal', () => {
    const { value, int } = recipes(37);
    // the values a check that reads primitives apart from containers could take another way than the relation
    const sample = function sample() { return 1; };
    const flat = [Symbol('a'), Symbol('a'), 'a', new String('a'), 1, new Number(1), new Number(1), 1n, Object(1n), true, new Boolean(true),
      NaN, new Number(NaN), sample, Object.create(Function.prototype), function sample() { return 1; }];
    let unique = 0;
    let repeated = 0;
    for (let i = 0; i < 2000; i++) {
      const pool = Array.from({ length: 1 + int(5) }, value);
      // across the check's 8-item switch, with builds of one recipe and one reference twice
      const list = [];
      for (let k = int(13); k > 0; k--) {
        const roll = int(10);
        list.push(roll < 2 && list.length ? list[int(list.length)] : roll < 4 ? flat[int(flat.length)] : pool[int(pool.length)].make());
      }
      const want = list.every((a, at) => list.every((b, to) => at >= to || !equalsDeep(a, b)));
      assert.equal(isUniqueDeepArray(list), want, `list ${i} of ${list.length}`);
      assert.equal(isUniqueDeepArray(list.slice().reverse()), want, `list ${i} of ${list.length}, reversed`);
      if (want) unique++;
      else repeated++;
    }
    assert.ok(unique > 300, `${unique} unique lists`);
    assert.ok(repeated > 300, `${repeated} lists with a repeat`);
    // every two of those values alone, in each order, among unique items on both sides of the switch
    flat.forEach((a, at) => flat.forEach((b, to) => {
      if (at === to) return;
      const want = !equalsDeep(a, b);
      assert.equal(isUniqueDeepArray([a, b]), want, `values ${at} and ${to}`);
      assert.equal(isUniqueDeepArray(['p1', a, 'p2', {}, b, [], 'p3', 2, 3, 4]), want, `values ${at} and ${to} among 10`);
    }));
  });
});
