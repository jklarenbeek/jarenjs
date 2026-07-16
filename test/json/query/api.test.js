import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery,
  queryJson,
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

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

describe('Jaren JSON Query public API', () => {

  describe('result mapping (plain JSON out)', () => {
    it('should map the empty sequence to undefined', () => {
      assert.strictEqual(compileJsonQuery('$.missing')(bookstore), undefined);
      assert.strictEqual(compileJsonQuery({ $seq: [] })(bookstore), undefined);
    });

    it('should map a singleton to the item itself', () => {
      assert.strictEqual(compileJsonQuery('$.store.bicycle.color')(bookstore), 'red');
      // a single array item stays one item, not a wrapped sequence
      assert.deepStrictEqual(compileJsonQuery({ $const: [1, 2] })(null), [1, 2]);
    });

    it('should map longer sequences to an array of items', () => {
      assert.deepStrictEqual(
        compileJsonQuery('$.store.book[*].price')(bookstore),
        [8.95, 12.99, 8.99, 22.99]);
    });
  });

  describe('first and exists', () => {
    it('should mirror the JSONPath API shape', () => {
      const q = compileJsonQuery('$.store.book[*].title');
      assert.strictEqual(q.first(bookstore), 'Sayings of the Century');
      assert.strictEqual(q.exists(bookstore), true);

      const none = compileJsonQuery('$.missing');
      assert.strictEqual(none.first(bookstore), undefined);
      assert.strictEqual(none.exists(bookstore), false);

      const one = compileJsonQuery(42);
      assert.strictEqual(one.first(bookstore), 42);
      assert.strictEqual(one.exists(bookstore), true);
    });

    it('should pass externals through first and exists', () => {
      const q = compileJsonQuery({ $if: [{ $gt: ['$n', 0] }, '$n'] });
      assert.strictEqual(q.first(null, { n: 5 }), 5);
      assert.strictEqual(q.exists(null, { n: -1 }), false);
    });
  });

  describe('ebv (effective boolean value, spec section 2.2)', () => {
    it('should be false for the empty sequence', () => {
      assert.strictEqual(compileJsonQuery('$.missing').ebv(bookstore), false);
      assert.strictEqual(compileJsonQuery({ $seq: [] }).ebv(bookstore), false);
    });

    it('should follow the EBV table for scalar singletons', () => {
      assert.strictEqual(compileJsonQuery(0).ebv(null), false);
      assert.strictEqual(compileJsonQuery({ $neg: 0 }).ebv(null), false); // -0
      assert.strictEqual(compileJsonQuery({ $div: [0, 0] }).ebv(null), false); // NaN
      assert.strictEqual(compileJsonQuery('').ebv(null), false);
      assert.strictEqual(compileJsonQuery(null).ebv(null), false);
      assert.strictEqual(compileJsonQuery(false).ebv(null), false);
      assert.strictEqual(compileJsonQuery(true).ebv(null), true);
      assert.strictEqual(compileJsonQuery(42).ebv(null), true);
      assert.strictEqual(compileJsonQuery('x').ebv(null), true);
    });

    it('should be true for a singleton array or object (D3)', () => {
      // internal-representation check: one EMPTY array item is a truthy
      // singleton, not the (falsy) empty sequence the mapped result
      // resembles
      assert.strictEqual(compileJsonQuery({ $const: [] }).ebv(null), true);
      assert.strictEqual(compileJsonQuery({ $const: {} }).ebv(null), true);
      assert.strictEqual(compileJsonQuery('$.store.bicycle').ebv(bookstore), true);
    });

    it('should raise JQ2003 on a sequence of two or more items', () => {
      const q = compileJsonQuery('$.store.book[*]');
      assert.throws(() => q.ebv(bookstore), (e) => {
        assert.strictEqual(e instanceof JsonQueryRuntimeError, true);
        assert.strictEqual(e.code, 'JQ2003');
        assert.strictEqual(e.docPath, '');
        return true;
      });
    });

    it('should pass externals through', () => {
      const q = compileJsonQuery({ $gt: ['$n', 0] });
      assert.strictEqual(q.ebv(null, { n: 5 }), true);
      assert.strictEqual(q.ebv(null, { n: -5 }), false);
    });
  });

  describe('compiled query metadata', () => {
    it('should expose a deep-frozen copy of the document', () => {
      const doc = { $let: { x: 1 }, $return: ['$x'] };
      const q = compileJsonQuery(doc);
      assert.deepStrictEqual(q.doc, doc);
      assert.notStrictEqual(q.doc, doc);
      assert.strictEqual(Object.isFrozen(q.doc), true);
      assert.strictEqual(Object.isFrozen(q.doc.$let), true);
      assert.strictEqual(Object.isFrozen(q.doc.$return), true);
      // the caller's object is never frozen
      assert.strictEqual(Object.isFrozen(doc), false);
      doc.$return = 'mutated';
      assert.deepStrictEqual(q.doc.$return, ['$x']);
    });

    it('should expose externals as a frozen array in slot order', () => {
      const q = compileJsonQuery({ $seq: ['$b', '$a'] });
      assert.deepStrictEqual(q.externals, ['b', 'a']);
      assert.strictEqual(Object.isFrozen(q.externals), true);
    });
  });

  describe('queryJson caching', () => {
    it('should cache object documents by identity (WeakMap)', () => {
      const doc = { $add: [1, 2] };
      assert.strictEqual(queryJson(doc, null), 3);
      // mutating the same object does not recompile: identity cache hit
      doc.$add = [1, 100];
      assert.strictEqual(queryJson(doc, null), 3);
      // a structurally identical fresh object compiles anew
      assert.strictEqual(queryJson({ $add: [1, 100] }, null), 101);
    });

    it('should cache string documents by value (degenerate JSONPath case)', () => {
      assert.deepStrictEqual(
        queryJson('$.store.book[?@.price < 10].title', bookstore),
        ['Sayings of the Century', 'Moby Dick']);
      assert.deepStrictEqual(
        queryJson('$.store.book[?@.price < 10].title', bookstore),
        ['Sayings of the Century', 'Moby Dick']);
      assert.strictEqual(queryJson('plain literal', bookstore), 'plain literal');
    });

    it('should run scalar documents without caching', () => {
      assert.strictEqual(queryJson(42, bookstore), 42);
      assert.strictEqual(queryJson(null, bookstore), null);
      assert.strictEqual(queryJson(true, bookstore), true);
    });

    it('should pass externals through', () => {
      assert.strictEqual(queryJson({ $mul: ['$k', 2] }, null, { k: 21 }), 42);
    });

    it('should surface compile errors', () => {
      assert.throws(() => queryJson({ $bogus: 1 }, null), JsonQueryCompileError);
    });
  });

  describe('spec examples end-to-end', () => {
    it('should run example A.1 - the degenerate JSONPath query', () => {
      assert.deepStrictEqual(
        queryJson('$.store.book[?@.price < 10].title', bookstore),
        ['Sayings of the Century', 'Moby Dick']);
    });

    it('should run example A.5 - $let with computed keys', () => {
      assert.deepStrictEqual(
        queryJson({
          $let: { prefix: 'col_', book: '$.store.book[0]' },
          $return: {
            $map: [
              [{ $concat: ['$prefix', 'title'] }, '$book.title'],
              [{ $concat: ['$prefix', 'price'] }, '$book.price'],
            ],
          },
        }, bookstore),
        { col_title: 'Sayings of the Century', col_price: 8.95 });
    });

    it('should run example A.6 - $const and $$ escapes', () => {
      assert.deepStrictEqual(
        queryJson({
          template: { $const: { $for: 'kept verbatim', price: null } },
          label: '$$price',
        }, bookstore),
        { template: { $for: 'kept verbatim', price: null }, label: '$price' });
    });

    // Example A.8 verbatim (with $for) runs in flwor.test.js - this runs
    // its envelope + external mechanics over the degenerate $let phrase.
    it('should run the envelope + external mechanics of example A.8', () => {
      const q = compileJsonQuery({
        $query: '0.1',
        $expr: {
          $let: { b: '$.store.book[3]' },
          $return: { $if: [{ $ge: ['$b.price', '$minPrice'] }, '$b.title'] },
        },
      });
      assert.deepStrictEqual(q.externals, ['minPrice']);
      assert.strictEqual(q(bookstore, { minPrice: 20 }), 'The Lord of the Rings');
      assert.strictEqual(q(bookstore, { minPrice: 30 }), undefined);
    });
  });
});
