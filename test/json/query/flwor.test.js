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
});
