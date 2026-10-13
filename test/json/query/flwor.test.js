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

  describe('aggregate operators in FLWOR context ($count / $sum / $avg)', () => {
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

describe('section 6.9 — the $fold accumulator clause', () => {
  const sum = {
    $fold: { a: 0 },
    $for: { n: '$[*]' },
    $return: { $add: ['$a', '$n'] },
  };

  it('should reduce the tuple stream to the final accumulator', () => {
    assert.strictEqual(queryJson(sum, [1, 2, 3, 4]), 10);
  });

  it('should yield the initial value when no tuple survives', () => {
    assert.strictEqual(queryJson(sum, []), 0);
    assert.strictEqual(queryJson({
      $fold: { a: 99 },
      $for: { n: '$[*]' },
      $where: false,
      $return: { $add: ['$a', '$n'] },
    }, [1, 2, 3]), 99, '$where drops every tuple, so nothing updates');
  });

  it('should evaluate the initial value once, in the enclosing scope', () => {
    // referencing a $for binding from the init makes it a free name, not
    // a reference to the binding: the accumulation cannot be circular
    const q = compileJsonQuery({ $fold: { a: '$n' }, $for: { n: '$[*]' }, $return: '$a' });
    assert.deepStrictEqual([...q.externals], ['n']);
  });

  it('should give the language its fold without a function value', () => {
    // walking a runtime JSON Pointer: a reduce over its segments with
    // $get, the primitive a stylesheet needs for a second cursor
    const walk = {
      $fold: { cur: '$.doc' },
      $for: { seg: '$.path[*]' },
      $return: { $get: ['$cur', '$seg'] },
    };
    const data = { doc: { a: { b: [10, 20] } }, path: ['a', 'b', 1] };
    assert.strictEqual(queryJson(walk, data), 20);
    assert.deepStrictEqual(queryJson(walk, { doc: { a: 1 }, path: [] }), { a: 1 },
      'an empty path never updates, so it folds to the document itself');
    assert.strictEqual(queryJson(walk, { doc: { a: 1 }, path: ['nope'] }), undefined,
      'a segment that misses yields the empty sequence');
  });

  it('should compose with $orderby — folding over sorted tuples', () => {
    assert.strictEqual(queryJson({
      $fold: { s: '' },
      $for: { w: '$[*]' },
      $orderby: ['$w'],
      $return: { $concat: ['$s', '$w'] },
    }, ['c', 'a', 'b']), 'abc');
  });

  it('should compose with $groupby — one update per group', () => {
    assert.strictEqual(queryJson({
      $fold: { n: 0 },
      $for: { x: '$[*]' },
      $groupby: { k: '$x.k' },
      $return: { $add: ['$n', 1] },
    }, [{ k: 'a' }, { k: 'b' }, { k: 'a' }]), 2, 'two groups, two updates');
  });

  it('should compose with $where and $count', () => {
    assert.strictEqual(queryJson({
      $fold: { a: 0 },
      $for: { n: '$[*]' },
      $where: { $gt: ['$n', 2] },
      $return: { $add: ['$a', '$n'] },
    }, [1, 2, 3, 4]), 7);
    assert.strictEqual(queryJson({
      $fold: { a: 0 }, $for: { n: '$[*]' }, $count: 'i', $return: '$i',
    }, [5, 5, 5]), 2, '$count is 0-based (D6), so the last tuple sees 2');
  });

  it('should accumulate a composite value', () => {
    assert.deepStrictEqual(queryJson({
      $fold: { acc: { $const: { sum: 0, n: 0 } } },
      $for: { x: '$[*]' },
      $return: { sum: { $add: ['$acc.sum', '$x'] }, n: { $add: ['$acc.n', 1] } },
    }, [2, 4, 6]), { sum: 12, n: 3 });
  });

  it('should reject more than one accumulator', () => {
    assert.throws(() => compileJsonQuery({
      $fold: { a: 0, b: 1 }, $for: { n: '$[*]' }, $return: '$a',
    }), (e) => e.code === 'JQ0003' && /exactly one accumulator/.test(e.message));
    assert.throws(() => compileJsonQuery({
      $fold: {}, $for: { n: '$[*]' }, $return: '$a',
    }), (e) => e.code === 'JQ0003');
  });

  it('should count as a phrase binding for the duplicate rule', () => {
    assert.throws(() => compileJsonQuery({
      $fold: { n: 0 }, $for: { n: '$[*]' }, $return: '$n',
    }), (e) => e.code === 'JQ0007');
  });

  it('should nest — the accumulator restarts per phrase evaluation', () => {
    // the rows are objects: a raw array item would be unpacked by the D4
    // iteration rule and never reach the inner phrase as an array
    assert.deepStrictEqual(queryJson({
      $for: { row: '$[*]' },
      $return: { $fold: { a: 0 }, $for: { c: '$row.v[*]' }, $return: { $add: ['$a', '$c'] } },
    }, [{ v: [1, 2] }, { v: [3, 4] }, { v: [] }]), [3, 7, 0]);
  });
});

describe('section 6.10 — $allowing-empty and window clauses', () => {
  const data = {
    customers: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }],
    orders: [{ cid: 1, x: 'p' }, { cid: 1, x: 'q' }],
  };
  // a path filter's '$' is the input document, so a correlated source is
  // a nested phrase rather than a filter mentioning the outer variable
  const matching = {
    $for: { o: '$.orders[*]' },
    $where: { $eq: ['$o.cid', '$c.id'] },
    $return: '$o',
  };

  it('should drop an unmatched left row without $allowing-empty', () => {
    assert.deepStrictEqual(queryJson({
      $for: { c: '$.customers[*]', o: { $in: matching } },
      $return: { n: '$c.n', x: '$o.x' },
    }, data), [{ n: 'a', x: 'p' }, { n: 'a', x: 'q' }]);
  });

  it('should keep it with $allowing-empty — the outer join', () => {
    assert.deepStrictEqual(queryJson({
      $for: { c: '$.customers[*]', o: { $in: matching, '$allowing-empty': true } },
      $return: { n: '$c.n', x: '$o.x' },
    }, data), [{ n: 'a', x: 'p' }, { n: 'a', x: 'q' }, { n: 'b' }]);
  });

  it('should bind the empty tuple to position -1', () => {
    assert.strictEqual(queryJson({
      $for: { o: { $in: '$.missing[*]', $at: 'i', '$allowing-empty': true } },
      $return: '$i',
    }, data), -1, 'every real position is 0-based, so -1 is the only free marker');
    assert.deepStrictEqual(queryJson({
      $for: { o: { $in: '$.orders[*]', $at: 'i', '$allowing-empty': true } },
      $return: '$i',
    }, data), [0, 1], 'a non-empty source is unaffected');
  });

  it('should fire on "no tuple", not merely "empty sequence"', () => {
    // one item that is an empty array: D4 unpacking yields no tuple, so
    // $allowing-empty is what keeps the row
    assert.strictEqual(queryJson({
      $for: { x: { $in: '$.a', '$allowing-empty': true } },
      $return: { $count: '$x' },
    }, { a: [] }), 0);
  });

  const nums = [1, 2, 3, 4, 5, 6, 7];
  const win = (spec) => queryJson({
    $for: { w: { $in: '$[*]', ...spec } }, $return: ['$w'],
  }, nums);

  it('should partition the stream with a tumbling window', () => {
    assert.deepStrictEqual(win({ $window: 'tumbling', $size: 3 }),
      [[1, 2, 3], [4, 5, 6], [7]]);
    assert.deepStrictEqual(win({ $window: 'tumbling', $size: 7 }), nums,
      'one window over the whole stream is a single array item — singleton ≡ item (2.1)');
    // every item appears exactly once — that is why the short tail stays
    assert.deepStrictEqual(win({ $window: 'tumbling', $size: 3 }).flat(), nums);
  });

  it('should emit only full-width sliding windows', () => {
    assert.deepStrictEqual(win({ $window: 'sliding', $size: 3 }),
      [[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5, 6], [5, 6, 7]]);
    assert.deepStrictEqual(win({ $window: 'sliding', $size: 3, $step: 2 }),
      [[1, 2, 3], [3, 4, 5], [5, 6, 7]]);
    assert.deepStrictEqual(win({ $window: 'sliding', $size: 8 }), undefined,
      'a window wider than the stream is never full');
  });

  it('should number windows with $at and aggregate over them', () => {
    assert.deepStrictEqual(queryJson({
      $for: { w: { $in: '$[*]', $window: 'tumbling', $size: 3, $at: 'i' } },
      $return: { i: '$i', avg: { $avg: '$w' } },
    }, nums), [{ i: 0, avg: 2 }, { i: 1, avg: 5 }, { i: 2, avg: 7 }]);
  });

  it('should yield nothing for an empty stream, unless $allowing-empty', () => {
    assert.strictEqual(queryJson({
      $for: { w: { $in: '$[*]', $window: 'tumbling', $size: 3 } }, $return: { $sum: '$w' },
    }, []), undefined);
    assert.strictEqual(queryJson({
      $for: { w: { $in: '$[*]', $window: 'tumbling', $size: 3, '$allowing-empty': true } },
      $return: { $sum: '$w' },
    }, []), 0, '$sum of the empty sequence is 0');
  });

  it('should reject malformed window specifications', () => {
    const bad = (spec, at) => assert.throws(
      () => compileJsonQuery({ $for: { w: { $in: '$[*]', ...spec } }, $return: '$w' }),
      (e) => e.code === 'JQ0003' && e.docPath === at, JSON.stringify(spec));
    bad({ $window: 'rolling', $size: 3 }, '/$for/w/$window');
    bad({ $window: 'sliding' }, '/$for/w');
    bad({ $size: 3 }, '/$for/w');
    bad({ $step: 2 }, '/$for/w');
    bad({ $window: 'sliding', $size: 0 }, '/$for/w/$size');
    bad({ $window: 'sliding', $size: 2, $step: -1 }, '/$for/w/$step');
    bad({ $window: 'sliding', $size: 1.5 }, '/$for/w/$size');
  });
});

describe('hash-joined equijoins are invisible', () => {
  // Every case below asserts the optimized phrase against the SAME query
  // written so the planner refuses it, so the oracle is the nested loop
  // itself rather than a hand-written expectation.
  const withLet = (doc) => ({ ...doc, $let: { _z: 1 } });
  const bothWays = (doc, data) => {
    const fast = queryJson(doc, data);
    const slow = queryJson(withLet(doc), data);
    assert.deepStrictEqual(fast, slow,
      'the hash join must agree with the nested loop it replaces');
    return fast;
  };

  const joinDoc = {
    $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
    $where: { $eq: ['$b.isbn', '$r.isbn'] },
    $return: { title: '$b.title', stars: '$r.stars' },
  };

  it('should produce the same rows, in the same order', () => {
    assert.deepStrictEqual(bothWays(joinDoc, bookstoreWithRatings), [
      { title: 'Moby Dick', stars: 4 },
      { title: 'The Lord of the Rings', stars: 5 },
    ]);
  });

  it('should emit duplicates on both sides in nested-loop order', () => {
    const data = {
      store: { book: [{ title: 'A', isbn: 'x' }, { title: 'B', isbn: 'x' }] },
      ratings: [{ isbn: 'x', stars: 1 }, { isbn: 'x', stars: 2 }],
    };
    assert.deepStrictEqual(bothWays(joinDoc, data), [
      { title: 'A', stars: 1 }, { title: 'A', stars: 2 },
      { title: 'B', stars: 1 }, { title: 'B', stars: 2 },
    ]);
  });

  it('should never match on an absent or NaN key', () => {
    // books without isbn: the empty sequence witnesses nothing
    assert.deepStrictEqual(bothWays(joinDoc, bookstore), undefined);
    const nan = {
      $for: { a: '$.xs[*]', b: '$.ys[*]' },
      $where: { $eq: ['$a.k', '$b.k'] },
      $return: ['$a.n', '$b.n'],
    };
    const data = { xs: [{ k: { $const: 0 }, n: 1 }], ys: [{ k: 0, n: 2 }] };
    data.xs[0].k = 0 / 0; // NaN, which equals nothing under $eq
    data.ys[0].k = 0 / 0;
    assert.deepStrictEqual(bothWays(nan, data), undefined);
    // -0 and 0 do compare equal, and must still join
    assert.deepStrictEqual(bothWays(nan, { xs: [{ k: -0, n: 1 }], ys: [{ k: 0, n: 2 }] }),
      [1, 2]);
  });

  it('should join on object and array keys by deep equality', () => {
    const doc = {
      $for: { a: '$.xs[*]', b: '$.ys[*]' },
      $where: { $eq: ['$a.k', '$b.k'] },
      $return: ['$a.n', '$b.n'],
    };
    // key order inside the object must not matter (D2)
    assert.deepStrictEqual(
      bothWays(doc, { xs: [{ k: { p: 1, q: 2 }, n: 'a' }], ys: [{ k: { q: 2, p: 1 }, n: 'b' }] }),
      ['a', 'b']);
    assert.deepStrictEqual(
      bothWays(doc, { xs: [{ k: [1, 2], n: 'a' }], ys: [{ k: [1, 2], n: 'b' }] }),
      ['a', 'b']);
    assert.deepStrictEqual(
      bothWays(doc, { xs: [{ k: 1, n: 'a' }], ys: [{ k: '1', n: 'b' }] }), undefined,
      'a number never equals the string that spells it');
  });

  it('should keep the remaining $and conjuncts as a filter', () => {
    const doc = {
      $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
      $where: { $and: [{ $eq: ['$b.isbn', '$r.isbn'] }, { $gt: ['$r.stars', 4] }] },
      $return: { title: '$b.title', stars: '$r.stars' },
    };
    assert.deepStrictEqual(bothWays(doc, bookstoreWithRatings),
      { title: 'The Lord of the Rings', stars: 5 }, 'one row is one item (2.1)');
  });

  it('should decline when the equality is not the first conjunct', () => {
    // moving it first would skip an evaluation that used to happen, so
    // the phrase stays a nested loop — and stays correct
    const doc = {
      $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
      $where: { $and: [{ $gt: ['$r.stars', 3] }, { $eq: ['$b.isbn', '$r.isbn'] }] },
      $return: { title: '$b.title', stars: '$r.stars' },
    };
    assert.deepStrictEqual(bothWays(doc, bookstoreWithRatings), [
      { title: 'Moby Dick', stars: 4 },
      { title: 'The Lord of the Rings', stars: 5 },
    ]);
  });

  it('should decline a correlated probe side', () => {
    // the inner source reads the outer binding, so no single table exists
    const doc = {
      $for: {
        b: '$.store.book[*]',
        r: { $in: { $for: { x: '$.ratings[*]' }, $where: { $eq: ['$x.isbn', '$b.isbn'] }, $return: '$x' } },
      },
      $where: { $eq: ['$b.isbn', '$r.isbn'] },
      $return: { title: '$b.title', stars: '$r.stars' },
    };
    assert.deepStrictEqual(queryJson(doc, bookstoreWithRatings), [
      { title: 'Moby Dick', stars: 4 },
      { title: 'The Lord of the Rings', stars: 5 },
    ]);
  });

  it('should still run $as over every tuple the loop would form', () => {
    // the join must not retract an assertion by never forming the tuple
    const doc = {
      $for: { a: '$.xs[*]', b: '$.ys[*]' },
      $as: { b: { type: 'object', required: ['k'] } },
      $where: { $eq: ['$a.k', '$b.k'] },
      $return: '$a.k',
    };
    const data = { xs: [{ k: 1 }], ys: [{ k: 1 }, { other: true }] };
    assert.throws(() => queryJson(doc, data, undefined),
      (e) => e.code === 'JQ0008' || e.code === 'JQ2008',
      'without a type-test hook this is JQ0008; with one it must be JQ2008');
  });

  it('should decline when a key can be a multi-item sequence', () => {
    // $eq is existential over sequences; a bucket holds one key per item
    const doc = {
      $for: { a: '$.xs[*]', b: '$.ys[*]' },
      $where: { $eq: ['$a.ks[*]', '$b.k'] },
      $return: ['$a.n', '$b.n'],
    };
    assert.deepStrictEqual(
      bothWays(doc, { xs: [{ ks: [1, 2], n: 'a' }], ys: [{ k: 2, n: 'b' }] }), ['a', 'b']);
  });

  it('should unpack array items into the table exactly as $for does', () => {
    const doc = {
      $for: { a: '$.xs[*]', b: '$.ys' },
      $where: { $eq: ['$a.k', '$b.k'] },
      $return: '$b.n',
    };
    // '$.ys' is one array item, which D4 unpacks into its members
    assert.strictEqual(
      bothWays(doc, { xs: [{ k: 7 }], ys: [{ k: 7, n: 'hit' }, { k: 8, n: 'miss' }] }), 'hit');
  });

  it('should rebuild its table per phrase evaluation when nested', () => {
    const doc = {
      $for: { g: '$.groups[*]' },
      $return: {
        $for: { a: '$g.xs[*]', b: '$g.ys[*]' },
        $where: { $eq: ['$a.k', '$b.k'] },
        $return: '$b.n',
      },
    };
    assert.deepStrictEqual(queryJson(doc, {
      groups: [
        { xs: [{ k: 1 }], ys: [{ k: 1, n: 'one' }] },
        { xs: [{ k: 2 }], ys: [{ k: 2, n: 'two' }] },
      ],
    }), ['one', 'two'], 'a stale table would answer the second group wrong');
  });
});

describe('spatial joins are screened by an index, invisibly', () => {
  // Same oracle discipline as the hash-join suite: a `$let` makes the
  // planner refuse the rewrite, so the nested scan is the reference.
  const withLet = (doc) => ({ ...doc, $let: { _z: 1 } });
  const bothWays = (doc, data) => {
    const indexed = queryJson(doc, data);
    const scanned = queryJson(withLet(doc), data);
    assert.deepStrictEqual(indexed, scanned,
      'the indexed probe must agree with the scan it replaces');
    return indexed;
  };

  const region = (id, x, y, w = 2) => ({
    id,
    geom: { type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]] },
  });
  const data = {
    regions: [region('a', 0, 0), region('b', 10, 10), region('c', 20, 20)],
    points: [
      { id: 'p1', at: [1, 1] },
      { id: 'p2', at: [11, 11] },
      { id: 'p3', at: [99, 80] },
    ],
  };
  const joinDoc = {
    $for: { p: '$.points[*]', r: '$.regions[*]' },
    $where: { $within: ['$p.at', '$r.geom'] },
    $return: { p: '$p.id', r: '$r.id' },
  };

  it('should find exactly the pairs the scan finds', () => {
    assert.deepStrictEqual(bothWays(joinDoc, data), [
      { p: 'p1', r: 'a' },
      { p: 'p2', r: 'b' },
    ]);
  });

  it('should screen $bbox-intersects too', () => {
    const doc = {
      $for: { p: '$.points[*]', r: '$.regions[*]' },
      $where: { '$bbox-intersects': ['$p.at', '$r.geom'] },
      $return: '$r.id',
    };
    assert.deepStrictEqual(bothWays(doc, data), ['a', 'b']);
  });

  it('should keep a point on a region boundary', () => {
    // the boundary counts as inside, and the index must not clip it off
    const edge = { regions: [region('a', 0, 0)], points: [{ id: 'e', at: [0, 1] }] };
    assert.deepStrictEqual(bothWays(joinDoc, edge), { p: 'e', r: 'a' });
  });

  it('should still raise what a scan would raise on a bad operand', () => {
    // an item with no computable box cannot be screened, so it has to
    // reach the predicate anyway — otherwise the index would swallow
    // the error the scan reports
    const bad = {
      regions: [{ id: 'x', geom: 'not a geometry' }],
      points: [{ id: 'p', at: [1, 1] }],
    };
    assert.throws(() => queryJson(joinDoc, bad), (e) => e.code === 'JQ2001');
    assert.throws(() => queryJson(withLet(joinDoc), bad), (e) => e.code === 'JQ2001');
  });

  it('should fall back to a scan when the probe side has no box', () => {
    const noBox = {
      regions: [region('a', 0, 0)],
      points: [{ id: 'p', at: { type: 'Feature', geometry: null } }],
    };
    assert.deepStrictEqual(bothWays(joinDoc, noBox), undefined);
  });

  it('should decline a correlated probe side', () => {
    const doc = {
      $for: {
        p: '$.points[*]',
        r: { $in: { $for: { x: '$.regions[*]' }, $where: { $eq: ['$x.id', '$p.id'] }, $return: '$x' } },
      },
      $where: { $within: ['$p.at', '$r.geom'] },
      $return: '$r.id',
    };
    assert.strictEqual(queryJson(doc, data), undefined, 'no point id matches a region id');
  });

  it('should decline when the predicate is not the whole $where', () => {
    // an $and could throw in a conjunct the index would skip
    const doc = {
      $for: { p: '$.points[*]', r: '$.regions[*]' },
      $where: { $and: [{ $within: ['$p.at', '$r.geom'] }, { $ne: ['$r.id', 'b'] }] },
      $return: { p: '$p.id', r: '$r.id' },
    };
    assert.deepStrictEqual(bothWays(doc, data), { p: 'p1', r: 'a' });
  });

  it('should rebuild its index per phrase evaluation when nested', () => {
    const doc = {
      $for: { g: '$.groups[*]' },
      $return: {
        $for: { p: '$g.points[*]', r: '$g.regions[*]' },
        $where: { $within: ['$p.at', '$r.geom'] },
        $return: '$r.id',
      },
    };
    assert.deepStrictEqual(queryJson(doc, {
      groups: [
        { regions: [region('one', 0, 0)], points: [{ at: [1, 1] }] },
        { regions: [region('two', 50, 50)], points: [{ at: [51, 51] }] },
      ],
    }), ['one', 'two'], 'a stale index would answer the second group wrong');
  });

  it('should scale sub-linearly where a scan does not', () => {
    // the point of the whole exercise: the same answer, less work
    const regions = [];
    for (let i = 0; i < 30; i++)
      for (let j = 0; j < 20; j++) regions.push(region(`${i}-${j}`, i * 9 - 180, j * 8 - 85, 8));
    const points = [];
    for (let k = 0; k < 60; k++)
      points.push({ id: k, at: [(k % 30) * 9 - 176, ((k * 7) % 20) * 8 - 81] });
    const big = { regions, points };
    const indexed = queryJson(joinDoc, big);
    assert.deepStrictEqual(indexed, queryJson(withLet(joinDoc), big));
    assert.ok(Array.isArray(indexed) && indexed.length === 60,
      `every point should land in one region, got ${indexed?.length}`);
  });

  it('should answer in the order the scan answers', () => {
    // forty squares around one point: the tree visits them in its own
    // order, and the phrase still answers them in the regions' order
    const squares = [];
    for (let i = 0; i < 40; i++)
      squares.push(region(`r${i}`, 4 - (i % 7) * 0.1, 4 - Math.floor(i / 7) * 0.1, 3));
    const doc = {
      $for: { p: '$.points[*]', r: '$.regions[*]' },
      $where: { $within: ['$p.at', '$r.geom'] },
      $return: '$r.id',
    };
    assert.deepStrictEqual(bothWays(doc, { points: [{ id: 'p', at: [5, 5] }], regions: squares }),
      squares.map((r) => r.id));
  });

  it('should raise the error the scan reaches first', () => {
    // the malformed region comes before the hit: the scan raises on it
    // before any tuple reaches $return, so the probe must too
    const doc = { ...joinDoc, $return: { $idiv: [1, 0] } };
    const data = {
      points: [{ id: 'p', at: [1, 1] }],
      regions: [{ id: 'bad', geom: 'not a geometry' }, region('a', 0, 0)],
    };
    runtimeFails(withLet(doc), data, 'JQ2001', '/$where/$within/1');
    runtimeFails(doc, data, 'JQ2001', '/$where/$within/1');
  });
});

describe('index probes evaluate what the scan evaluates, when it evaluates it', () => {
  // Every probe the planner installs - the hash join, the spatial screen
  // and the interval screen - against the scan it replaces (a `$let` makes
  // the planner decline), outcome for outcome: the same answer, or the
  // same first error.
  const withLet = (doc) => ({ ...doc, $let: { _z: 1 } });
  const outcome = (doc, data, options = {}) => {
    try {
      return { value: compileJsonQuery(doc, options.compile)(data, options.externals) };
    }
    catch (e) {
      if (!(e instanceof JsonQueryRuntimeError))
        throw e;
      return { code: e.code, docPath: e.docPath, message: e.message };
    }
  };
  const bothWays = (doc, data, options) => {
    const probed = outcome(doc, data, options);
    assert.deepStrictEqual(probed, outcome(withLet(doc), data, options),
      'the probe must answer exactly what the scan answers');
    return probed;
  };
  const failed = (result) => ({ code: result.code, docPath: result.docPath });

  const square = (x, y, w = 2) => ({
    type: 'Polygon', coordinates: [[[x, y], [x + w, y], [x + w, y + w], [x, y + w], [x, y]]],
  });
  // one row shape carries an operand for every predicate
  const outerRow = { k: 1, at: [1, 1], geom: square(0, 0), span: { start: 0, end: 10 } };
  const innerRow = (id) => ({ id, k: 1, at: [1, 1], geom: square(0, 0), span: { start: 1, end: 2 } });
  const many = Array.from({ length: 200 }, (_, i) => innerRow(`i${i}`));

  // the three predicates, spelled with the outer operand first and with
  // the inner one first; `o`/`i` name the operand on each side
  const KINDS = {
    hash: { first: (o, i) => ({ $eq: [o('k'), i('k')] }), second: (o, i) => ({ $eq: [i('k'), o('k')] }) },
    spatial: { first: (o, i) => ({ $within: [o('at'), i('geom')] }), second: (o, i) => ({ $within: [i('at'), o('geom')] }) },
    interval: { first: (o, i) => ({ $overlaps: [o('span'), i('span')] }), second: (o, i) => ({ $overlaps: [i('span'), o('span')] }) },
  };
  const OP = { hash: '$eq', spatial: '$within', interval: '$overlaps' };
  const outerOf = (m) => `$a.${m}`;
  const innerOf = (m) => `$b.${m}`;
  const join = (kind, $for, extra = {}) => ({
    $for, $where: KINDS[kind].first(outerOf, innerOf), $return: '$b.id', ...extra,
  });
  const raising = { $idiv: [1, 0] };

  it('should evaluate nothing of the inner side when no outer tuple reaches it', () => {
    for (const kind of Object.keys(KINDS)) {
      assert.deepStrictEqual(bothWays(join(kind, { a: '$.outer[*]', b: raising }), { outer: [] }),
        { value: undefined }, `${kind}: an empty outer side`);
      assert.deepStrictEqual(bothWays(join(kind, { a: '$.outer[*]', b: raising }), {}),
        { value: undefined }, `${kind}: a missing outer side`);
      assert.deepStrictEqual(bothWays(join(kind, { a: '$.outer[*]', t: '$.tags[*]', b: raising }),
        { outer: [outerRow], tags: [] }), { value: undefined }, `${kind}: an empty binding between them`);
      assert.deepStrictEqual(bothWays(join(kind, { a: '$.outer[*]', b: { $sum: ['$.inner[*].w'] } }),
        { outer: [], inner: [{ w: 'x' }] }), { value: undefined }, `${kind}: an inner side that cannot be summed`);
      // the join between the middle binding and the innermost one
      const middle = {
        $for: { z: '$.zs[*]', a: '$.outer[*]', b: raising },
        $where: KINDS[kind].first(outerOf, innerOf), $return: '$b.id',
      };
      assert.deepStrictEqual(bothWays(middle, { zs: [], outer: [outerRow] }), { value: undefined },
        `${kind}: an empty first binding`);
      assert.deepStrictEqual(bothWays(middle, { zs: [1, 2], outer: [] }), { value: undefined },
        `${kind}: an empty middle binding`);
    }
  });

  it('should raise the outer source\'s error when both sources raise', () => {
    for (const kind of Object.keys(KINDS)) {
      assert.deepStrictEqual(failed(bothWays(join(kind, { a: { $idiv: [2, 0] }, b: raising }), {})),
        { code: 'JQ2002', docPath: '/$for/a/$idiv' }, kind);
    }
  });

  it('should read the outer operand only where the scan reads it', () => {
    // `$win` is an external nobody bound: reading it is JQ2006
    const unbound = (where) => ({ $for: { a: '$.outer[*]', b: '$.inner' }, $where: where, $return: '$b.id' });
    const win = () => '$win';
    for (const [kind, spell] of Object.entries(KINDS)) {
      // no inner item: no pair, nothing read
      assert.deepStrictEqual(bothWays(unbound(spell.first(win, innerOf)), { outer: [1], inner: [] }),
        { value: undefined }, `${kind}: no inner item`);
      // read first, it is read at every pair
      assert.deepStrictEqual(failed(bothWays(unbound(spell.first(win, innerOf)), { outer: [1], inner: [{ id: 'x' }] })),
        { code: 'JQ2006', docPath: `/$where/${OP[kind]}/0` }, `${kind}: the outer operand first`);
    }
    // read second, `$eq` and `$overlaps` stop at a missing first operand
    // and never read it; `$within` reads both of its operands
    const second = (kind) => bothWays(unbound(KINDS[kind].second(win, innerOf)), { outer: [1], inner: [{ id: 'x' }] });
    assert.deepStrictEqual(second('hash'), { value: undefined });
    assert.deepStrictEqual(second('interval'), { value: undefined });
    assert.deepStrictEqual(failed(second('spatial')), { code: 'JQ2006', docPath: '/$where/$within/1' });
  });

  it('should never spend a step the scan would not have spent', () => {
    for (const kind of Object.keys(KINDS)) {
      // nothing reaches the inner side, so nothing is counted for it
      assert.deepStrictEqual(bothWays(join(kind, { a: '$.outer[*]', b: '$.inner[*]' }),
        { outer: [], inner: many }, { compile: { limits: { steps: 50 } } }), { value: undefined }, kind);
      // the scan raises in $return at the first pair, well inside the
      // limit; indexing two hundred rows must not spend it first
      assert.deepStrictEqual(failed(bothWays(join(kind, { a: '$.outer[*]', b: '$.inner[*]' }, { $return: raising }),
        { outer: [outerRow], inner: many }, { compile: { limits: { steps: 60 } } })),
      { code: 'JQ2002', docPath: '/$return/$idiv' }, kind);
    }
    // the other way round is the point: the hash join consumes the
    // equality, so it finishes inside a limit the scan exceeds
    const doc = join('hash', { a: '$.outer[*]', b: '$.inner[*]' });
    const options = { compile: { limits: { steps: 600 } } };
    assert.strictEqual(outcome(doc, { outer: [outerRow], inner: many }, options).value.length, 200);
    assert.strictEqual(outcome(withLet(doc), { outer: [outerRow], inner: many }, options).code, 'JQ2009');
  });

  it('should run a $call inner source once, at the first outer tuple that reaches it', () => {
    // the scan calls it once per outer tuple; registered functions are
    // pure, so only the count can tell the two apart
    for (const kind of Object.keys(KINDS)) {
      let calls = 0;
      const functions = { rows: () => { calls++; return [innerRow('x')]; } };
      const doc = join(kind, { a: '$.outer[*]', b: { $call: ['rows'] } });
      const counted = (data, scan) => {
        calls = 0;
        const result = outcome(scan ? withLet(doc) : doc, data, { compile: { functions } });
        return { result, calls };
      };
      assert.deepStrictEqual(counted({ outer: [] }, false), { result: { value: undefined }, calls: 0 }, kind);
      assert.deepStrictEqual(counted({ outer: [] }, true), { result: { value: undefined }, calls: 0 }, kind);
      const three = { outer: [outerRow, outerRow, outerRow] };
      assert.deepStrictEqual(counted(three, false), { result: { value: ['x', 'x', 'x'] }, calls: 1 }, kind);
      assert.deepStrictEqual(counted(three, true), { result: { value: ['x', 'x', 'x'] }, calls: 3 }, kind);
    }
  });

  it('should answer a $range inner source without building it, whatever the guard on a build', () => {
    // a phrase limit tightens the $range guard: built, the range would
    // be refused; the equality is probed and the screens left to the
    // scan, which counts through the range, so none of them builds it
    const options = { compile: { limits: { sequenceItems: 10 } } };
    const doc = (where) => ({ $for: { a: '$.outer[*]', b: { $range: [1, 20] } }, $where: where, $return: '$b' });
    const data = { outer: [outerRow] };
    assert.deepStrictEqual(bothWays(doc({ $eq: ['$a.k', '$b'] }), data, options), { value: 1 });
    assert.deepStrictEqual(failed(bothWays(doc({ $within: ['$a.at', '$b'] }), data, options)),
      { code: 'JQ2001', docPath: '/$where/$within/1' });
    assert.deepStrictEqual(failed(bothWays(doc({ $overlaps: ['$a.span', '$b'] }), data, options)),
      { code: 'JQ2001', docPath: '/$where/$overlaps/1' });
  });

  it('should skip every pair of an outer operand that is missing', () => {
    // a missing operand makes every pair false (or empty) without an
    // error, so nothing need be visited; the inner operand comes first
    // here, so each pair the scan visits reads it
    for (const kind of ['spatial', 'interval']) {
      const member = kind === 'spatial' ? 'at' : 'span';
      let reads = 0;
      const inner = [0, 1, 2, 3].map((n) => {
        const row = { id: `i${n}` };
        const value = innerRow(row.id)[member];
        Object.defineProperty(row, member, {
          enumerable: true,
          get() {
            reads++;
            return value;
          },
        });
        return row;
      });
      const doc = { $for: { a: '$.outer[*]', b: '$.inner[*]' }, $where: KINDS[kind].second(outerOf, innerOf), $return: '$b.id' };
      const data = { outer: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }], inner };
      assert.deepStrictEqual(outcome(doc, data), { value: undefined });
      assert.strictEqual(reads, 4, `${kind}: each inner operand read once, to index it`);
      reads = 0;
      assert.deepStrictEqual(outcome(withLet(doc), data), { value: undefined });
      assert.strictEqual(reads, 12, `${kind}: the scan reads one per pair`);
    }
  });
});

describe('a join over a $range inner source is probed without building the range', () => {
  // The oracle is the same phrase with a `$let`, which makes the planner
  // decline and run the nested loop. An outer row whose `k` is an accessor
  // counts the equality's reads: the scan reads it once per pair, the probe
  // once per outer row.
  const withLet = (doc) => ({ ...doc, $let: { _z: 1 } });
  const outcome = (doc, data, options = {}) => {
    try {
      return { value: compileJsonQuery(doc, options.compile)(data) };
    }
    catch (e) {
      if (!(e instanceof JsonQueryRuntimeError))
        throw e;
      return { code: e.code, docPath: e.docPath, message: e.message };
    }
  };
  const bothWays = (doc, data, options) => {
    const probed = outcome(doc, data, options);
    assert.deepStrictEqual(probed, outcome(withLet(doc), data, options),
      'the probe must answer exactly what the scan answers');
    return probed;
  };
  const counted = (keys, counter) => keys.map((k, i) => {
    const row = { id: `o${i}` };
    Object.defineProperty(row, 'k', {
      enumerable: true,
      get() {
        counter.reads++;
        return k;
      },
    });
    return row;
  });
  const join = (range, where, extra = {}) => ({
    $for: { a: '$.outer[*]', b: { $range: range } }, $where: where, $return: { a: '$a.id', b: '$b' }, ...extra,
  });
  const eq = { $eq: ['$a.k', '$b'] };
  const rows = (...flat) => Array.from({ length: flat.length / 2 }, (_, i) => ({ a: flat[2 * i], b: flat[2 * i + 1] }));
  const failedAt = (result) => ({ code: result.code, docPath: result.docPath });

  it('should read the outer key once per outer row, not once per pair', () => {
    const keys = [3, 1, 3, 99, 0, 7, 1];
    const doc = join([1, 8], eq);
    const answers = [];
    for (const scan of [false, true]) {
      const counter = { reads: 0 };
      answers.push(outcome(scan ? withLet(doc) : doc, { outer: counted(keys, counter) }));
      assert.strictEqual(counter.reads, scan ? 56 : 7, scan ? 'the scan reads one per pair' : 'one read per outer row');
    }
    assert.deepStrictEqual(answers[0], answers[1]);
    assert.deepStrictEqual(answers[0].value, rows('o0', 3, 'o1', 1, 'o2', 3, 'o5', 7, 'o6', 1));
  });

  it('should answer a single outer row against a long range without counting or building it', () => {
    const counter = { reads: 0 };
    const options = { compile: { limits: { sequenceItems: 10 } } };
    const result = outcome(join([1, 100000], eq), { outer: counted([99999], counter) }, options);
    assert.deepStrictEqual(result, { value: { a: 'o0', b: 99999 } });
    assert.strictEqual(counter.reads, 1);
  });

  it('should answer a range as wide as the safe integers in one step', () => {
    const top = Number.MAX_SAFE_INTEGER;
    const doc = join([-top, top], eq);
    const keys = [top, -top, 0, top + 1, 1.5];
    // a step limit turns a scan over the 2^54 items into a refusal instead of a wait
    const options = { compile: { limits: { steps: 100000 } } };
    assert.deepStrictEqual(outcome(doc, { outer: counted(keys, { reads: 0 }) }, options),
      { value: rows('o0', top, 'o1', -top, 'o2', 0) });
  });

  it('should fill the range variable with the item the counting loop reaches, as it reaches it', () => {
    // the first item is the lower bound as handed over, a negative zero
    // included; every later item is a sum, so zero there is positive
    const result = outcome(join([-1, 1], eq), { outer: counted([-0, 0], { reads: 0 }) });
    assert.strictEqual(result.value.length, 2);
    for (const row of result.value)
      assert.ok(Object.is(row.b, 0), 'the item is 0');
    const lead = join(['$.lo', 2], eq);
    for (const lo of [-0, 0]) {
      const answer = bothWays(lead, { outer: counted([0, -0, 1, -0], { reads: 0 }), lo });
      assert.strictEqual(answer.value.length, 4);
      assert.deepStrictEqual(answer.value.map((row) => Object.is(row.b, -0)), Object.is(lo, -0) ? [true, true, false, true] : [false, false, false, false],
        `lower bound ${Object.is(lo, -0) ? '-0' : '0'}`);
    }
    // a negative zero as the upper bound or as the only item
    assert.deepStrictEqual(bothWays(join(['$.lo', '$.lo'], eq), { outer: counted([0], { reads: 0 }), lo: -0 }), { value: { a: 'o0', b: -0 } });
    assert.deepStrictEqual(bothWays(join([-1, '$.lo'], eq), { outer: counted([0], { reads: 0 }), lo: -0 }), { value: { a: 'o0', b: 0 } });
  });

  it('should match only a number that is an integer inside the bounds', () => {
    const keys = [2, 2.0, 2.5, '2', null, true, [2], { k: 2 }, NaN, Infinity, 1e21, 6, 0];
    const doc = join([1, 5], eq);
    assert.deepStrictEqual(bothWays(doc, { outer: counted(keys, { reads: 0 }) }), { value: rows('o0', 2, 'o1', 2) });
  });

  it('should keep the inner key on either side and the residual conjuncts after the equality', () => {
    const data = { outer: counted([2, 4, 4, 9], { reads: 0 }) };
    assert.deepStrictEqual(bothWays(join([1, 5], { $eq: ['$b', '$a.k'] }), data),
      { value: rows('o0', 2, 'o1', 4, 'o2', 4) });
    assert.deepStrictEqual(bothWays(join([1, 5], { $and: [eq, { $gt: ['$b', 2] }] }), data),
      { value: rows('o1', 4, 'o2', 4) });
    // a conjunct that raises is reached only for a pair the equality kept
    assert.deepStrictEqual(failedAt(bothWays(join([1, 5], { $and: [eq, { $idiv: ['$b', 0] }] }), data)),
      { code: 'JQ2002', docPath: '/$where/$and/1/$idiv' });
    assert.deepStrictEqual(bothWays(join([1, 5], { $and: [eq, { $idiv: ['$b', 0] }] }), { outer: counted([9], { reads: 0 }) }),
      { value: undefined });
  });

  it('should read the bounds as the counting loop reads them', () => {
    const data = { outer: counted([1, 2], { reads: 0 }), n: 3 };
    assert.deepStrictEqual(bothWays(join([1, '$.n'], eq), data), { value: rows('o0', 1, 'o1', 2) });
    assert.deepStrictEqual(bothWays(join([5, 1], eq), data), { value: undefined }, 'a descending range is empty');
    assert.deepStrictEqual(bothWays(join([1, '$.missing'], eq), data), { value: undefined }, 'a missing bound is an empty range');
    assert.deepStrictEqual(bothWays(join([1, 0], eq), data), { value: undefined });
    assert.deepStrictEqual(bothWays(join([2, 2], eq), data), { value: { a: 'o1', b: 2 } });
    assert.deepStrictEqual(bothWays(join([-1, 1], eq), { outer: counted([1, -1], { reads: 0 }) }), { value: rows('o0', 1, 'o1', -1) });
    assert.deepStrictEqual(failedAt(bothWays(join([1, 2.5], eq), data)), { code: 'JQ2001', docPath: '/$for/b/$range/1' });
    assert.deepStrictEqual(failedAt(bothWays(join(['1', 3], eq), data)), { code: 'JQ2001', docPath: '/$for/b/$range/0' });
  });

  it('should read the bounds once per evaluation, where the scan reads them per outer row', () => {
    let reads = 0;
    const data = { outer: counted([1, 2, 3], { reads: 0 }) };
    Object.defineProperty(data, 'n', {
      enumerable: true,
      get() {
        reads++;
        return 3;
      },
    });
    const doc = join([1, '$.n'], eq);
    assert.deepStrictEqual(outcome(doc, data).value, rows('o0', 1, 'o1', 2, 'o2', 3));
    assert.strictEqual(reads, 1);
    reads = 0;
    outcome(withLet(doc), data);
    assert.strictEqual(reads, 3);
  });

  it('should raise a bound error only where the scan evaluates the range', () => {
    const doc = join([1, { $idiv: [1, 0] }], eq);
    assert.deepStrictEqual(bothWays(doc, { outer: [] }), { value: undefined }, 'no outer row reaches the range');
    assert.deepStrictEqual(failedAt(bothWays(doc, { outer: [{ id: 'o', k: 1 }] })),
      { code: 'JQ2002', docPath: '/$for/b/$range/1/$idiv' });
  });

  it('should read the lower bound before the upper, and check it first', () => {
    const order = [];
    const data = { outer: counted([1], { reads: 0 }) };
    for (const name of ['lo', 'hi']) {
      Object.defineProperty(data, name, {
        enumerable: true,
        get() {
          order.push(name);
          return name === 'lo' ? 1 : 2;
        },
      });
    }
    assert.deepStrictEqual(bothWays(join(['$.lo', '$.hi'], eq), data), { value: { a: 'o0', b: 1 } });
    assert.deepStrictEqual(order.slice(0, 2), ['lo', 'hi']);
    assert.deepStrictEqual(order.slice(2, 4), ['lo', 'hi'], 'the scan reads them in the same order');
    // both bounds bad: the lower bound's refusal comes first
    assert.deepStrictEqual(failedAt(bothWays(join([2.5, 'x'], eq), { outer: counted([1], { reads: 0 }) })),
      { code: 'JQ2001', docPath: '/$for/b/$range/0' });
  });

  it('should not read the outer key beside an empty range', () => {
    const counter = { reads: 0 };
    const data = { outer: counted([1, 2, 3], counter) };
    assert.deepStrictEqual(outcome(join([3, 1], eq), data), { value: undefined });
    assert.strictEqual(counter.reads, 0);
  });

  it('should probe a range beneath two outer bindings and against an outer range', () => {
    const doc = {
      $for: { z: { $range: [1, 2] }, a: '$.outer[*]', b: { $range: [1, 4] } },
      $where: eq,
      $return: { z: '$z', a: '$a.id', b: '$b' },
    };
    assert.deepStrictEqual(bothWays(doc, { outer: counted([4, 2], { reads: 0 }) }), {
      value: [[1, 'o0', 4], [1, 'o1', 2], [2, 'o0', 4], [2, 'o1', 2]].map(([z, a, b]) => ({ z, a, b })),
    });
    const ranges = { $for: { a: { $range: [-2, 6] }, b: { $range: [0, 4] } }, $where: { $eq: ['$a', '$b'] }, $return: '$a' };
    assert.deepStrictEqual(bothWays(ranges, {}), { value: [0, 1, 2, 3, 4] });
  });

  it('should leave what it cannot answer to the scan', () => {
    // a range whose bound reads an outer binding, an inner key that is not
    // the range variable itself, and a screened predicate
    const data = { outer: [{ id: 'o', k: 2, at: [1, 1], span: { start: 0, end: 5 } }, { id: 'p', k: 4, at: [1, 1], span: { start: 0, end: 5 } }] };
    const correlated = { $for: { a: '$.outer[*]', b: { $range: [1, '$a.k'] } }, $where: eq, $return: '$b' };
    assert.deepStrictEqual(bothWays(correlated, data), { value: [2, 4] });
    const member = { $for: { a: '$.outer[*]', b: { $range: [1, 5] } }, $where: { $eq: ['$a.k', '$b.x'] }, $return: '$b' };
    assert.deepStrictEqual(bothWays(member, data), { value: undefined });
    for (const where of [{ $within: ['$a.at', '$b'] }, { $overlaps: ['$a.span', '$b'] }]) {
      assert.strictEqual(bothWays(join([1, 3], where), data).code, 'JQ2001');
    }
  });

  it('should agree with the nested loop on random phrases', () => {
    let seed = 20261013;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const keys = [0, -0, 1, 2, 3, 5, 7, -3, 1.5, '1', null, true, [1], { k: 1 }, NaN, 1e21];
    const bounds = [1, 5, 0, -2, 4, 8, 3, 2.5, '3', null, '$.n', '$.missing', '$.list', { $idiv: [1, 0] }];
    let answered = 0;
    let raised = 0;
    for (let round = 0; round < 400; round++) {
      const outer = Array.from({ length: Math.floor(random() * 12) }, (_, i) => ({ id: `o${i}`, k: pick(keys) }));
      const key = pick([eq, { $eq: ['$b', '$a.k'] }]);
      const where = pick([key, key, { $and: [key, { $gt: ['$b', 2] }] }, { $and: [key, { $idiv: ['$b', 0] }] }, { $and: [key] }]);
      const doc = join([pick(bounds), pick(bounds)], where);
      const result = bothWays(doc, { outer, n: 4, list: [1, 2] });
      if (result.code === undefined)
        answered++;
      else
        raised++;
    }
    assert.ok(answered > 100 && raised > 20, `answered ${answered}, raised ${raised}`);
  });

  it('should grow with the sides, not their product', () => {
    // equal outer and range lengths over an 8x step: the equality's reads
    // are the count of pairs examined
    const run = (n) => {
      const counter = { reads: 0 };
      const keys = Array.from({ length: n }, (_, i) => i + 1);
      const result = outcome(join([1, n], eq), { outer: counted(keys, counter) });
      assert.strictEqual(result.value.length, n);
      return counter.reads;
    };
    assert.strictEqual(run(1000), 1000);
    assert.strictEqual(run(8000), 8000);
  });
});
