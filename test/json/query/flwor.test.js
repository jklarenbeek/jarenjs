import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery,
  queryJson,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

import { stableKeyString } from '../../../packages/json/src/query/runtime.js';

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

// ... plus a ratings array for the join example (spec appendix A)
const bookstoreWithRatings = {
  ...bookstore,
  ratings: [
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-000-00000-0', stars: 1 },
  ],
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

describe('Jaren JSON Query FLWOR phrases', () => {

  describe('$for and $return', () => {
    it('should iterate in document order (single binding)', () => {
      assert.deepStrictEqual(
        queryJson({ $for: { b: '$.store.book[*]' }, $return: { title: '$b.title' } }, bookstore),
        [
          { title: 'Sayings of the Century' },
          { title: 'Sword of Honour' },
          { title: 'Moby Dick' },
          { title: 'The Lord of the Rings' },
        ]);
    });

    it('should concatenate multi-item $return results per tuple', () => {
      assert.deepStrictEqual(
        queryJson({ $for: { x: { $seq: [1, 2] } }, $return: { $seq: ['$x', '$x'] } }, null),
        [1, 1, 2, 2]);
    });

    it('should drop tuples whose $return is empty', () => {
      assert.deepStrictEqual(
        queryJson({ $for: { b: '$.store.book[*]' }, $return: '$b.isbn' }, bookstore),
        ['0-553-21311-3', '0-395-19395-8']);
    });

    it('should evaluate to the empty sequence over an empty source', () => {
      assert.strictEqual(
        queryJson({ $for: { b: '$.missing[*]' }, $return: '$b' }, bookstore),
        undefined);
    });

    it('should nest multiple bindings left-to-right (cross product)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [1, 2] }, y: { $seq: ['a', 'b'] } },
          $return: ['$x', '$y'],
        }, null),
        [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]);
    });

    it('should correlate later bindings with earlier ones', () => {
      const doc = {
        store: {
          book: [
            { title: 'A', authors: ['x', 'y'] },
            { title: 'B', authors: ['z'] },
          ],
        },
      };
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]', w: '$b.authors[*]' },
          $return: { title: '$b.title', author: '$w' },
        }, doc),
        [
          { title: 'A', author: 'x' },
          { title: 'A', author: 'y' },
          { title: 'B', author: 'z' },
        ]);
    });
  });

  describe('D4 array unpacking', () => {
    it('should unpack array items one level (nested arrays stay items)', () => {
      // a sequence of two array items: each unpacks into its members
      assert.deepStrictEqual(
        queryJson({ $for: { x: { $seq: [[1, 2], [3]] } }, $return: '$x' }, null),
        [1, 2, 3]);
      // one array-of-arrays item: unpacks one level, members stay arrays
      assert.deepStrictEqual(
        queryJson({ $for: { x: { $const: [[1, 2], [3]] } }, $return: '$x' }, null),
        [[1, 2], [3]]);
      // a literal array source is an array constructor: same one item
      assert.deepStrictEqual(
        queryJson({ $for: { x: [[1, 2], [3]] }, $return: '$x' }, null),
        [[1, 2], [3]]);
    });

    it('should unpack the array values a path produces', () => {
      const doc = { matrix: [[1, 2], [3, 4]] };
      // '$.matrix' is one array item; unpack one level: the two rows
      assert.deepStrictEqual(
        queryJson({ $for: { row: '$.matrix' }, $return: '$row' }, doc),
        [[1, 2], [3, 4]]);
      // '$.matrix[*]' produces the two rows; each unpacks into scalars
      assert.deepStrictEqual(
        queryJson({ $for: { v: '$.matrix[*]' }, $return: '$v' }, doc),
        [1, 2, 3, 4]);
    });

    it('should not unpack objects', () => {
      assert.deepStrictEqual(
        queryJson({ $for: { x: '$.store.bicycle' }, $return: '$x' }, bookstore),
        { color: 'red', price: 399 });
    });

    it('should keep a $let-bound array as one item', () => {
      assert.strictEqual(
        queryJson({ $let: { a: { $const: [[1, 2], [3]] } }, $return: { $count: '$a' } }, null),
        1);
      // contrast: iterated through $for it is three tuples deep down
      assert.strictEqual(
        queryJson({
          $for: { x: { $seq: [[1, 2], [3]] } },
          $count: 'n',
          $return: { $add: ['$n', 1] },
        }, null)
          .length,
        3);
    });
  });

  describe('$where', () => {
    it('should run spec example A.2 verbatim (filter + order)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $where: { $lt: ['$b.price', 10] },
          $orderby: '$b.price',
          $return: { title: '$b.title', price: '$b.price' },
        }, bookstore),
        [
          { title: 'Sayings of the Century', price: 8.95 },
          { title: 'Moby Dick', price: 8.99 },
        ]);
    });

    it('should gate tuples by EBV (empty comparison is false)', () => {
      // books without isbn produce the empty sequence: existential $eq is
      // false, they drop out (spec section 5.2 vs the path dialect)
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $where: { $eq: ['$b.isbn', '$b.isbn'] },
          $return: '$b.title',
        }, bookstore),
        ['Moby Dick', 'The Lord of the Rings']);
    });

    it('should honor both filter dialects (spec section 5.2, $for verbatim)', () => {
      const input = { a: [{ n: 1 }] };
      // path dialect: Nothing == Nothing is true, the item is selected
      assert.deepStrictEqual(queryJson('$.a[?@.b == @.c]', input), { n: 1 });
      // query dialect (verbatim spec document): the empty sequence
      assert.strictEqual(
        queryJson({
          $for: { x: '$.a[*]' },
          $where: { $eq: ['$x.b', '$x.c'] },
          $return: '$x',
        }, input),
        undefined);
    });

    it('should support cross-variable predicates (the join case)', () => {
      // spec example A.3 verbatim, asserted output
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
          $where: { $eq: ['$b.isbn', '$r.isbn'] },
          $orderby: '$b.price',
          $return: { title: '$b.title', stars: '$r.stars' },
        }, bookstoreWithRatings),
        [
          { title: 'Moby Dick', stars: 4 },
          { title: 'The Lord of the Rings', stars: 5 },
        ]);
    });
  });

  describe('$at and $count', () => {
    it('should bind 0-based positions and row numbers (fixture flwor-at-count)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: { $in: '$.store.book[*]', $at: 'i' } },
          $count: 'n',
          $return: { index: '$i', row: '$n', title: '$b.title' },
        }, bookstore),
        [
          { index: 0, row: 0, title: 'Sayings of the Century' },
          { index: 1, row: 1, title: 'Sword of Honour' },
          { index: 2, row: 2, title: 'Moby Dick' },
          { index: 3, row: 3, title: 'The Lord of the Rings' },
        ]);
    });

    it('should number tuples after $where ($at keeps the source position)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: { $in: '$.store.book[*]', $at: 'i' } },
          $where: { $lt: ['$b.price', 10] },
          $count: 'n',
          $return: { i: '$i', n: '$n' },
        }, bookstore),
        [{ i: 0, n: 0 }, { i: 2, n: 1 }]);
    });

    it('should count positions per binding activation', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [1, 2] }, y: { $in: { $seq: ['a', 'b'] }, $at: 'j' } },
          $return: '$j',
        }, null),
        [0, 1, 0, 1]);
    });

    it('should count positions across D4-unpacked items', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $in: { $seq: [[1, 2], 3] }, $at: 'i' } },
          $return: ['$i', '$x'],
        }, null),
        [[0, 1], [1, 2], [2, 3]]);
    });

    it('should number the tuple stream after $orderby', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $orderby: { $key: '$b.price', $dir: 'desc' },
          $count: 'n',
          $return: { n: '$n', title: '$b.title' },
        }, bookstore),
        [
          { n: 0, title: 'The Lord of the Rings' },
          { n: 1, title: 'Sword of Honour' },
          { n: 2, title: 'Moby Dick' },
          { n: 3, title: 'Sayings of the Century' },
        ]);
    });

    it('should reset the counter on every phrase evaluation', () => {
      const q = compileJsonQuery({
        $for: { x: '$.a[*]' }, $count: 'n', $return: '$n',
      });
      assert.deepStrictEqual(q({ a: ['p', 'q'] }), [0, 1]);
      assert.deepStrictEqual(q({ a: ['p', 'q'] }), [0, 1]);
    });
  });

  describe('$orderby', () => {
    it('should sort by multiple keys, major to minor', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $orderby: ['$b.category', { $key: '$b.price', $dir: 'desc' }],
          $return: '$b.title',
        }, bookstore),
        ['The Lord of the Rings', 'Sword of Honour', 'Moby Dick', 'Sayings of the Century']);
    });

    it('should run the spec section 6.6 example (fixture flwor-orderby-keyspec)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $orderby: [{ $key: '$b.price', $dir: 'desc', $empty: 'greatest' }, '$b.title'],
          $return: '$b.title',
        }, bookstore),
        ['The Lord of the Rings', 'Sword of Honour', 'Moby Dick', 'Sayings of the Century']);
    });

    it('should be stable: equal keys preserve document order', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $orderby: '$b.category',
          $return: '$b.title',
        }, bookstore),
        ['Sword of Honour', 'Moby Dick', 'The Lord of the Rings', 'Sayings of the Century']);
    });

    it('should place empty keys per $empty least/greatest in both directions', () => {
      const doc = { items: [{ n: 'a', p: 5 }, { n: 'b' }, { n: 'c', p: 3 }, { n: 'd' }] };
      const sorted = (spec) => queryJson({
        $for: { x: '$.items[*]' }, $orderby: spec, $return: '$x.n',
      }, doc);
      assert.deepStrictEqual(sorted('$x.p'), ['b', 'd', 'c', 'a']); // least, asc (defaults)
      assert.deepStrictEqual(sorted({ $key: '$x.p', $empty: 'greatest' }), ['c', 'a', 'b', 'd']);
      assert.deepStrictEqual(sorted({ $key: '$x.p', $dir: 'desc' }), ['a', 'c', 'b', 'd']);
      assert.deepStrictEqual(sorted({ $key: '$x.p', $dir: 'desc', $empty: 'greatest' }), ['b', 'd', 'a', 'c']);
    });

    it('should order strings by Unicode scalar values', () => {
      assert.deepStrictEqual(
        queryJson({ $for: { s: { $seq: ['\u{1D306}', '～', 'a'] } }, $orderby: '$s', $return: '$s' }, null),
        ['a', '～', '\u{1D306}']);
    });

    it('should restore only the live slots after the sort barrier', () => {
      // $a is an $orderby key but never read by $return: not snapshot,
      // still sorts the stream. $b is the only live slot.
      assert.deepStrictEqual(
        queryJson({
          $for: { a: { $seq: [2, 1] }, b: { $seq: ['p', 'q'] } },
          $orderby: '$a',
          $return: ['$a', '$b'],
        }, null),
        [[1, 'p'], [1, 'q'], [2, 'p'], [2, 'q']]);
      assert.deepStrictEqual(
        queryJson({
          $for: { a: { $seq: [2, 1] }, b: { $seq: ['p', 'q'] } },
          $orderby: '$a',
          $return: '$b',
        }, null),
        ['p', 'q', 'p', 'q']);
    });

    it('should raise JQ2005 when one pair mixes numbers and strings', () => {
      runtimeFails({
        $for: { x: '$.xs[*]' }, $orderby: '$x.k', $return: '$x.k',
      }, { xs: [{ k: 1 }, { k: 'a' }] }, 'JQ2005', '/$orderby');
    });

    it('should raise JQ2005 for boolean, null, object, and array keys', () => {
      for (const k of [true, null, { o: 1 }, [1, 2]]) {
        runtimeFails({
          $for: { x: '$.xs[*]' }, $orderby: '$x.k', $return: '$x.k',
        }, { xs: [{ k }] }, 'JQ2005', '/$orderby');
      }
    });

    it('should raise JQ2005 for a multi-item key sequence', () => {
      runtimeFails({
        $for: { x: { $const: [[1, 2], [3, 4]] } }, $orderby: '$x[*]', $return: '$x',
      }, null, 'JQ2005', '/$orderby');
    });

    it('should point JQ2005 at the offending key of a key spec list', () => {
      runtimeFails({
        $for: { x: '$.xs[*]' },
        $orderby: ['$x.n', { $key: '$x.k' }],
        $return: '$x.k',
      }, { xs: [{ n: 1, k: true }] }, 'JQ2005', '/$orderby/1');
    });
  });

  describe('$groupby', () => {
    it('should run spec example A.4 verbatim (group + aggregate)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $groupby: { genre: '$b.category' },
          $return: {
            genre: '$genre',
            count: { $count: '$b' },
            avg: { $avg: '$b.price' },
          },
        }, bookstore),
        [
          { genre: 'reference', count: 1, avg: 8.95 },
          { genre: 'fiction', count: 3, avg: (12.99 + 8.99 + 22.99) / 3 },
        ]);
    });

    it('should bind the key as a singleton and rebind others as sequences', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $groupby: { genre: '$b.category' },
          $return: { genre: '$genre', titles: ['$b.title'] },
        }, bookstore),
        [
          { genre: 'reference', titles: ['Sayings of the Century'] },
          { genre: 'fiction', titles: ['Sword of Honour', 'Moby Dick', 'The Lord of the Rings'] },
        ]);
    });

    it('should emit groups in first-appearance order', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: '$.a[*]' },
          $groupby: { k: '$x' },
          $return: '$k',
        }, { a: [2, 1, 2, 3, 1] }),
        [2, 1, 3]);
    });

    it('should compare deep keys structurally, key order irrelevant', () => {
      const doc = {
        a: [
          { k: { x: 1, y: [2] }, v: 1 },
          { k: { y: [2], x: 1 }, v: 2 },
          { k: { x: 1, y: [3] }, v: 3 },
        ],
      };
      assert.deepStrictEqual(
        queryJson({
          $for: { e: '$.a[*]' },
          $groupby: { k: '$e.k' },
          $return: { key: '$k', vals: ['$e.v'] },
        }, doc),
        [
          { key: { x: 1, y: [2] }, vals: [1, 2] },
          { key: { x: 1, y: [3] }, vals: [3] },
        ]);
    });

    it('should group empty keys together (and apart from every value)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: '$.a[*]' },
          $groupby: { k: '$x.k' },
          $return: { n: { $count: '$x' }, key: { $if: [{ $exists: '$k' }, '$k', '(none)'] } },
        }, { a: [{ v: 1 }, { k: 'x', v: 2 }, { v: 3 }] }),
        [{ n: 2, key: '(none)' }, { n: 1, key: 'x' }]);
    });

    it('should group NaN keys together (XQuery grouping rule)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [{ $div: [0, 0] }, { $div: [0, 0] }] } },
          $groupby: { k: '$x' },
          $return: { $count: '$x' },
        }, null),
        2);
    });

    it('should group by multiple keys as a composite', () => {
      const doc = {
        a: [
          { g: 'x', h: 1, v: 'a' },
          { g: 'x', h: 2, v: 'b' },
          { g: 'x', h: 1, v: 'c' },
        ],
      };
      assert.deepStrictEqual(
        queryJson({
          $for: { e: '$.a[*]' },
          $groupby: { g: '$e.g', h: '$e.h' },
          $return: { g: '$g', h: '$h', vals: ['$e.v'] },
        }, doc),
        [
          { g: 'x', h: 1, vals: ['a', 'c'] },
          { g: 'x', h: 2, vals: ['b'] },
        ]);
    });

    it('should apply $where before, and $orderby/$count after, the grouping', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $where: { $gt: ['$b.price', 8.96] },
          $groupby: { genre: '$b.category' },
          $orderby: { $key: { $avg: '$b.price' }, $dir: 'desc' },
          $count: 'n',
          $return: { n: '$n', genre: '$genre', count: { $count: '$b' } },
        }, bookstore),
        // the 8.95 reference book fails $where: its group never forms,
        // and the singleton result maps to the item itself
        { n: 0, genre: 'fiction', count: 3 });
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $where: { $gt: ['$b.price', 8.9] },
          $groupby: { genre: '$b.category' },
          $orderby: { $key: { $avg: '$b.price' }, $dir: 'desc' },
          $count: 'n',
          $return: { n: '$n', genre: '$genre', count: { $count: '$b' } },
        }, bookstore),
        [
          { n: 0, genre: 'fiction', count: 3 },
          { n: 1, genre: 'reference', count: 1 },
        ]);
    });

    it('should rebind $let and $at bindings across the group too', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: { $in: '$.store.book[*]', $at: 'i' } },
          $let: { p: '$b.price' },
          $groupby: { genre: '$b.category' },
          $return: { genre: '$genre', is: ['$i'], sum: { $sum: '$p' } },
        }, bookstore),
        [
          { genre: 'reference', is: [0], sum: 8.95 },
          { genre: 'fiction', is: [1, 2, 3], sum: 12.99 + 8.99 + 22.99 },
        ]);
    });

    it('should raise JQ2001 for a multi-item grouping key', () => {
      runtimeFails({
        $for: { x: { $const: [[1, 2], [3, 4]] } },
        $groupby: { k: '$x[*]' },
        $return: '$k',
      }, null, 'JQ2001', '/$groupby/k');
    });
  });

  describe('nesting and shadowing', () => {
    it('should express interleavings by nesting (fixture flwor-nested-interleaving)', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { a: '$.store.book[*]' },
          $return: {
            $let: { p: '$a.price' },
            $where: { $gt: ['$p', 10] },
            $return: '$a.title',
          },
        }, bookstore),
        ['Sword of Honour', 'The Lord of the Rings']);
    });

    it('should run for -> let -> for interleavings', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [1, 2] } },
          $return: {
            $let: { d: { $mul: ['$x', 10] } },
            $return: { $for: { y: { $seq: [0, 1] } }, $return: { $add: ['$d', '$y'] } },
          },
        }, null),
        [10, 11, 20, 21]);
    });

    it('should shadow outer bindings inside nested phrases', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [1, 2] } },
          $return: {
            $seq: [{ $for: { x: { $seq: [10, 20] } }, $return: '$x' }, '$x'],
          },
        }, null),
        [10, 20, 1, 10, 20, 2]);
    });

    it('should keep the outer tuple intact across an inner barrier', () => {
      // the inner phrase sorts its own stream per outer tuple
      assert.deepStrictEqual(
        queryJson({
          $for: { x: { $seq: [1, 2] } },
          $return: {
            $for: { y: { $seq: [3, 1] } },
            $orderby: '$y',
            $return: ['$x', '$y'],
          },
        }, null),
        [[1, 1], [1, 3], [2, 1], [2, 3]]);
    });
  });

  describe('quantifiers ($some / $every)', () => {
    it('should run spec example A.7 verbatim', () => {
      assert.strictEqual(
        queryJson({
          $let: { books: '$.store.book[*]' },
          $return: { $some: { b: '$books' }, $satisfies: { $gt: ['$b.price', 20] } },
        }, bookstore),
        true);
    });

    it('should run the fixture quantifier-every document', () => {
      assert.strictEqual(
        queryJson({ $every: { b: '$.store.book[*]' }, $satisfies: { $exists: '$b.title' } }, bookstore),
        true);
      assert.strictEqual(
        queryJson({ $every: { b: '$.store.book[*]' }, $satisfies: { $exists: '$b.isbn' } }, bookstore),
        false);
      assert.strictEqual(
        queryJson({ $some: { b: '$.store.book[*]' }, $satisfies: { $gt: ['$b.price', 100] } }, bookstore),
        false);
    });

    it('should decide empty sources: $some false, $every true', () => {
      assert.strictEqual(queryJson({ $some: { x: '$.missing[*]' }, $satisfies: true }, {}), false);
      assert.strictEqual(queryJson({ $every: { x: '$.missing[*]' }, $satisfies: false }, {}), true);
    });

    it('should nest and correlate multiple bindings', () => {
      const doc = { a: [1, 2, 3], b: [5, 3] };
      assert.strictEqual(
        queryJson({ $some: { x: '$.a[*]', y: '$.b[*]' }, $satisfies: { $eq: ['$x', '$y'] } }, doc),
        true);
      assert.strictEqual(
        queryJson({ $every: { x: '$.a[*]', y: '$.b[*]' }, $satisfies: { $lt: ['$x', '$y'] } }, doc),
        false);
    });

    it('should apply D4 unpacking to quantifier bindings', () => {
      assert.strictEqual(
        queryJson({ $some: { x: '$.matrix[*]' }, $satisfies: { $eq: ['$x', 4] } }, { matrix: [[1, 2], [3, 4]] }),
        true);
      assert.strictEqual(
        queryJson({ $every: { x: '$.matrix[*]' }, $satisfies: { $lt: ['$x', 4] } }, { matrix: [[1, 2], [3, 4]] }),
        false);
    });

    it('should short-circuit at the deciding tuple (later errors unreached)', () => {
      // the second tuple would divide by zero; the first one decides
      assert.strictEqual(
        queryJson({
          $some: { x: { $seq: [1, 0] } },
          $satisfies: { $gt: [{ $idiv: [10, '$x'] }, 0] },
        }, null),
        true);
      assert.strictEqual(
        queryJson({
          $every: { x: { $seq: [1, 0] } },
          $satisfies: { $lt: [{ $idiv: [10, '$x'] }, 5] },
        }, null),
        false);
      // ... and without a deciding tuple first, the error does surface
      runtimeFails({
        $every: { x: { $seq: [0, 1] } },
        $satisfies: { $gt: [{ $idiv: [10, '$x'] }, 0] },
      }, null, 'JQ2002');
    });

    it('should reduce $satisfies by EBV and reject multi-item sequences', () => {
      assert.strictEqual(
        queryJson({ $some: { b: '$.store.book[*]' }, $satisfies: '$b.isbn' }, bookstore),
        true);
      runtimeFails(
        { $some: { x: 1 }, $satisfies: '$.a[*]' },
        { a: [1, 2] }, 'JQ2003', '/$satisfies');
    });
  });

  describe('externals in FLWOR phrases', () => {
    it('should run spec example A.8 verbatim (envelope + external)', () => {
      const q = compileJsonQuery({
        $query: '0.1',
        $expr: {
          $for: { b: '$.store.book[*]' },
          $where: { $ge: ['$b.price', '$minPrice'] },
          $return: '$b.title',
        },
      });
      assert.deepStrictEqual(q.externals, ['minPrice']);
      assert.deepStrictEqual(
        q(bookstore, { minPrice: 10 }),
        ['Sword of Honour', 'The Lord of the Rings']);
      assert.strictEqual(q(bookstore, { minPrice: 100 }), undefined);
    });
  });

  describe('provisional aggregate operators ($count / $sum / $avg)', () => {
    it('should count, sum, and average sequences', () => {
      assert.strictEqual(queryJson({ $count: '$.store.book[*]' }, bookstore), 4);
      assert.strictEqual(
        queryJson({ $sum: '$.store.book[*].price' }, bookstore),
        8.95 + 12.99 + 8.99 + 22.99);
      assert.strictEqual(
        queryJson({ $avg: '$.store.book[*].price' }, bookstore),
        (8.95 + 12.99 + 8.99 + 22.99) / 4);
      assert.strictEqual(queryJson({ $count: '$.missing' }, {}), 0);
      assert.strictEqual(queryJson({ $sum: '$.missing' }, {}), 0);
      assert.strictEqual(queryJson({ $avg: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $sum: 5 }, null), 5);
      assert.strictEqual(queryJson({ $avg: 5 }, null), 5);
    });

    it('should treat a single-key $count object as the operator, not the clause', () => {
      // the operand is the literal string 'n': one item
      assert.strictEqual(queryJson({ $count: 'n' }, null), 1);
    });

    it('should raise JQ2001 for non-number items in $sum/$avg', () => {
      runtimeFails({ $sum: '$.a[*]' }, { a: [1, 'x'] }, 'JQ2001', '/$sum');
      runtimeFails({ $avg: 'x' }, null, 'JQ2001', '/$avg');
      runtimeFails({ $sum: { $const: [1] } }, null, 'JQ2001', '/$sum');
    });
  });

  describe('stableKeyString (engine-internal)', () => {
    it('should serialize deep-equal values identically', () => {
      assert.strictEqual(
        stableKeyString({ b: 1, a: [2, { d: 3, c: 4 }] }),
        stableKeyString({ a: [2, { c: 4, d: 3 }], b: 1 }));
      assert.strictEqual(stableKeyString({ a: 1 }) === stableKeyString({ a: 2 }), false);
    });

    it('should normalize -0 to 0 and keep escape discipline', () => {
      assert.strictEqual(stableKeyString(-0), '0');
      assert.strictEqual(stableKeyString(0), '0');
      assert.strictEqual(stableKeyString(NaN), 'NaN');
      // JSON string escaping: no raw control character ever appears
      assert.strictEqual(stableKeyString('a\u0000b').indexOf('\u0000'), -1);
      assert.notStrictEqual(stableKeyString('a\u0000b'), stableKeyString('a b'));
    });

    it('should keep values of different types apart', () => {
      const keys = [null, true, false, 0, 1, '1', 'true', 'null', '', [], {}, [1], { '1': 1 }]
        .map(stableKeyString);
      assert.strictEqual(new Set(keys).size, keys.length);
    });
  });
});
