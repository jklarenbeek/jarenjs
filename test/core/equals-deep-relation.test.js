//@ts-check
/**
 * @file `equalsDeep` is one relation, the same in both orders, that tells
 * apart values whose state is not in their own enumerable members. A symbol
 * equals only itself, a function another function of its text and no object,
 * a wrapper object no primitive; two objects are equal when their prototypes
 * name one constructor, the state their kind keeps in a slot of its own is
 * equal (a wrapper's primitive, a Date's instant, a RegExp's source and
 * flags, a Map's entries, a Set's members, a buffer's or a DataView's bytes,
 * an error's name, message, cause and errors, the length of an array that
 * is no plain one) and their own enumerable members are. `isUniqueDeepArray`
 * answers by the same relation on both sides of its 8-item switch, and a
 * pair nested past the compare's switch to its own stack answers as at the
 * root.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

import { equalsDeep, isUniqueDeepArray } from '@jarenjs/core/object';

const PAD = ['pad 1', 'pad 2', 'pad 3', 'pad 4', 'pad 5', 'pad 6', 'pad 7'];

/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nest = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

/**
 * One answer for a pair: in both orders, from the uniqueness check on both
 * sides of its 8-item switch in both orders, and nested 300 arrays deep,
 * where the compare walks on a stack of its own.
 * @param {string} label @param {any} a @param {any} b @param {boolean} equal
 */
function answers(label, a, b, equal) {
  assert.equal(equalsDeep(a, b), equal, label);
  assert.equal(equalsDeep(b, a), equal, `${label}, reversed`);
  assert.equal(isUniqueDeepArray([a, b]), !equal, `${label}, unique`);
  assert.equal(isUniqueDeepArray([b, a]), !equal, `${label}, unique reversed`);
  assert.equal(isUniqueDeepArray([a, ...PAD, b]), !equal, `${label}, unique among 9`);
  assert.equal(isUniqueDeepArray([b, ...PAD, a]), !equal, `${label}, unique among 9 reversed`);
  assert.equal(equalsDeep(nest(300, a), nest(300, b)), equal, `${label}, nested`);
  assert.equal(equalsDeep(nest(300, b), nest(300, a)), equal, `${label}, nested reversed`);
}

/** @param {[string, any, any, boolean][]} rows */
const all = (rows) => { for (const [label, a, b, equal] of rows) answers(label, a, b, equal); };

/**
 * The answer for two builds of one value, asked in a child with a time
 * limit: a compare that does not return fails the test here instead of
 * holding it.
 * @param {string} build - the body of a function that builds the value
 */
function answerInTime(build) {
  const script = `
    import { equalsDeep } from '@jarenjs/core/object';
    const build = () => { ${build} };
    process.stdout.write(String(equalsDeep(build(), build())));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 20000, cwd: new URL('../..', import.meta.url), env: { ...process.env, FORCE_COLOR: '0' } });
  assert.equal(child.status, 0, `the compare did not return in 20 s, or threw: ${child.stderr}`);
  return child.stdout;
}

/** `value` with an own non-enumerable member. @param {any} value @param {string} key @param {unknown} member */
const hidden = (value, key, member) => Object.defineProperty(value, key, { value: member, enumerable: false });
/** A buffer of `bytes`. @param {number[]} bytes */
const buffer = (...bytes) => Uint8Array.from(bytes).buffer;
/** A shared buffer of `bytes`. @param {number[]} bytes */
const shared = (...bytes) => {
  const memory = new SharedArrayBuffer(bytes.length);
  new Uint8Array(memory).set(bytes);
  return memory;
};
/** @param {unknown[]} list */
const args = function (...list) { return (function () { return arguments; })(...list); };

class Point { /** @param {number} x */ constructor(x) { this.x = x; } }
class Num extends Number {}
class Stamp extends Date {}
class Registry extends Map { get [Symbol.toStringTag]() { return 'Registry'; } }
class Named extends Map {
  /** @param {string} name @param {[any, any][]} [entries] */
  constructor(name, entries) { super(entries); this.name = name; }
}
class Bag extends Set {}
class Bytes extends Uint8Array {}
class Sub extends Array {}
class Refusal extends Error {}

const symbol = Symbol('a');
const f = function f() { return 1; };
const twin = function f() { return 1; };
const other = function f() { return 2; };

describe('equalsDeep keeps its answers on undefined, NaN, the two zeros and JSON values', () => {
  it('reads undefined as equal to itself only, and a member holding it as present', () => {
    all([
      ['undefined, undefined', undefined, undefined, true],
      ['undefined, null', undefined, null, false],
      ['{ a: undefined }, {}', { a: undefined }, {}, false],
      ['{ a: undefined }, { b: undefined }', { a: undefined }, { b: undefined }, false],
      ['{ a: undefined }, { a: undefined }', { a: undefined }, { a: undefined }, true],
      ['[undefined], [null]', [undefined], [null], false],
      ['[undefined], a hole', [undefined], new Array(1), true],
      ['a Map holding undefined at two keys', new Map([['k', undefined]]), new Map([['j', undefined]]), false],
      ['a Map holding undefined at one key', new Map([['k', undefined]]), new Map([['k', undefined]]), true],
    ]);
  });

  it('reads NaN as unlike itself and -0 as 0, at the root and inside a value', () => {
    all([
      ['NaN, NaN', NaN, NaN, false],
      ['0, -0', 0, -0, true],
      ['{ a: NaN } twice', { a: NaN }, { a: NaN }, false],
      ['[0], [-0]', [0], [-0], true],
      ['1, 1n', 1, 1n, false],
      ['1n, 1n', 1n, 1n, true],
    ]);
  });

  it('compares JSON values by type, members and elements', () => {
    all([
      ['null, null', null, null, true],
      ['null, {}', null, {}, false],
      ['"1", 1', '1', 1, false],
      ['true, 1', true, 1, false],
      ['[], {}', [], {}, false],
      ['{ a: 1, b: [2] } in two key orders', { a: 1, b: [2] }, { b: [2], a: 1 }, true],
      ['{ a: 1 }, { a: 1, b: 2 }', { a: 1 }, { a: 1, b: 2 }, false],
      ['[1, [2]], [1, [3]]', [1, [2]], [1, [3]], false],
      ['[1, 2], [2, 1]', [1, 2], [2, 1], false],
    ]);
  });
});

describe('equalsDeep reads a symbol, a function and a wrapper object one way in both orders', () => {
  it('takes a symbol as equal to itself only', () => {
    all([
      ['two symbols of one description', Symbol('a'), Symbol('a'), false],
      ['two symbols', Symbol('a'), Symbol('b'), false],
      ['one symbol', symbol, symbol, true],
      ['one registered symbol', Symbol.for('a'), Symbol.for('a'), true],
      ['a symbol, its description', Symbol('a'), 'a', false],
      ['a symbol, an object', Symbol('a'), {}, false],
      ['a symbol, its wrapper', symbol, Object(symbol), false],
      ['two symbols as members', { a: Symbol('a') }, { a: Symbol('a') }, false],
      ['one symbol as a member', { a: symbol }, { a: symbol }, true],
    ]);
  });

  it('takes a function as equal to a function of its text and to no object', () => {
    all([
      ['two functions of one text', f, twin, true],
      ['two functions of two texts', f, other, false],
      ['a function, an object over Function.prototype', f, Object.create(Function.prototype), false],
      ['a function, an object', f, {}, false],
      ['a function, its text', f, String(f), false],
      ['a function, a null-prototype object', f, Object.create(null), false],
      ['two objects over Function.prototype', Object.create(Function.prototype), Object.create(Function.prototype), true],
    ]);
  });

  it('never takes a wrapper object as equal to a primitive', () => {
    all([
      ['new Number(1), 1', new Number(1), 1, false],
      ['new String("ab"), "ab"', new String('ab'), 'ab', false],
      ['new String(""), ""', new String(''), '', false],
      ['new Boolean(true), true', new Boolean(true), true, false],
      ['new Boolean(false), false', new Boolean(false), false, false],
      ['Object(1n), 1n', Object(1n), 1n, false],
      ['Object(symbol), symbol', Object(symbol), symbol, false],
    ]);
  });

  it('takes two wrappers of one class as equal exactly when their primitives are', () => {
    all([
      ['new Number(1) twice', new Number(1), new Number(1), true],
      ['new Number(1), new Number(2)', new Number(1), new Number(2), false],
      ['new Number(NaN) twice', new Number(NaN), new Number(NaN), false],
      ['new Number(0), new Number(-0)', new Number(0), new Number(-0), true],
      ['new String("ab") twice', new String('ab'), new String('ab'), true],
      ['new String("ab"), new String("cd")', new String('ab'), new String('cd'), false],
      ['new Boolean(true) twice', new Boolean(true), new Boolean(true), true],
      ['new Boolean(true), new Boolean(false)', new Boolean(true), new Boolean(false), false],
      ['Object(1n) twice', Object(1n), Object(1n), true],
      ['Object(1n), Object(2n)', Object(1n), Object(2n), false],
      ['Object(symbol) twice', Object(symbol), Object(symbol), true],
      ['the wrappers of two symbols', Object(Symbol('a')), Object(Symbol('a')), false],
      ['new Number(1), new String("1")', new Number(1), new String('1'), false],
      ['a Number subclass twice', new Num(1), new Num(1), true],
      ['a Number subclass of two numbers', new Num(1), new Num(2), false],
      ['a Number subclass, a Number', new Num(1), new Number(1), false],
      ['a wrapper with a member that differs', Object.assign(new Number(1), { x: 1 }), Object.assign(new Number(1), { x: 2 }), false],
      ['a wrapper with one member', Object.assign(new Number(1), { x: 1 }), Object.assign(new Number(1), { x: 1 }), true],
      ['an object over Number.prototype, a wrapper', Object.create(Number.prototype), new Number(0), false],
      ['two objects over Number.prototype', Object.create(Number.prototype), Object.create(Number.prototype), true],
    ]);
  });
});

describe('equalsDeep compares the state a built-in keeps outside its members', () => {
  it('compares two Dates by instant and by their own members', () => {
    all([
      ['one instant', new Date(1), new Date(1), true],
      ['two instants', new Date(1), new Date(2), false],
      ['two invalid Dates', new Date(NaN), new Date(NaN), true],
      ['one instant, a member that differs', Object.assign(new Date(1), { x: 1 }), Object.assign(new Date(1), { x: 2 }), false],
      ['a Date subclass of one instant', new Stamp(1), new Stamp(1), true],
      ['a Date subclass of two instants', new Stamp(1), new Stamp(2), false],
      ['a Date subclass, a Date', new Stamp(1), new Date(1), false],
      ['an object over Date.prototype, a Date', Object.create(Date.prototype), new Date(1), false],
      ['two objects over Date.prototype', Object.create(Date.prototype), Object.create(Date.prototype), true],
      ['a Date, its instant', new Date(1), 1, false],
      ['a Date, an object', new Date(1), {}, false],
    ]);
  });

  it('compares two RegExps by source and flags and by their own members', () => {
    all([
      ['one source, one flag', /a/g, /a/g, true],
      ['two flags', /a/g, /a/i, false],
      ['two sources', /a/, /b/, false],
      ['a member that differs', Object.assign(/a/, { x: 1 }), Object.assign(/a/, { x: 2 }), false],
      ['an object over RegExp.prototype, a RegExp', Object.create(RegExp.prototype), /a/, false],
    ]);
  });

  it('compares two Maps by their entries, keys by identity, and by their own members', () => {
    const key = { a: 1 };
    all([
      ['one entry', new Map([[1, 2]]), new Map([[1, 2]]), true],
      ['a value that differs', new Map([[1, 2]]), new Map([[1, 3]]), false],
      ['a value compared deeply', new Map([[1, { a: [1] }]]), new Map([[1, { a: [1] }]]), true],
      ['a deep value that differs', new Map([[1, { a: [1] }]]), new Map([[1, { a: [2] }]]), false],
      ['two orders', new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]), true],
      ['two sizes', new Map([[1, 2]]), new Map([[1, 2], [2, 2]]), false],
      ['one object as the key', new Map([[key, 1]]), new Map([[key, 1]]), true],
      ['a member that differs', Object.assign(new Map(), { x: 1 }), Object.assign(new Map(), { x: 2 }), false],
      ['a Map subclass with its own tag, a value that differs', new Registry([[1, 2]]), new Registry([[1, 3]]), false],
      ['a Map subclass with its own tag, one entry', new Registry([[1, 2]]), new Registry([[1, 2]]), true],
      ['a Map subclass, a member that differs', new Named('a'), new Named('b'), false],
      ['a Map subclass, a value that differs', new Named('a', [[1, 2]]), new Named('a', [[1, 3]]), false],
      ['a Map subclass, one member and one entry', new Named('a', [[1, 2]]), new Named('a', [[1, 2]]), true],
      ['a Map subclass, a Map', new Registry([[1, 2]]), new Map([[1, 2]]), false],
      ['an object over Map.prototype, a Map', Object.create(Map.prototype), new Map(), false],
    ]);
  });

  it('compares two Sets by their members and by their own members', () => {
    const member = { a: 1 };
    all([
      ['one member', new Set([1]), new Set([1]), true],
      ['two members', new Set([1]), new Set([2]), false],
      ['two orders', new Set([1, 2]), new Set([2, 1]), true],
      ['two sizes', new Set([1]), new Set([1, 2]), false],
      ['one object as the member', new Set([member]), new Set([member]), true],
      ['a member of its own that differs', Object.assign(new Set(), { x: 1 }), Object.assign(new Set(), { x: 2 }), false],
      ['a Set subclass, two members', new Bag([1]), new Bag([2]), false],
      ['a Set subclass, one member', new Bag([1]), new Bag([1]), true],
      ['an object over Set.prototype, a Set', Object.create(Set.prototype), new Set(), false],
    ]);
  });

  it('compares two typed arrays of one class by their elements', () => {
    all([
      ['one element', new Uint8Array([1]), new Uint8Array([1]), true],
      ['an element that differs', new Uint8Array([1]), new Uint8Array([2]), false],
      ['two lengths', new Uint8Array([1]), new Uint8Array([1, 1]), false],
      ['two classes', new Uint8Array([1]), new Int8Array([1]), false],
      ['a typed array, an array', new Uint8Array([1]), [1], false],
      ['NaN as an element', new Float64Array([NaN]), new Float64Array([NaN]), false],
      ['a subclass, an element that differs', new Bytes([1]), new Bytes([2]), false],
      ['a subclass, one element', new Bytes([1]), new Bytes([1]), true],
      ['an object over Uint8Array.prototype, a typed array', Object.create(Uint8Array.prototype), new Uint8Array(0), false],
    ]);
  });

  it('compares two buffers, and two DataViews, by their bytes', () => {
    const detached = new ArrayBuffer(1);
    structuredClone(detached, { transfer: [detached] });
    all([
      ['one byte', buffer(1), buffer(1), true],
      ['a byte that differs', buffer(1), buffer(2), false],
      ['two lengths', new ArrayBuffer(1), new ArrayBuffer(2), false],
      ['a member that differs', Object.assign(buffer(1), { x: 1 }), Object.assign(buffer(1), { x: 2 }), false],
      ['a detached buffer, an empty one', detached, new ArrayBuffer(0), true],
      ['a detached buffer, one byte', detached, buffer(0), false],
      ['a shared buffer, one byte', shared(1), shared(1), true],
      ['a shared buffer, a byte that differs', shared(1), shared(2), false],
      ['a buffer, a shared buffer', buffer(1), shared(1), false],
      ['an object over ArrayBuffer.prototype, a buffer', Object.create(ArrayBuffer.prototype), new ArrayBuffer(0), false],
      ['a view of one byte', new DataView(buffer(1)), new DataView(buffer(1)), true],
      ['a view of a byte that differs', new DataView(buffer(1)), new DataView(buffer(2)), false],
      ['two views of two lengths', new DataView(buffer(1)), new DataView(buffer(1, 1)), false],
      ['two views that show the same byte of two buffers', new DataView(buffer(1, 2), 1), new DataView(buffer(2)), true],
      ['a view, a typed array', new DataView(buffer(1)), new Uint8Array([1]), false],
    ]);
  });

  it('compares two errors by name, message, cause, errors and their own members', () => {
    /** @param {unknown} cause */
    const looped = (cause) => { const error = new Error('a'); error.cause = cause ?? error; return error; };
    all([
      ['one message', new Error('a'), new Error('a'), true],
      ['two messages', new Error('a'), new Error('b'), false],
      ['a TypeError of two messages', new TypeError('a'), new TypeError('b'), false],
      ['two classes', new Error('a'), new TypeError('a'), false],
      ['a subclass of two messages', new Refusal('a'), new Refusal('b'), false],
      ['a subclass of one message', new Refusal('a'), new Refusal('a'), true],
      ['two names', Object.assign(new Error('a'), { name: 'X' }), Object.assign(new Error('a'), { name: 'Y' }), false],
      ['a member that differs', Object.assign(new Error('a'), { code: 1 }), Object.assign(new Error('a'), { code: 2 }), false],
      ['one member', Object.assign(new Error('a'), { code: 1 }), Object.assign(new Error('a'), { code: 1 }), true],
      ['two causes', new Error('a', { cause: 1 }), new Error('a', { cause: 2 }), false],
      ['a cause compared deeply', new Error('a', { cause: { at: [1] } }), new Error('a', { cause: { at: [1] } }), true],
      ['a cause, none', new Error('a', { cause: 1 }), new Error('a'), false],
      ['an AggregateError of two lists', new AggregateError([1], 'a'), new AggregateError([2], 'a'), false],
      ['an AggregateError of one list', new AggregateError([{ a: 1 }], 'a'), new AggregateError([{ a: 1 }], 'a'), true],
      ['two errors that are their own cause', looped(), looped(), true],
      ['an error that is its own cause, one caused by another', looped(), looped(new Error('b')), false],
    ]);
  });

  it('compares an array that is no plain one by its length and its members', () => {
    all([
      ['an Array subclass, one element', Sub.from([1]), Sub.from([1]), true],
      ['an Array subclass, an element that differs', Sub.from([1]), Sub.from([2]), false],
      ['an Array subclass of two lengths, no element', new Sub(3), new Sub(5), false],
      ['an Array subclass of one length, no element', new Sub(3), new Sub(3), true],
      ['an Array subclass: undefined, a hole', Sub.from([undefined]), new Sub(1), false],
      ['an Array subclass, an array', Sub.from([1]), [1], false],
    ]);
  });
});

describe('equalsDeep compares every other object by its own enumerable members', () => {
  it('compares class instances, null-prototype objects and arguments by constructor and members', () => {
    all([
      ['one class, one member', new Point(1), new Point(1), true],
      ['one class, a member that differs', new Point(1), new Point(2), false],
      ['a class instance, an object of its members', new Point(1), { x: 1 }, false],
      ['two null-prototype objects', Object.create(null), Object.create(null), true],
      ['two null-prototype objects of one member', Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 }), true],
      ['two null-prototype objects, a member that differs', Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 2 }), false],
      ['a null-prototype object, an object', Object.assign(Object.create(null), { a: 1 }), { a: 1 }, false],
      ['arguments twice', args(1, 2), args(1, 2), true],
      ['arguments, an array', args(1, 2), [1, 2], false],
    ]);
  });

  it('reads an accessor for its value and a non-enumerable member as no member, in both orders', () => {
    all([
      ['a getter, a member of its value', { get a() { return 1; } }, { a: 1 }, true],
      ['two getters of two values', { get a() { return 1; } }, { get a() { return 2; } }, false],
      ['{ a: 1 }, { b: 2 } hiding a: 1', { a: 1 }, hidden({ b: 2 }, 'a', 1), false],
      ['{ a: 1 } hiding b: 2, { b: 2 } hiding a: 1', hidden({ a: 1 }, 'b', 2), hidden({ b: 2 }, 'a', 1), false],
      ['{ a: 1 }, { a: 1 } hiding b: 2', { a: 1 }, hidden({ a: 1 }, 'b', 2), true],
      ['a class instance, one of another member hiding the first', new Point(1), hidden(Object.assign(Object.create(Point.prototype), { y: 2 }), 'x', 1), false],
      ['two key orders, one member hidden on one side', { a: 1, b: 2 }, hidden({ b: 2, c: 3 }, 'a', 1), false],
    ]);
  });

  it('reads the members of a long object in any order, a non-enumerable one as no member', () => {
    /** 40 members, in order or reversed, `swap` replaced by a member `other`. @param {boolean} reversed @param {string} [swap] */
    const long = (reversed, swap) => {
      const names = Array.from({ length: 40 }, (_, i) => `member ${i}`);
      if (reversed) names.reverse();
      /** @type {Record<string, unknown>} */
      const object = {};
      for (const name of names) object[name === swap ? 'other' : name] = name;
      return object;
    };
    all([
      ['40 members in one order', long(false), long(false), true],
      ['40 members in two orders', long(false), long(true), true],
      ['40 members, one of another name', long(false), long(true, 'member 7'), false],
      ['40 members, one hidden where the other lists it', long(false), hidden(long(true, 'member 7'), 'member 7', 'member 7'), false],
      ['40 members, one hidden on both sides', hidden(long(false, 'member 7'), 'member 7', 1), hidden(long(true, 'member 7'), 'member 7', 2), true],
    ]);
  });

  it('reads a Proxy by what its traps show', () => {
    all([
      ['a Proxy of an object, the object', new Proxy({ a: 1 }, {}), { a: 1 }, true],
      ['two Proxies of two objects', new Proxy({ a: 1 }, {}), new Proxy({ a: 2 }, {}), false],
      ['a Proxy of an array, the array', new Proxy([1], {}), [1], true],
      ['a Proxy of a Map, the Map', new Proxy(new Map([[1, 2]]), {}), new Map([[1, 2]]), false],
      ['a Proxy of a Date, the Date', new Proxy(new Date(1), {}), new Date(1), false],
      ['a Proxy of a function, the function', new Proxy(f, {}), f, false],
    ]);
  });

  it('reads a built-in of another realm by its state as one of this realm', () => {
    const realm = vm.createContext({});
    /** @param {string} code */
    const foreign = (code) => vm.runInContext(code, realm);
    all([
      ['two Dates of one instant', foreign('new Date(1)'), foreign('new Date(1)'), true],
      ['two Dates of two instants', foreign('new Date(1)'), foreign('new Date(2)'), false],
      ['a Date of each realm', foreign('new Date(1)'), new Date(1), false],
      ['two Maps, a value that differs', foreign('new Map([[1, 2]])'), foreign('new Map([[1, 3]])'), false],
      ['two Maps of one entry', foreign('new Map([[1, 2]])'), foreign('new Map([[1, 2]])'), true],
      ['two Sets of two members', foreign('new Set([1])'), foreign('new Set([2])'), false],
      ['two RegExps of two sources', foreign('/a/'), foreign('/b/'), false],
      ['two wrappers of two numbers', foreign('new Number(1)'), foreign('new Number(2)'), false],
      ['two buffers, a byte that differs', foreign('Uint8Array.from([1]).buffer'), foreign('Uint8Array.from([2]).buffer'), false],
      ['two typed arrays, an element that differs', foreign('new Uint8Array([1])'), foreign('new Uint8Array([2])'), false],
      ['two errors of two messages', foreign('new TypeError("a")'), foreign('new TypeError("b")'), false],
      ['two errors of one message', foreign('new TypeError("a")'), foreign('new TypeError("a")'), true],
      ['two objects of one member', foreign('({ a: 1 })'), foreign('({ a: 1 })'), true],
      ['an object of each realm', foreign('({ a: 1 })'), { a: 1 }, false],
      ['two arrays, an element that differs', foreign('[1]'), foreign('[2]'), false],
      ['two arrays of two lengths, no element', foreign('new Array(3)'), foreign('new Array(5)'), false],
      ['two arrays: a hole, undefined', foreign('[1,,]'), foreign('[1, undefined]'), false],
    ]);
  });
});

describe('equalsDeep compares a cycle however many members lead into it', () => {
  it('answers for a cycle two members lead back into', () => {
    /** @param {unknown} [z] */
    const two = (z) => { /** @type {any} */ const a = { z }; a.x = a; a.y = a; return a; };
    /** @param {number} [n] */
    const tree = (n = 1) => {
      /** @type {any} */
      const top = { kids: [] };
      for (let i = 0; i < 3; i++) top.kids.push({ parent: top, top, n: i * n });
      return top;
    };
    const list = () => { /** @type {any[]} */ const a = []; a.push(a, a, a); return a; };
    /** @param {unknown} [z] */
    const map = (z) => { const m = new Map(); m.set('a', m).set('b', m).set('z', z); return m; };
    assert.equal(answerInTime('const a = {}; a.x = a; a.y = a; return a;'), 'true');
    assert.equal(answerInTime('const top = { kids: [] }; for (let i = 0; i < 3; i++) top.kids.push({ parent: top, top }); return top;'), 'true');
    all([
      ['an object two members lead back to', two(), two(), true],
      ['an object two members lead back to, a member that differs', two(1), two(2), false],
      ['a tree whose nodes hold their parent', tree(), tree(), true],
      ['a tree whose nodes hold their parent, a node that differs', tree(1), tree(2), false],
      ['an array holding itself three times', list(), list(), true],
      ['a Map holding itself at two keys', map(), map(), true],
      ['a Map holding itself at two keys, a value that differs', map(1), map(2), false],
    ]);
  });

  it('compares a value holding many members nested past 256 levels, and reads one that holds few once', () => {
    /** `count` members nested 300 deep around `leaf`. @param {number} count @param {unknown} [leaf] */
    const deep = (count, leaf = 1) => Array.from({ length: count }, (_, i) => nest(300, i === count - 1 ? leaf : i));
    all([
      ['two deep members', deep(2), deep(2), true],
      ['two deep members, the last differs at the bottom', deep(2), deep(2, 'other'), false],
      ['nine deep members', deep(9), deep(9), true],
      ['nine deep members, the last differs at the bottom', deep(9), deep(9, 'other'), false],
    ]);
    // a compare carries on from a deep pair where it is: what stands before it is read once
    let reads = 0;
    const counted = () => ({ get first() { reads++; return 1; }, deep: nest(300, 1) });
    assert.equal(equalsDeep(counted(), counted()), true);
    assert.equal(reads, 2, 'one read on each side');
  });

  it('compares a cause a host assigned once, with the members', () => {
    /** @param {number} length @param {string} last */
    const chain = (length, last) => {
      /** @type {any} */
      let error = new Error(last);
      for (let i = 0; i < length; i++) {
        const outer = new Error('outer');
        // an assigned cause is an enumerable member, where the constructor's option is not
        outer.cause = error;
        error = outer;
      }
      return error;
    };
    assert.equal(answerInTime(`let error = new Error('a');
      for (let i = 0; i < 60; i++) { const outer = new Error('outer'); outer.cause = error; error = outer; }
      return error;`), 'true');
    all([
      ['a chain of 60 assigned causes', chain(60, 'a'), chain(60, 'a'), true],
      ['a chain of 60 assigned causes, the last message differs', chain(60, 'a'), chain(60, 'b'), false],
      ['an assigned cause, the option', chain(1, 'a'), new Error('outer', { cause: new Error('a') }), false],
    ]);
  });
});

describe('equalsDeep reads what a value shows', () => {
  it('takes as equal two values that differ only in state it cannot read or does not read', () => {
    class Sealed {
      #x;
      /** @param {number} x */
      constructor(x) { this.#x = x; }
      get x() { return this.#x; }
    }
    all([
      // a function is its text
      ['two bound functions', f.bind(null, 1), other.bind(null, 2), true],
      ['two functions of one text, a member that differs', Object.assign(function g() {}, { x: 1 }), Object.assign(function g() {}, { x: 2 }), true],
      ['two Proxies of two functions', new Proxy(f, {}), new Proxy(other, {}), true],
      // state the host keeps to itself
      ['two instances of two private fields', new Sealed(1), new Sealed(2), true],
      ['two promises', Promise.resolve(1), Promise.resolve(2), true],
      ['two WeakMaps', new WeakMap(), new WeakMap([[{}, 1]]), true],
      ['two Proxies of two Maps', new Proxy(new Map([[1, 2]]), {}), new Proxy(new Map([[1, 3]]), {}), true],
      // members it does not read
      ['two arrays, a named member that differs', Object.assign([1], { x: 1 }), Object.assign([1], { x: 2 }), true],
      ['two typed arrays, a named member that differs', Object.assign(new Uint8Array([1]), { x: 1 }), Object.assign(new Uint8Array([1]), { x: 2 }), true],
      ['two objects, a non-enumerable member that differs', hidden({}, 'a', 1), hidden({}, 'a', 2), true],
      ['two objects, a symbol-keyed member that differs', { [symbol]: 1 }, { [symbol]: 2 }, true],
      ['two RegExps at two positions', /a/g, Object.assign(/a/g, { lastIndex: 1 }), true],
    ]);
  });

  it('takes as unequal two Maps or Sets that hold equal objects as keys or members', () => {
    all([
      ['two Maps keyed by two equal objects', new Map([[{ a: 1 }, 1]]), new Map([[{ a: 1 }, 1]]), false],
      ['two Sets of two equal objects', new Set([{ a: 1 }]), new Set([{ a: 1 }]), false],
    ]);
  });
});
