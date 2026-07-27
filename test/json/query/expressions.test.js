import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery,
  queryJson,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

import {
  EMPTY,
  Seq,
  seqOf,
  appendItem,
  assertSeqInvariant,
} from '../../../packages/json/src/query/runtime.js';

// The bookstore example from RFC 9535, section 1.5
const bookstore = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
};

function runtimeFails(doc, data, code, docPath, externals) {
  assert.throws(() => queryJson(doc, data, externals), (e) => {
    assert.strictEqual(e instanceof JsonQueryRuntimeError, true, `expected JsonQueryRuntimeError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (docPath !== undefined)
      assert.strictEqual(e.docPath, docPath, `expected docPath '${docPath}', got '${e.docPath}'`);
    return true;
  });
}

describe('Jaren JSON Query expressions', () => {

  describe('sequence runtime invariants', () => {
    it('should build flat, well-formed sequence values', () => {
      assert.strictEqual(assertSeqInvariant(seqOf([])), EMPTY);
      assert.strictEqual(assertSeqInvariant(seqOf([7])), 7);
      const s = assertSeqInvariant(seqOf([1, 2, 3]));
      assert.strictEqual(s instanceof Seq, true);
      assert.deepStrictEqual(s.items, [1, 2, 3]);
    });

    it('should flatten through appendItem', () => {
      const acc = [];
      appendItem(acc, EMPTY);
      appendItem(acc, 1);
      appendItem(acc, seqOf([2, 3]));
      appendItem(acc, [4, 5]); // an array is ONE item
      assert.deepStrictEqual(acc, [1, 2, 3, [4, 5]]);
      assertSeqInvariant(seqOf(acc));
    });

    it('should detect invariant violations', () => {
      assert.throws(() => assertSeqInvariant(new Seq([1])), /invariant/);
      assert.throws(() => assertSeqInvariant(new Seq([1, new Seq([2, 3])])), /invariant/);
      assert.throws(() => assertSeqInvariant(new Seq([1, EMPTY])), /invariant/);
    });
  });

  describe('constructors', () => {
    it('should flatten array constructor elements (spec section 3.4 example)', () => {
      assert.deepStrictEqual(
        queryJson([1, '$.store.book[*].price', { $seq: [2, 3] }], bookstore),
        [1, 8.95, 12.99, 8.99, 22.99, 2, 3]);
    });

    it('should contribute nothing for empty elements', () => {
      assert.deepStrictEqual(queryJson([1, '$.missing', 2], bookstore), [1, 2]);
      assert.deepStrictEqual(queryJson([], bookstore), []);
    });

    it('should construct fresh (unfrozen) arrays and objects per call', () => {
      const q = compileJsonQuery({ tags: ['new', 'sale'] });
      const a = q(null);
      const b = q(null);
      assert.notStrictEqual(a, b);
      assert.notStrictEqual(a.tags, b.tags);
      assert.strictEqual(Object.isFrozen(a), false);
    });

    it('should evaluate map constructor members (spec section 3.1 example)', () => {
      assert.deepStrictEqual(
        queryJson({ title: '$.store.book[0].title', inStock: true, tags: ['new', 'sale'] }, bookstore),
        { title: 'Sayings of the Century', inStock: true, tags: ['new', 'sale'] });
    });

    it('should omit map constructor members whose value is empty', () => {
      assert.deepStrictEqual(queryJson({ a: '$.missing', b: 1 }, bookstore), { b: 1 });
    });

    it('should raise JQ2001 for a multi-item map constructor member', () => {
      runtimeFails({ x: '$.store.book[*].price' }, bookstore, 'JQ2001', '/x');
    });

    it('should construct the empty object from {}', () => {
      assert.deepStrictEqual(queryJson({}, bookstore), {});
    });

    it('should build $map objects with computed keys, later pairs winning', () => {
      assert.deepStrictEqual(
        queryJson({ $map: [['k', 1], [{ $concat: ['k', ''] }, 2]] }, null),
        { k: 2 });
      assert.deepStrictEqual(queryJson({ $map: [] }, null), {});
    });

    it('should omit a $map member on an empty value and keep an earlier pair', () => {
      assert.deepStrictEqual(queryJson({ $map: [['k', '$.missing']] }, {}), {});
      assert.deepStrictEqual(queryJson({ $map: [['k', 1], ['k', '$.missing']] }, {}), { k: 1 });
    });

    it('should raise JQ2004 when a $map key is not a single string', () => {
      runtimeFails({ $map: [[1, 'v']] }, null, 'JQ2004', '/$map/0/0');
      runtimeFails({ $map: [['$.missing', 'v']] }, {}, 'JQ2004', '/$map/0/0');
      runtimeFails({ $map: [['$.a[*]', 'v']] }, { a: ['x', 'y'] }, 'JQ2004', '/$map/0/0');
      runtimeFails({ $map: [[null, 'v']] }, null, 'JQ2004', '/$map/0/0');
    });

    it('should raise JQ2001 for a multi-item $map value', () => {
      runtimeFails({ $map: [['k', '$.a[*]']] }, { a: [1, 2] }, 'JQ2001', '/$map/0/1');
    });
  });

  describe('comparisons', () => {
    it('should compare singletons directly (the fast path)', () => {
      assert.strictEqual(queryJson({ $eq: [1, 1.0] }, null), true);
      assert.strictEqual(queryJson({ $ne: [1, 2] }, null), true);
      assert.strictEqual(queryJson({ $lt: ['a', 'b'] }, null), true);
      assert.strictEqual(queryJson({ $le: [1, 1] }, null), true);
      assert.strictEqual(queryJson({ $gt: [2, 1] }, null), true);
      assert.strictEqual(queryJson({ $ge: [2, 2] }, null), true);
    });

    it('should use deep structural equality for $eq/$ne (D2)', () => {
      assert.strictEqual(queryJson({ $eq: [{ $const: { a: [1, 2] } }, { $const: { a: [1, 2] } }] }, null), true);
      assert.strictEqual(queryJson({ $eq: [{ $const: [1, 2] }, { $const: [2, 1] }] }, null), false);
      assert.strictEqual(queryJson({ $eq: [null, null] }, null), true);
      assert.strictEqual(queryJson({ $eq: [null, false] }, null), false);
      // NaN equals nothing; -0 equals 0
      assert.strictEqual(queryJson({ $eq: [{ $div: [0, 0] }, { $div: [0, 0] }] }, null), false);
      assert.strictEqual(queryJson({ $eq: [{ $neg: 0 }, 0] }, null), true);
    });

    it('should order only number/number and string/string pairs', () => {
      assert.strictEqual(queryJson({ $lt: [1, 'b'] }, null), false);
      assert.strictEqual(queryJson({ $le: [true, true] }, null), false);
      assert.strictEqual(queryJson({ $ge: [null, null] }, null), false);
      assert.strictEqual(queryJson({ $lt: [{ $const: [1] }, { $const: [2] }] }, null), false);
    });

    it('should compare strings by Unicode scalar values', () => {
      // U+1D306 (surrogate pair in UTF-16) orders above U+FF5E
      assert.strictEqual(queryJson({ $gt: ['\u{1D306}', '～'] }, null), true);
    });

    it('should be existential over sequences', () => {
      const data = { a: [1, 2, 3], b: [3, 4, 5] };
      assert.strictEqual(queryJson({ $eq: ['$.a[*]', '$.b[*]'] }, data), true);
      assert.strictEqual(queryJson({ $eq: ['$.a[*]', 99] }, data), false);
      assert.strictEqual(queryJson({ $lt: [3, '$.a[*]'] }, data), false);
      assert.strictEqual(queryJson({ $lt: ['$.a[*]', 2] }, data), true);
    });

    it('should make $ne existential too, not the negation of $eq', () => {
      const data = { a: [1, 2], b: [1, 2] };
      // some pair is equal AND some pair differs
      assert.strictEqual(queryJson({ $eq: ['$.a[*]', '$.b[*]'] }, data), true);
      assert.strictEqual(queryJson({ $ne: ['$.a[*]', '$.b[*]'] }, data), true);
      assert.strictEqual(queryJson({ $not: { $eq: ['$.a[*]', '$.b[*]'] } }, data), false);
    });

    it('should be false when either side is empty', () => {
      assert.strictEqual(queryJson({ $eq: ['$.missing', '$.missing'] }, {}), false);
      assert.strictEqual(queryJson({ $ne: ['$.missing', 1] }, {}), false);
      assert.strictEqual(queryJson({ $le: [1, '$.missing'] }, {}), false);
    });

    it('should honor both filter dialects (spec section 5.2, verbatim)', () => {
      const input = { a: [{ n: 1 }] };
      // path dialect: Nothing == Nothing is true, the item is selected
      assert.deepStrictEqual(queryJson('$.a[?@.b == @.c]', input), { n: 1 });
      // query dialect: existential comparison over two empty sequences is false
      assert.strictEqual(queryJson({ $eq: ['$.a[0].b', '$.a[0].c'] }, input), false);
      // ... so the $let-based equivalent of the spec's $for keeps nothing
      const q = compileJsonQuery({
        $let: { x: '$.a[0]' },
        $return: { $if: [{ $eq: ['$x.b', '$x.c'] }, '$x'] },
      });
      assert.strictEqual(q(input), undefined);
    });
  });

  describe('arithmetic', () => {
    it('should compute the spec section 8.5 example values', () => {
      assert.deepStrictEqual(
        queryJson({ $seq: [{ $add: [1, 2] }, { $sub: [3, 1] }, { $mul: [2, 4] }, { $div: [1, 0] }, { $idiv: [7, 2] }, { $mod: [7, 2] }, { $neg: '$.store.bicycle.price' }] }, bookstore),
        [3, 2, 8, Infinity, 3, 1, -399]);
    });

    it('should propagate the empty sequence', () => {
      assert.strictEqual(queryJson({ $add: ['$.missing', 1] }, {}), undefined);
      assert.strictEqual(queryJson({ $mul: [2, '$.missing'] }, {}), undefined);
      assert.strictEqual(queryJson({ $neg: '$.missing' }, {}), undefined);
    });

    it('should raise JQ2001 for non-number and multi-item operands', () => {
      runtimeFails({ $add: [1, 'x'] }, null, 'JQ2001', '/$add/1');
      runtimeFails({ $sub: [null, 1] }, null, 'JQ2001', '/$sub/0');
      runtimeFails({ $mul: [true, 1] }, null, 'JQ2001', '/$mul/0');
      runtimeFails({ $add: ['$.a[*]', 1] }, { a: [1, 2] }, 'JQ2001', '/$add/0');
      runtimeFails({ $neg: { $const: [1] } }, null, 'JQ2001', '/$neg');
    });

    it('should follow IEEE 754 for $div (D1)', () => {
      assert.strictEqual(queryJson({ $div: [-1, 0] }, null), -Infinity);
      assert.strictEqual(Number.isNaN(queryJson({ $div: [0, 0] }, null)), true);
      assert.strictEqual(queryJson({ $div: [1, 3] }, null), 1 / 3);
    });

    it('should truncate $idiv toward zero', () => {
      assert.strictEqual(queryJson({ $idiv: [7, 2] }, null), 3);
      assert.strictEqual(queryJson({ $idiv: [-7, 2] }, null), -3);
      assert.strictEqual(queryJson({ $idiv: [7, -2] }, null), -3);
      assert.strictEqual(queryJson({ $idiv: [-7, -2] }, null), 3);
    });

    it('should raise JQ2002 for $idiv/$mod by zero', () => {
      runtimeFails({ $idiv: [7, 0] }, null, 'JQ2002', '/$idiv');
      runtimeFails({ $mod: [7, 0] }, null, 'JQ2002', '/$mod');
    });

    it('should give $mod the sign of the dividend (XQuery double mod = JS %)', () => {
      assert.strictEqual(queryJson({ $mod: [7, 2] }, null), 1);
      assert.strictEqual(queryJson({ $mod: [-7, 2] }, null), -1);
      assert.strictEqual(queryJson({ $mod: [7, -2] }, null), 1);
      assert.strictEqual(queryJson({ $mod: [-7, -2] }, null), -1);
      assert.strictEqual(queryJson({ $mod: [7.5, 2] }, null), 1.5);
    });

    it('should negate numbers, including negative zero', () => {
      assert.strictEqual(queryJson({ $neg: 5 }, null), -5);
      assert.strictEqual(Object.is(queryJson({ $neg: 0 }, null), -0), true);
    });
  });

  describe('logic and the EBV table', () => {
    it('should compute every EBV row (spec section 2.2)', () => {
      const ebvOf = (expr, data) => queryJson({ $not: { $not: expr } }, data ?? null);
      assert.strictEqual(ebvOf('$.missing', {}), false); // empty sequence
      assert.strictEqual(ebvOf(false), false);
      assert.strictEqual(ebvOf(true), true);
      assert.strictEqual(ebvOf(0), false);
      assert.strictEqual(ebvOf({ $neg: 0 }), false); // -0
      assert.strictEqual(ebvOf({ $div: [0, 0] }), false); // NaN
      assert.strictEqual(ebvOf(42), true);
      assert.strictEqual(ebvOf(''), false);
      assert.strictEqual(ebvOf('x'), true);
      assert.strictEqual(ebvOf(null), false);
      assert.strictEqual(ebvOf({ $const: [] }), true); // singleton array (D3)
      assert.strictEqual(ebvOf({ $const: {} }), true); // singleton object (D3)
    });

    it('should raise JQ2003 for the EBV of a multi-item sequence', () => {
      runtimeFails({ $not: '$.a[*]' }, { a: [1, 2] }, 'JQ2003', '/$not');
      runtimeFails({ $if: ['$.a[*]', 1] }, { a: [1, 2] }, 'JQ2003', '/$if/0');
      runtimeFails({ $and: [true, '$.a[*]'] }, { a: [1, 2] }, 'JQ2003', '/$and/1');
    });

    it('should evaluate the spec section 8.4 combined example', () => {
      assert.strictEqual(queryJson({
        $and: [
          { $eq: ['$.store.bicycle.color', 'red'] },
          { $or: [{ $lt: ['$.store.bicycle.price', 400] }, { $not: false }] },
          { $ne: [1, 2] }, { $le: [1, 1] }, { $gt: [2, 1] }, { $ge: [2, 2] },
        ],
      }, bookstore), true);
    });

    it('should short-circuit $and and $or', () => {
      // the deciding operand stops evaluation: the error operand is never reached
      assert.strictEqual(queryJson({ $and: [false, { $idiv: [1, 0] }] }, null), false);
      assert.strictEqual(queryJson({ $or: [true, { $idiv: [1, 0] }] }, null), true);
      runtimeFails({ $and: [true, { $idiv: [1, 0] }] }, null, 'JQ2002');
    });
  });

  describe('$if', () => {
    it('should evaluate only the taken branch', () => {
      assert.strictEqual(queryJson({ $if: [true, 1, { $idiv: [1, 0] }] }, null), 1);
      assert.strictEqual(queryJson({ $if: [false, { $idiv: [1, 0] }, 2] }, null), 2);
    });

    it('should produce the empty sequence for a missing else', () => {
      assert.strictEqual(queryJson({ $if: [false, 1] }, null), undefined);
    });

    it('should reduce the condition by EBV', () => {
      assert.strictEqual(queryJson({ $if: ['$.store', 'yes', 'no'] }, bookstore), 'yes');
      assert.strictEqual(queryJson({ $if: ['$.missing', 'yes', 'no'] }, bookstore), 'no');
    });
  });

  describe('$seq, $exists, $empty', () => {
    it('should concatenate into one flat sequence', () => {
      assert.deepStrictEqual(
        queryJson({ $seq: [1, { $seq: [2, 3] }, '$.a[*]', '$.missing'] }, { a: [4, 5] }),
        [1, 2, 3, 4, 5]);
      assert.strictEqual(queryJson({ $seq: [] }, null), undefined);
      assert.strictEqual(queryJson({ $seq: [7] }, null), 7);
    });

    it('should evaluate the spec section 8.2 example', () => {
      assert.deepStrictEqual(
        queryJson({ $if: [{ $exists: '$.store.bicycle' }, { $seq: ['$.store.bicycle.color', '$.store.bicycle.price'] }] }, bookstore),
        ['red', 399]);
    });

    it('should test existence of paths without materializing', () => {
      assert.strictEqual(queryJson({ $exists: '$.store.bicycle' }, bookstore), true);
      assert.strictEqual(queryJson({ $exists: '$.store.tricycle' }, bookstore), false);
      assert.strictEqual(queryJson({ $exists: '$.store.book[*].isbn' }, bookstore), true);
      assert.strictEqual(queryJson({ $exists: '$..nothing' }, bookstore), false);
      assert.strictEqual(queryJson({ $empty: '$.store.tricycle' }, bookstore), true);
      assert.strictEqual(queryJson({ $empty: '$.store.book[*]' }, bookstore), false);
    });

    it('should test existence of variables and expressions', () => {
      assert.strictEqual(queryJson({ $let: { x: '$.missing' }, $return: { $exists: '$x' } }, {}), false);
      assert.strictEqual(queryJson({ $let: { x: null }, $return: { $exists: '$x' } }, {}), true);
      assert.strictEqual(queryJson({ $exists: { $seq: [] } }, null), false);
      assert.strictEqual(queryJson({ $empty: { $seq: [1, 2] } }, null), false);
      assert.strictEqual(queryJson({ $exists: false }, null), true);
    });

    it('should test existence of variable-rooted paths', () => {
      assert.strictEqual(queryJson({ $let: { b: '$.store.book[*]' }, $return: { $exists: '$b.isbn' } }, bookstore), true);
      assert.strictEqual(queryJson({ $let: { b: '$.store.book[*]' }, $return: { $exists: '$b.missing' } }, bookstore), false);
    });
  });

  describe('$let / $return', () => {
    it('should bind the full sequence without iteration', () => {
      assert.deepStrictEqual(
        queryJson({ $let: { p: '$.store.book[*].price' }, $return: '$p' }, bookstore),
        [8.95, 12.99, 8.99, 22.99]);
    });

    it('should let later bindings see earlier ones (correlation)', () => {
      assert.strictEqual(
        queryJson({ $let: { a: 2, b: { $mul: ['$a', 21] } }, $return: '$b' }, null),
        42);
    });

    it('should evaluate the spec section 6.1 nesting example shape', () => {
      assert.deepStrictEqual(
        queryJson({
          $let: { a: '$.store.book[3]' },
          $return: { $let: { p: '$a.price' }, $return: { $if: [{ $gt: ['$p', 10] }, '$a.title'] } },
        }, bookstore),
        'The Lord of the Rings');
    });
  });

  describe('variable-rooted paths', () => {
    it('should walk segments from a bound item', () => {
      assert.strictEqual(
        queryJson({ $let: { b: '$.store.book[0]' }, $return: '$b.title' }, bookstore),
        'Sayings of the Century');
      assert.strictEqual(
        queryJson({ $let: { b: '$.store.book[0]' }, $return: "$b['odd key']" }, bookstore),
        undefined);
    });

    it('should evaluate segments against each item of a bound sequence, concatenating', () => {
      assert.deepStrictEqual(
        queryJson({ $let: { b: '$.store.book[*]' }, $return: '$b.price' }, bookstore),
        [8.95, 12.99, 8.99, 22.99]);
      // isbn is absent on two books: singular per-item results skip them
      assert.deepStrictEqual(
        queryJson({ $let: { b: '$.store.book[*]' }, $return: '$b.isbn' }, bookstore),
        ['0-553-21311-3', '0-395-19395-8']);
    });

    it('should treat an array-valued variable as one RFC 9535 node', () => {
      const q = compileJsonQuery({
        $let: { b: { $const: [{ t: 'A', p: 5 }, { t: 'B', p: 25 }] } },
        $return: '$b[?@.p > 20].t',
      });
      assert.strictEqual(q(null), 'B');
      // ... and index/wildcard segments address its members
      assert.strictEqual(queryJson({ $let: { a: { $const: [10, 20] } }, $return: '$a[1]' }, null), 20);
      assert.deepStrictEqual(queryJson({ $let: { a: { $const: [10, 20] } }, $return: '$a[*]' }, null), [10, 20]);
    });

    it('should keep $ inside embedded filters pointing at the input document', () => {
      const data = { limit: 10, items: [{ v: 5 }, { v: 15 }] };
      assert.deepStrictEqual(
        queryJson({ $let: { s: '$' }, $return: '$s.items[?@.v < $.limit].v' }, data),
        5);
    });

    it('should apply non-singular segments over a bound sequence', () => {
      assert.deepStrictEqual(
        queryJson({ $let: { b: '$.store.book[*]' }, $return: '$b[?@.price > 20].title' }, bookstore),
        undefined); // books are objects; their children have no price member
      assert.deepStrictEqual(
        queryJson({ $let: { s: '$.store' }, $return: '$s.book[?@.price > 20].title' }, bookstore),
        'The Lord of the Rings');
    });

    it('should resolve the whole document as $', () => {
      assert.deepStrictEqual(queryJson('$', 42), 42);
      assert.deepStrictEqual(queryJson({ doc: '$' }, { a: 1 }), { doc: { a: 1 } });
    });
  });

  describe('externals', () => {
    it('should bind external parameters at call time', () => {
      const q = compileJsonQuery({ $ge: ['$.store.bicycle.price', '$minPrice'] });
      assert.deepStrictEqual(q.externals, ['minPrice']);
      assert.strictEqual(q(bookstore, { minPrice: 100 }), true);
      assert.strictEqual(q(bookstore, { minPrice: 1000 }), false);
    });

    it('should support variable-rooted paths on externals', () => {
      const q = compileJsonQuery('$filter.threshold');
      assert.strictEqual(q(null, { filter: { threshold: 7 } }), 7);
    });

    it('should raise JQ2006 when an evaluated external is unbound', () => {
      runtimeFails('$minPrice', null, 'JQ2006', '');
      runtimeFails({ $add: [1, '$x'] }, null, 'JQ2006', '/$add/1', {});
    });

    it('should not raise JQ2006 for an unevaluated external', () => {
      assert.strictEqual(queryJson({ $if: [true, 1, '$x'] }, null), 1);
      assert.strictEqual(queryJson({ $and: [false, '$x'] }, null), false);
    });
  });

  describe('$concat', () => {
    it('should concatenate casts of each operand', () => {
      assert.strictEqual(queryJson({ $concat: ['a', 'b'] }, null), 'ab');
      assert.strictEqual(queryJson({ $concat: [1, true, false, null, 'x'] }, null), '1truefalsenullx');
      assert.strictEqual(queryJson({ $concat: [] }, null), '');
    });

    it('should contribute the empty string for an empty operand', () => {
      assert.strictEqual(queryJson({ $concat: ['a', '$.missing', 'b'] }, {}), 'ab');
    });

    it('should raise JQ2001 for uncastable operands', () => {
      runtimeFails({ $concat: [{ $const: [1] }] }, null, 'JQ2001', '/$concat/0');
      runtimeFails({ $concat: [{ $const: {} }] }, null, 'JQ2001', '/$concat/0');
      runtimeFails({ $concat: ['$.a[*]'] }, { a: [1, 2] }, 'JQ2001', '/$concat/0');
    });
  });
});

describe('constructed __proto__ members are data, not the prototype', () => {
  // written through JSON.parse: a JS object literal's `__proto__:` key
  // would set the document's own prototype instead of adding a member
  const parse = (s) => JSON.parse(s);

  it('should build an own member from an object constructor', () => {
    const q = compileJsonQuery(parse('{"__proto__": "$.payload", "ok": 1}'));
    const out = q({ payload: { polluted: true } });
    assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
    assert.strictEqual(Object.hasOwn(out, '__proto__'), true);
    assert.deepStrictEqual(out['__proto__'], { polluted: true });
    assert.strictEqual(out.ok, 1);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
  });

  it('should build an own member from a $map dynamic key', () => {
    const q = compileJsonQuery(parse('{"$map": [["$.k", "$.v"]]}'));
    const out = q({ k: '__proto__', v: { polluted: true } });
    assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
    assert.strictEqual(Object.hasOwn(out, '__proto__'), true);
    assert.deepStrictEqual(out['__proto__'], { polluted: true });
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
  });

  it('should keep an ordinary member on the plain assignment path', () => {
    const q = compileJsonQuery(parse('{"title": "$.t"}'));
    assert.deepStrictEqual(q({ t: 'x' }), { title: 'x' });
  });
});
