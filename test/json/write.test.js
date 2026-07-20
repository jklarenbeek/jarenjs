import { describe, it } from 'node:test';
import { strictEqual, notStrictEqual, deepStrictEqual } from 'node:assert';
import * as assert from '../assert.node.js';

import {
  compileJSONPointerSetter,
  compileJSONPointerInserter,
  setAtJSONPointer,
  insertAtJSONPointer,
  removeAtJSONPointer,
  compileJSONPathSetter,
  setAtJSONPath,
  insertAtJSONPath,
  removeAtJSONPath,
  JsonWriteError,
  jsonPointerFromJSONPath,
  jsonPathFromJSONPointer,
  JSONPathSyntaxError,
  JSONPointerSyntaxError,
} from '@jarenjs/json';

function makeStore() {
  return {
    store: {
      book: [
        { title: 'A', price: 10 },
        { title: 'B', price: 20 },
        { title: 'C', price: 30 },
      ],
      bicycle: { color: 'red', price: 399 },
    },
    meta: { tags: ['x'] },
  };
}

//#region pointer-addressed writers

describe('compileJSONPointerSetter', () => {
  it('replaces a member copy-on-write, sharing untouched subtrees', () => {
    const doc = makeStore();
    const set = compileJSONPointerSetter('/store/bicycle/color');
    const out = set(doc, 'blue');
    strictEqual(out.store.bicycle.color, 'blue');
    strictEqual(doc.store.bicycle.color, 'red');
    strictEqual(out.store.book, doc.store.book);
    strictEqual(out.meta, doc.meta);
    notStrictEqual(out.store, doc.store);
  });

  it('creates a missing final member, but not missing parents', () => {
    deepStrictEqual(setAtJSONPointer({ a: {} }, '/a/b', 1), { a: { b: 1 } });
    assert.throws(() => setAtJSONPointer({ a: {} }, '/x/y', 1), (e) => {
      return e instanceof JsonWriteError && e.code === 'JW2001' && e.dataPath === '/x/y';
    });
  });

  it('replaces an array element, extends by one at length, rejects beyond', () => {
    deepStrictEqual(setAtJSONPointer([1, 2], '/1', 9), [1, 9]);
    deepStrictEqual(setAtJSONPointer([1, 2], '/2', 3), [1, 2, 3]);
    deepStrictEqual(setAtJSONPointer([1, 2], '/-', 3), [1, 2, 3]);
    assert.throws(() => setAtJSONPointer([1, 2], '/5', 9), (e) => e.code === 'JW2002');
    assert.throws(() => setAtJSONPointer([1, 2], '/01', 9), (e) => e.code === 'JW2002');
  });

  it('supports updater functions with the old value and location', () => {
    const doc = makeStore();
    const out = setAtJSONPointer(doc, '/store/bicycle/price', (old, loc) => {
      strictEqual(old, 399);
      strictEqual(loc, '/store/bicycle/price');
      return old * 2;
    });
    strictEqual(out.store.bicycle.price, 798);
    // an updater at a created member sees undefined
    const created = setAtJSONPointer({ a: {} }, '/a/n', (old) => (old === undefined ? 1 : old + 1));
    strictEqual(created.a.n, 1);
  });

  it('accepts a normalized path or any singular query as the target', () => {
    const doc = makeStore();
    strictEqual(setAtJSONPointer(doc, "$['store']['book'][0]['title']", 'A2').store.book[0].title, 'A2');
    strictEqual(setAtJSONPointer(doc, '$.store.book[0].title', 'A3').store.book[0].title, 'A3');
    // typed steps address arrays only with index selectors: a name
    // selector like ['0'] is never a valid array position
    assert.throws(() => setAtJSONPointer(doc, "$.store.book['0']", 'X'), (e) => e.code === 'JW2002');
  });

  it('resolves negative indexes in singular-query targets from the end', () => {
    const doc = makeStore();
    strictEqual(setAtJSONPointer(doc, '$.store.book[-1].title', 'Z').store.book[2].title, 'Z');
  });

  it('replaces the whole document at the root target', () => {
    strictEqual(setAtJSONPointer({ a: 1 }, '', 5), 5);
    strictEqual(setAtJSONPointer({ a: 1 }, '$', 5), 5);
    strictEqual(setAtJSONPointer({ a: 1 }, '', (old) => old.a + 1), 2);
  });

  it('mutates in place with { mutate: true }', () => {
    const doc = makeStore();
    const out = setAtJSONPointer(doc, '/store/bicycle/color', 'blue', { mutate: true });
    strictEqual(out, doc);
    strictEqual(doc.store.bicycle.color, 'blue');
  });

  it('rejects non-singular query targets (JW0001)', () => {
    assert.throws(() => compileJSONPointerSetter('$..price'), (e) => {
      return e instanceof JsonWriteError && e.code === 'JW0001';
    });
    assert.throws(() => compileJSONPointerSetter('$.store.book[*]'), (e) => e.code === 'JW0001');
    assert.throws(() => compileJSONPointerSetter(null), (e) => e.code === 'JW0001');
    assert.throws(() => compileJSONPointerSetter('store/book'), JSONPointerSyntaxError);
  });

  it('does not pollute prototypes through __proto__ members', () => {
    const out = setAtJSONPointer({}, '/__proto__', { polluted: true });
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(out), Object.prototype);
  });
});

describe('compileJSONPointerInserter', () => {
  it('inserts into arrays with shift and appends with -', () => {
    const doc = { list: [1, 2, 3] };
    deepStrictEqual(insertAtJSONPointer(doc, '/list/1', 9).list, [1, 9, 2, 3]);
    deepStrictEqual(insertAtJSONPointer(doc, '/list/-', 9).list, [1, 2, 3, 9]);
    deepStrictEqual(insertAtJSONPointer(doc, '/list/3', 9).list, [1, 2, 3, 9]);
    deepStrictEqual(doc.list, [1, 2, 3]);
    assert.throws(() => insertAtJSONPointer(doc, '/list/9', 9), (e) => e.code === 'JW2002');
  });

  it('sets object members and replaces the root', () => {
    deepStrictEqual(insertAtJSONPointer({ a: 1 }, '/b', 2), { a: 1, b: 2 });
    deepStrictEqual(insertAtJSONPointer({ a: 1 }, '', [1]), [1]);
  });

  it('a compiled inserter is reusable across documents', () => {
    const insert = compileJSONPointerInserter('/list/0');
    deepStrictEqual(insert({ list: [2] }, 1).list, [1, 2]);
    deepStrictEqual(insert({ list: [] }, 1).list, [1]);
  });
});

describe('compileJSONPointerRemover', () => {
  it('removes members and array elements copy-on-write', () => {
    const doc = makeStore();
    const out = removeAtJSONPointer(doc, '/store/book/1');
    deepStrictEqual(out.store.book.map((b) => b.title), ['A', 'C']);
    deepStrictEqual(doc.store.book.map((b) => b.title), ['A', 'B', 'C']);
    strictEqual(out.store.bicycle, doc.store.bicycle);
    deepStrictEqual(removeAtJSONPointer({ a: 1, b: 2 }, '/a'), { b: 2 });
  });

  it('requires the location to exist and rejects the root and -', () => {
    assert.throws(() => removeAtJSONPointer({ a: 1 }, '/b'), (e) => e.code === 'JW2001');
    assert.throws(() => removeAtJSONPointer([1], '/1'), (e) => e.code === 'JW2001');
    assert.throws(() => removeAtJSONPointer([1], '/-'), (e) => e.code === 'JW2002');
    assert.throws(() => removeAtJSONPointer({ a: 1 }, ''), (e) => e.code === 'JW2003');
    assert.throws(() => removeAtJSONPointer({ a: 1 }, '$'), (e) => e.code === 'JW2003');
  });

  it('removes the last element via a negative singular-query index', () => {
    const doc = makeStore();
    deepStrictEqual(removeAtJSONPointer(doc, '$.store.book[-1]').store.book.map((b) => b.title), ['A', 'B']);
  });
});

//#endregion

//#region JSONPath-selected writers

describe('compileJSONPathSetter', () => {
  it('sets every matched node, sharing everything off the written spines', () => {
    const doc = makeStore();
    const zero = compileJSONPathSetter('$..price');
    const out = zero(doc, 0);
    deepStrictEqual(out.store.book.map((b) => b.price), [0, 0, 0]);
    strictEqual(out.store.bicycle.price, 0);
    deepStrictEqual(doc.store.book.map((b) => b.price), [10, 20, 30]);
    strictEqual(out.meta, doc.meta);
  });

  it('supports updater functions with the normalized path', () => {
    const doc = makeStore();
    const seen = [];
    const out = setAtJSONPath(doc, '$.store.book[*].price', (old, path) => {
      seen.push(path);
      return old * 1.5;
    });
    deepStrictEqual(out.store.book.map((b) => b.price), [15, 30, 45]);
    // reverse document order: descendants/later siblings first
    deepStrictEqual(seen, [
      "$['store']['book'][2]['price']",
      "$['store']['book'][1]['price']",
      "$['store']['book'][0]['price']",
    ]);
  });

  it('matching nothing is a no-op returning the input', () => {
    const doc = makeStore();
    strictEqual(setAtJSONPath(doc, '$.nope[*]', 1), doc);
  });

  it('an ancestor rewrite wins over rewrites inside it', () => {
    const doc = { a: { b: 1 } };
    const out = setAtJSONPath(doc, '$..*', 'flat');
    // both /a and /a/b match; bottom-up application leaves the ancestor's value
    deepStrictEqual(out, { a: 'flat' });
  });

  it('sets the root when the query is $', () => {
    strictEqual(setAtJSONPath({ a: 1 }, '$', 9), 9);
  });

  it('handles member names needing normalized-path escapes', () => {
    const doc = { "it's": { 'a\\b': { '\n\t': 1, '': 2 } } };
    const out = setAtJSONPath(doc, "$['it\\'s']['a\\\\b'].*", (v) => v * 10);
    deepStrictEqual(out, { "it's": { 'a\\b': { '\n\t': 10, '': 20 } } });
  });

  it('mutates in place with { mutate: true }', () => {
    const doc = makeStore();
    const out = setAtJSONPath(doc, '$..price', 0, { mutate: true });
    strictEqual(out, doc);
    strictEqual(doc.store.bicycle.price, 0);
  });
});

describe('compileJSONPathInserter', () => {
  it('inserts before every matched array element, shifts composing', () => {
    const doc = { list: ['a', 'b', 'c'] };
    // match elements 0 and 2; reverse order keeps both positions valid
    const out = insertAtJSONPath(doc, '$.list[0, 2]', 'X');
    deepStrictEqual(out.list, ['X', 'a', 'b', 'X', 'c']);
    deepStrictEqual(doc.list, ['a', 'b', 'c']);
  });

  it('replaces matched object members and is a no-op on no match', () => {
    const doc = { a: 1 };
    deepStrictEqual(insertAtJSONPath(doc, '$.a', 2), { a: 2 });
    strictEqual(insertAtJSONPath(doc, '$.b', 2), doc);
  });
});

describe('compileJSONPathRemover', () => {
  it('removes every matched node; multiple removals from one array compose', () => {
    const doc = makeStore();
    const out = removeAtJSONPath(doc, '$.store.book[?@.price > 15]');
    deepStrictEqual(out.store.book.map((b) => b.title), ['A']);
    deepStrictEqual(doc.store.book.map((b) => b.title), ['A', 'B', 'C']);
    strictEqual(out.store.bicycle, doc.store.bicycle);
  });

  it('removes nested matches bottom-up', () => {
    const doc = { a: { drop: 1, keep: { drop: 2 } }, drop: 3 };
    const out = removeAtJSONPath(doc, '$..drop');
    deepStrictEqual(out, { a: { keep: {} } });
  });

  it('handles descendant matches where an ancestor is also removed', () => {
    const doc = { a: { b: { c: 1 } }, x: { b: 2 } };
    // $..b matches /a/b and /x/b; also removing /a removes an ancestor first
    const out = removeAtJSONPath(doc, "$..['a', 'b']");
    deepStrictEqual(out, { x: {} });
  });

  it('slices and wildcards remove in reverse index order', () => {
    deepStrictEqual(removeAtJSONPath({ l: [1, 2, 3, 4, 5] }, '$.l[1:4]').l, [1, 5]);
    deepStrictEqual(removeAtJSONPath({ l: [1, 2, 3] }, '$.l[*]').l, []);
  });

  it('is a no-op on no match and rejects removing the root', () => {
    const doc = makeStore();
    strictEqual(removeAtJSONPath(doc, '$.nope'), doc);
    assert.throws(() => removeAtJSONPath(doc, '$'), (e) => e.code === 'JW2003');
  });
});

//#endregion

//#region normalized path <-> JSON Pointer bridge

describe('jsonPointerFromJSONPath', () => {
  it('converts normalized paths and singular queries to pointers', () => {
    strictEqual(jsonPointerFromJSONPath("$['store']['book'][0]"), '/store/book/0');
    strictEqual(jsonPointerFromJSONPath('$.store.book[0].title'), '/store/book/0/title');
    strictEqual(jsonPointerFromJSONPath('$'), '');
    strictEqual(jsonPointerFromJSONPath("$['a/b']['m~n']"), '/a~1b/m~0n');
    strictEqual(jsonPointerFromJSONPath("$['']"), '/');
  });

  it('rejects non-singular queries and negative indexes', () => {
    assert.throws(() => jsonPointerFromJSONPath('$..a'), JSONPathSyntaxError);
    assert.throws(() => jsonPointerFromJSONPath('$.a[*]'), JSONPathSyntaxError);
    assert.throws(() => jsonPointerFromJSONPath('$.a[-1]'), JSONPathSyntaxError);
  });
});

describe('jsonPathFromJSONPointer', () => {
  it('converts pointers to normalized paths with the digit-token convention', () => {
    strictEqual(jsonPathFromJSONPointer('/store/book/0'), "$['store']['book'][0]");
    strictEqual(jsonPathFromJSONPointer(''), '$');
    strictEqual(jsonPathFromJSONPointer('/a~1b/m~0n'), "$['a/b']['m~n']");
    strictEqual(jsonPathFromJSONPointer('/'), "$['']");
    // leading zeros are not indexes, so they stay name selectors
    strictEqual(jsonPathFromJSONPointer('/01'), "$['01']");
    strictEqual(jsonPathFromJSONPointer("/it's"), "$['it\\'s']");
  });

  it('round-trips through jsonPointerFromJSONPath', () => {
    for (const pointer of ['', '/a', '/a/0/b', '/a~0~1b', '/']) {
      strictEqual(jsonPointerFromJSONPath(jsonPathFromJSONPointer(pointer)), pointer);
    }
  });
});

//#endregion

//#region cross-cutting

describe('copy-on-write discipline', () => {
  it('clones a shared spine only once across matched locations', () => {
    const doc = { a: { b: { x: 1, y: 2 } } };
    const out = setAtJSONPath(doc, '$.a.b.*', 0);
    deepStrictEqual(out, { a: { b: { x: 0, y: 0 } } });
    deepStrictEqual(doc, { a: { b: { x: 1, y: 2 } } });
  });

  it('the input is untouched when a write fails (atomicity)', () => {
    const doc = { a: { b: [1] }, c: 2 };
    const snapshot = structuredClone(doc);
    assert.throws(() => setAtJSONPointer(doc, '/a/b/9', 0));
    deepStrictEqual(doc, snapshot);
  });
});

//#endregion

//#region parents: 'create'

describe("the parents: 'create' option", () => {
  it('grows missing containers along the spine, copy-on-write', () => {
    const set = compileJSONPointerSetter('/user/address/street', { parents: 'create' });
    const doc = { user: { name: 'Ada' }, other: { shared: true } };
    const next = set(doc, 'Main St 1');
    deepStrictEqual(next, {
      user: { name: 'Ada', address: { street: 'Main St 1' } },
      other: { shared: true },
    });
    deepStrictEqual(doc, { user: { name: 'Ada' }, other: { shared: true } }, 'input untouched');
    strictEqual(next.other, doc.other, 'untouched siblings shared');
  });

  it('infers arrays from index-shaped steps and objects otherwise', () => {
    const set = compileJSONPointerSetter('/lines/0/amount', { parents: 'create' });
    deepStrictEqual(set({}, 12), { lines: [{ amount: 12 }] });
    const deep = compileJSONPointerSetter('/a/0/b/0/c', { parents: 'create' });
    deepStrictEqual(deep({}, 'x'), { a: [{ b: [{ c: 'x' }] }] });
  });

  it('replaces scalars and null found on the spine', () => {
    const set = compileJSONPointerSetter('/a/b', { parents: 'create' });
    deepStrictEqual(set({ a: 5 }, 1), { a: { b: 1 } });
    deepStrictEqual(set({ a: null }, 1), { a: { b: 1 } });
    deepStrictEqual(set(42, 1), { a: { b: 1 } }, 'a scalar root is replaced');
  });

  it('still rejects sparse array creation past the end', () => {
    const set = compileJSONPointerSetter('/list/5/x', { parents: 'create' });
    assert.throws(() => set({ list: [] }, 1), JsonWriteError);
  });

  it('composes with mutate and the inserter', () => {
    const doc = { a: 1 };
    const set = compileJSONPointerSetter('/b/c', { parents: 'create', mutate: true });
    strictEqual(set(doc, 2), doc);
    deepStrictEqual(doc, { a: 1, b: { c: 2 } });
    const insert = compileJSONPointerInserter('/queue/-', { parents: 'create' });
    deepStrictEqual(insert({}, 'first'), { queue: ['first'] });
  });

  it('rejects unknown parents values and defaults to JW2001', () => {
    assert.throws(() => compileJSONPointerSetter('/a/b', { parents: 'grow' }), TypeError);
    assert.throws(() => compileJSONPointerSetter('/a/b')({}, 1), JsonWriteError);
  });
});

//#endregion
