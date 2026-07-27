import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileJsonQuery,
  queryJson,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'query-format');

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

// NaN and -0 are only reachable through evaluation; these expressions
// construct them inside query documents
const NAN = { $div: [0, 0] };
const NEG_ZERO = { $neg: 0 };

describe('Jaren JSON Query operator library', () => {

  //#region aggregates (section 8.8)

  describe('aggregates - $count / $sum / $avg', () => {
    it('should count, sum, and average number sequences', () => {
      assert.strictEqual(queryJson({ $count: '$.store.book[*]' }, bookstore), 4);
      assert.strictEqual(
        queryJson({ $sum: '$.store.book[*].price' }, bookstore),
        8.95 + 12.99 + 8.99 + 22.99);
      assert.strictEqual(
        queryJson({ $avg: '$.store.book[*].price' }, bookstore),
        (8.95 + 12.99 + 8.99 + 22.99) / 4);
    });

    it('should handle the empty sequence per F&O', () => {
      assert.strictEqual(queryJson({ $count: '$.missing' }, {}), 0);
      assert.strictEqual(queryJson({ $sum: '$.missing' }, {}), 0);
      assert.strictEqual(queryJson({ $avg: '$.missing' }, {}), undefined);
    });

    it('should see sequences as-is: an array item is one item (no D4)', () => {
      assert.strictEqual(queryJson({ $count: { $const: [1, 2, 3] } }, null), 1);
      assert.strictEqual(queryJson({ $count: [1, 2, 3] }, null), 1); // array constructor: one array item
      assert.strictEqual(queryJson({ $count: { $seq: [1, 2, 3] } }, null), 3);
      // ... the asymmetry with $for, which D4-unpacks the array item
      assert.deepStrictEqual(
        queryJson({ $for: { x: { $const: [1, 2, 3] } }, $return: '$x' }, null),
        [1, 2, 3]);
    });

    it('should raise JQ2001 for non-number items', () => {
      runtimeFails({ $sum: '$.a[*]' }, { a: [1, 'x'] }, 'JQ2001', '/$sum');
      runtimeFails({ $avg: 'x' }, null, 'JQ2001', '/$avg');
      runtimeFails({ $sum: { $const: [1] } }, null, 'JQ2001', '/$sum');
      runtimeFails({ a: { $avg: { $seq: [1, null] } } }, null, 'JQ2001', '/a/$avg');
    });
  });

  describe('aggregates - $min / $max', () => {
    it('should compute numeric minima and maxima', () => {
      assert.strictEqual(queryJson({ $min: '$.store.book[*].price' }, bookstore), 8.95);
      assert.strictEqual(queryJson({ $max: '$.store.book[*].price' }, bookstore), 22.99);
      assert.strictEqual(queryJson({ $min: 7 }, null), 7);
      assert.strictEqual(queryJson({ $max: 7 }, null), 7);
    });

    it('should compare strings by Unicode scalar values', () => {
      assert.strictEqual(queryJson({ $min: { $seq: ['pear', 'apple', 'plum'] } }, null), 'apple');
      assert.strictEqual(queryJson({ $max: { $seq: ['pear', 'apple', 'plum'] } }, null), 'plum');
      // code point order, not UTF-16 code unit order: U+1D306 > U+FFFD
      assert.strictEqual(queryJson({ $max: { $seq: ['\u{1D306}', '�'] } }, null), '\u{1D306}');
    });

    it('should be empty over the empty sequence', () => {
      assert.strictEqual(queryJson({ $min: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $max: '$.missing' }, {}), undefined);
    });

    it('should make any NaN item the result NaN (F&O)', () => {
      assert.strictEqual(Number.isNaN(queryJson({ $min: { $seq: [5, NAN, 1] } }, null)), true);
      assert.strictEqual(Number.isNaN(queryJson({ $max: { $seq: [NAN, 5] } }, null)), true);
    });

    it('should raise JQ2001 for mixed or non-comparable items', () => {
      runtimeFails({ $min: { $seq: [1, 'a'] } }, null, 'JQ2001', '/$min');
      runtimeFails({ $max: { $seq: ['a', 1] } }, null, 'JQ2001', '/$max');
      runtimeFails({ $min: true }, null, 'JQ2001', '/$min');
      runtimeFails({ $max: { $seq: [1, null] } }, null, 'JQ2001', '/$max');
      runtimeFails({ $min: { $const: [1] } }, null, 'JQ2001', '/$min');
    });
  });

  describe('aggregates over grouped variables (section 6.5)', () => {
    it('should aggregate each group with real $avg/$min/$max', () => {
      assert.deepStrictEqual(
        queryJson({
          $for: { b: '$.store.book[*]' },
          $groupby: { genre: '$b.category' },
          $return: {
            genre: '$genre',
            count: { $count: '$b' },
            avg: { $avg: '$b.price' },
            min: { $min: '$b.price' },
            max: { $max: '$b.price' },
            cheapest: { $head: { $sort: '$b.price' } },
          },
        }, bookstore),
        [
          { genre: 'reference', count: 1, avg: 8.95, min: 8.95, max: 8.95, cheapest: 8.95 },
          {
            genre: 'fiction', count: 3,
            avg: (12.99 + 8.99 + 22.99) / 3, min: 8.99, max: 22.99, cheapest: 8.99,
          },
        ]);
    });
  });

  //#endregion

  //#region strings (section 8.7)

  describe('$string-join', () => {
    it('should join with and without a separator', () => {
      assert.strictEqual(
        queryJson({ '$string-join': ['$.store.book[*].title', ', '] }, bookstore),
        'Sayings of the Century, Sword of Honour, Moby Dick, The Lord of the Rings');
      assert.strictEqual(queryJson({ '$string-join': [{ $seq: ['a', 'b', 'c'] }] }, null), 'abc');
    });

    it('should cast items per $string', () => {
      assert.strictEqual(
        queryJson({ '$string-join': [{ $seq: [1, true, null, 'x'] }, '-'] }, null),
        '1-true-null-x');
    });

    it('should return "" for the empty sequence', () => {
      assert.strictEqual(queryJson({ '$string-join': ['$.missing', ','] }, {}), '');
      assert.strictEqual(queryJson({ '$string-join': [{ $seq: [] }] }, null), '');
    });

    it('should raise JQ2001 for uncastable items and non-string separators', () => {
      runtimeFails({ '$string-join': [{ $const: [1] }, ','] }, null, 'JQ2001', '/$string-join/0');
      runtimeFails({ '$string-join': [{ $seq: ['a', 'b'] }, 1] }, null, 'JQ2001', '/$string-join/1');
    });
  });

  describe('$substring (0-based, D6)', () => {
    it('should slice by 0-based code point positions', () => {
      assert.strictEqual(queryJson({ $substring: ['hello', 1, 3] }, null), 'ell');
      assert.strictEqual(queryJson({ $substring: ['hello', 1] }, null), 'ello');
      assert.strictEqual(queryJson({ $substring: ['hello', 0, 2] }, null), 'he');
      assert.strictEqual(queryJson({ $substring: ['hello', 4] }, null), 'o');
      assert.strictEqual(queryJson({ $substring: ['hello', 5] }, null), '');
    });

    it('should count positions in code points, not code units', () => {
      assert.strictEqual(queryJson({ $substring: ['\u{1F600}abc', 1, 2] }, null), 'ab');
    });

    it('should apply the F&O rounding and NaN rules', () => {
      // round(0.5) = 1, round(2.5) = 3 (half toward +Infinity)
      assert.strictEqual(queryJson({ $substring: ['hello', 0.5, 2.5] }, null), 'ell');
      // negative start eats into the length (F&O)
      assert.strictEqual(queryJson({ $substring: ['hello', -1, 3] }, null), 'he');
      assert.strictEqual(queryJson({ $substring: ['hello', -10] }, null), 'hello');
      // NaN bounds select nothing
      assert.strictEqual(queryJson({ $substring: ['hello', NAN] }, null), '');
      assert.strictEqual(queryJson({ $substring: ['hello', 0, NAN] }, null), '');
    });

    it('should treat an empty string operand as ""', () => {
      assert.strictEqual(queryJson({ $substring: ['$.missing', 0, 2] }, {}), '');
    });

    it('should raise JQ2001 for non-string/non-number operands', () => {
      runtimeFails({ $substring: [5, 0] }, null, 'JQ2001', '/$substring/0');
      runtimeFails({ $substring: ['abc', '1'] }, null, 'JQ2001', '/$substring/1');
      runtimeFails({ $substring: ['abc', '$.missing'] }, {}, 'JQ2001', '/$substring/1');
      runtimeFails({ $substring: ['abc', 0, true] }, null, 'JQ2001', '/$substring/2');
    });
  });

  describe('$contains / $starts-with / $ends-with', () => {
    it('should test substrings, prefixes, and suffixes', () => {
      assert.strictEqual(queryJson({ $contains: ['hello', 'ell'] }, null), true);
      assert.strictEqual(queryJson({ $contains: ['hello', 'xyz'] }, null), false);
      assert.strictEqual(queryJson({ '$starts-with': ['hello', 'he'] }, null), true);
      assert.strictEqual(queryJson({ '$starts-with': ['hello', 'el'] }, null), false);
      assert.strictEqual(queryJson({ '$ends-with': ['hello', 'lo'] }, null), true);
      assert.strictEqual(queryJson({ '$ends-with': ['hello', 'll'] }, null), false);
    });

    it('should treat empty operands as "" (every string contains "")', () => {
      assert.strictEqual(queryJson({ $contains: ['abc', '$.missing'] }, {}), true);
      assert.strictEqual(queryJson({ $contains: ['$.missing', 'a'] }, {}), false);
      assert.strictEqual(queryJson({ '$starts-with': ['abc', '$.missing'] }, {}), true);
      assert.strictEqual(queryJson({ '$ends-with': ['abc', '$.missing'] }, {}), true);
    });

    it('should raise JQ2001 for non-string operands', () => {
      runtimeFails({ $contains: [1, 'a'] }, null, 'JQ2001', '/$contains/0');
      runtimeFails({ $contains: ['a', null] }, null, 'JQ2001', '/$contains/1');
      runtimeFails({ '$starts-with': [true, 'a'] }, null, 'JQ2001', '/$starts-with/0');
      runtimeFails({ '$ends-with': ['a', 1] }, null, 'JQ2001', '/$ends-with/1');
    });
  });

  describe('$upper / $lower / $string-length / $normalize-space', () => {
    it('should apply Unicode default case mappings', () => {
      assert.strictEqual(queryJson({ $upper: 'abcß' }, null), 'ABCSS');
      assert.strictEqual(queryJson({ $lower: 'ABCÉ' }, null), 'abcé');
    });

    it('should measure length in code points', () => {
      assert.strictEqual(queryJson({ '$string-length': 'abc' }, null), 3);
      assert.strictEqual(queryJson({ '$string-length': '\u{1F600}a' }, null), 2);
      assert.strictEqual(queryJson({ '$string-length': '' }, null), 0);
    });

    it('should normalize whitespace per fn:normalize-space', () => {
      assert.strictEqual(queryJson({ '$normalize-space': '  a  b  ' }, null), 'a b');
      assert.strictEqual(queryJson({ '$normalize-space': '\t a \r\n b \t' }, null), 'a b');
      assert.strictEqual(queryJson({ '$normalize-space': ' \t\r\n ' }, null), '');
    });

    it('should treat the empty sequence as ""', () => {
      assert.strictEqual(queryJson({ $upper: '$.missing' }, {}), '');
      assert.strictEqual(queryJson({ $lower: '$.missing' }, {}), '');
      assert.strictEqual(queryJson({ '$string-length': '$.missing' }, {}), 0);
      assert.strictEqual(queryJson({ '$normalize-space': '$.missing' }, {}), '');
    });

    it('should raise JQ2001 for non-string operands', () => {
      runtimeFails({ $upper: 1 }, null, 'JQ2001', '/$upper');
      runtimeFails({ $lower: null }, null, 'JQ2001', '/$lower');
      runtimeFails({ '$string-length': true }, null, 'JQ2001', '/$string-length');
      runtimeFails({ '$normalize-space': { $seq: ['a', 'b'] } }, null, 'JQ2001', '/$normalize-space');
    });
  });

  describe('$match / $search (I-Regexp, D5)', () => {
    it('should anchor $match over the whole input, $search anywhere', () => {
      assert.strictEqual(queryJson({ $match: ['abc', 'a.c'] }, null), true);
      assert.strictEqual(queryJson({ $match: ['abc', 'b'] }, null), false);
      assert.strictEqual(queryJson({ $search: ['abc', 'b'] }, null), true);
      assert.strictEqual(queryJson({ $search: ['abc', 'x'] }, null), false);
      assert.strictEqual(queryJson({ $match: ['1963-06-19', '[0-9]{4}-[0-9]{2}-[0-9]{2}'] }, null), true);
    });

    it('should match "" against patterns that accept the empty string', () => {
      assert.strictEqual(queryJson({ $match: ['$.missing', 'a*'] }, {}), true);
      assert.strictEqual(queryJson({ $search: ['abc', ''] }, null), true);
    });

    it('should yield false for invalid I-Regexps (RFC 9535 behavior)', () => {
      assert.strictEqual(queryJson({ $match: ['abc', 'a('] }, null), false);
      assert.strictEqual(queryJson({ $search: ['abc', 'a('] }, null), false);
      assert.strictEqual(queryJson({ $match: ['abc', '\\d'] }, null), false); // multi-char escapes are not I-Regexp
    });

    it('should still enforce the input type rule under an invalid literal pattern', () => {
      runtimeFails({ $match: [1, 'a('] }, null, 'JQ2001', '/$match/0');
    });

    it('should compile dynamic patterns through the monomorphic cache', () => {
      const q = compileJsonQuery({ $match: ['$.s', '$pat'] });
      assert.deepStrictEqual(q.externals, ['pat']);
      assert.strictEqual(q({ s: 'abc' }, { pat: 'a.c' }), true);
      assert.strictEqual(q({ s: 'abd' }, { pat: 'a.c' }), false); // cache hit: same pattern
      assert.strictEqual(q({ s: 'abc' }, { pat: 'a.c' }), true); //  ... and again
      assert.strictEqual(q({ s: 'abc' }, { pat: 'x.*' }), false); // cache miss: recompile
      assert.strictEqual(q({ s: 'abc' }, { pat: 'a(' }), false); //  invalid dynamic pattern
      assert.strictEqual(q({ s: 'abc' }, { pat: 'a.c' }), true); //  recovers after the invalid one
    });

    it('should raise JQ2001 for non-string inputs and patterns', () => {
      runtimeFails({ $match: [1, 'a'] }, null, 'JQ2001', '/$match/0');
      runtimeFails({ $match: ['a', 1] }, null, 'JQ2001', '/$match/1');
      runtimeFails({ $search: [null, 'a'] }, null, 'JQ2001', '/$search/0');
    });
  });

  describe('$replace', () => {
    it('should replace every non-overlapping match', () => {
      assert.strictEqual(queryJson({ $replace: ['abc', 'b', 'x'] }, null), 'axc');
      assert.strictEqual(queryJson({ $replace: ['banana', 'an', 'X'] }, null), 'bXXa');
      assert.strictEqual(queryJson({ $replace: ['abc', '[a-c]', '-'] }, null), '---');
      assert.strictEqual(queryJson({ $replace: ['abc', 'x', 'y'] }, null), 'abc');
    });

    it('should insert the replacement literally (no group references)', () => {
      // '$$1' is the section 3.2 string escape for the literal '$1'
      assert.strictEqual(queryJson({ $replace: ['abc', 'b', '$$1'] }, null), 'a$1c');
      assert.strictEqual(queryJson({ $replace: ['abc', '(b)', '$$&'] }, null), 'a$&c');
      assert.strictEqual(queryJson({ $replace: ['abc', 'b', { $const: '$&' } ] }, null), 'a$&c');
    });

    it('should treat an empty input as ""', () => {
      assert.strictEqual(queryJson({ $replace: ['$.missing', 'a', 'b'] }, {}), '');
    });

    it('should raise JQ2001 for invalid and zero-length-matching patterns (F&O)', () => {
      runtimeFails({ $replace: ['abc', 'a(', 'x'] }, null, 'JQ2001', '/$replace/1');
      runtimeFails({ $replace: ['abc', 'b*', 'x'] }, null, 'JQ2001', '/$replace/1');
      runtimeFails({ $replace: ['abc', '', 'x'] }, null, 'JQ2001', '/$replace/1');
    });

    it('should replace through the dynamic pattern cache', () => {
      const q = compileJsonQuery({ $replace: ['$.s', '$pat', '-'] });
      assert.strictEqual(q({ s: 'aXbXc' }, { pat: 'X' }), 'a-b-c');
      assert.strictEqual(q({ s: 'aXbXc' }, { pat: 'X' }), 'a-b-c'); // cache hit
      assert.strictEqual(q({ s: 'aXbXc' }, { pat: '[bc]' }), 'aX-X-'); // cache miss
      assert.throws(() => q({ s: 'abc' }, { pat: 'x*' }), (e) => e.code === 'JQ2001');
    });

    it('should raise JQ2001 for non-string operands', () => {
      runtimeFails({ $replace: [1, 'a', 'b'] }, null, 'JQ2001', '/$replace/0');
      runtimeFails({ $replace: ['a', 1, 'b'] }, null, 'JQ2001', '/$replace/1');
      runtimeFails({ $replace: ['a', 'a', 1] }, null, 'JQ2001', '/$replace/2');
    });
  });

  //#endregion

  //#region sequence operators (section 8.9)

  describe('$distinct', () => {
    it('should keep distinct items in first-occurrence order', () => {
      assert.deepStrictEqual(
        queryJson({ $distinct: '$.store.book[*].category' }, bookstore),
        ['reference', 'fiction']);
      assert.deepStrictEqual(
        queryJson({ $distinct: { $seq: [3, 1, 3, 2, 1] } }, null),
        [3, 1, 2]);
    });

    it('should use deep equality: key order and 1 vs 1.0 do not matter', () => {
      assert.deepStrictEqual(
        queryJson({ $distinct: { $seq: [{ $const: { a: 1, b: 2 } }, { $const: { b: 2, a: 1 } }] } }, null),
        { a: 1, b: 2 });
      assert.strictEqual(queryJson({ $distinct: { $seq: [1, 1.0] } }, null), 1);
      assert.deepStrictEqual(
        queryJson({ $distinct: { $seq: [{ $const: [1, 2] }, { $const: [1, 2] }, { $const: [2, 1] }] } }, null),
        [[1, 2], [2, 1]]);
    });

    it('should identify -0 with 0 and NaN with NaN (the grouping relation)', () => {
      assert.strictEqual(queryJson({ $distinct: { $seq: [0, NEG_ZERO] } }, null), 0);
      assert.strictEqual(Number.isNaN(queryJson({ $distinct: { $seq: [NAN, NAN] } }, null)), true);
    });

    it('should agree with $groupby on the same values', () => {
      const values = { $seq: [0, NEG_ZERO, NAN, NAN, 1, 1.0, '1'] };
      const distinct = queryJson({ $distinct: values }, null);
      const groups = queryJson(
        { $for: { v: values }, $groupby: { k: '$v' }, $return: '$k' }, null);
      assert.deepStrictEqual(groups, distinct);
    });

    it('should pass empty and singleton operands through', () => {
      assert.strictEqual(queryJson({ $distinct: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $distinct: 'x' }, null), 'x');
    });
  });

  describe('$reverse', () => {
    it('should reverse the sequence', () => {
      assert.deepStrictEqual(queryJson({ $reverse: { $seq: [1, 2, 3] } }, null), [3, 2, 1]);
      assert.deepStrictEqual(
        queryJson({ $reverse: '$.store.book[*].price' }, bookstore),
        [22.99, 8.99, 12.99, 8.95]);
    });

    it('should pass empty and singleton operands through', () => {
      assert.strictEqual(queryJson({ $reverse: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $reverse: 42 }, null), 42);
      // an array is one item, not a sequence: it does not reverse
      assert.deepStrictEqual(queryJson({ $reverse: { $const: [1, 2] } }, null), [1, 2]);
    });
  });

  describe('$sort', () => {
    it('should sort all-number and all-string sequences ascending', () => {
      assert.deepStrictEqual(
        queryJson({ $sort: '$.store.book[*].price' }, bookstore),
        [8.95, 8.99, 12.99, 22.99]);
      assert.deepStrictEqual(
        queryJson({ $sort: { $seq: ['pear', 'apple', 'plum'] } }, null),
        ['apple', 'pear', 'plum']);
    });

    it('should order NaN first (equal to itself, less than every number)', () => {
      assert.deepStrictEqual(
        queryJson({ $sort: { $seq: [1, NAN, 0] } }, null),
        [NaN, 0, 1]);
    });

    it('should handle empty and singleton operands', () => {
      assert.strictEqual(queryJson({ $sort: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $sort: 5 }, null), 5);
      assert.strictEqual(queryJson({ $sort: 'x' }, null), 'x');
    });

    it('should raise JQ2005 for mixed or unordered item types', () => {
      runtimeFails({ $sort: { $seq: [1, 'a'] } }, null, 'JQ2005', '/$sort');
      runtimeFails({ $sort: { $seq: ['a', 1] } }, null, 'JQ2005', '/$sort');
      runtimeFails({ $sort: true }, null, 'JQ2005', '/$sort');
      runtimeFails({ $sort: { $seq: [1, null] } }, null, 'JQ2005', '/$sort');
      runtimeFails({ $sort: { $const: [1] } }, null, 'JQ2005', '/$sort');
    });
  });

  describe('$head / $tail', () => {
    it('should split a sequence into head and tail', () => {
      assert.strictEqual(queryJson({ $head: { $seq: [1, 2, 3] } }, null), 1);
      assert.deepStrictEqual(queryJson({ $tail: { $seq: [1, 2, 3] } }, null), [2, 3]);
      assert.strictEqual(queryJson({ $tail: { $seq: [1, 2] } }, null), 2);
      assert.deepStrictEqual(
        queryJson({ $head: '$.store.book[*]' }, bookstore),
        bookstore.store.book[0]);
    });

    it('should handle empty and singleton operands', () => {
      assert.strictEqual(queryJson({ $head: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $tail: '$.missing' }, {}), undefined);
      assert.strictEqual(queryJson({ $head: 1 }, null), 1);
      assert.strictEqual(queryJson({ $tail: 1 }, null), undefined);
    });
  });

  describe('$subsequence (0-based, D6)', () => {
    it('should slice by 0-based item positions', () => {
      assert.deepStrictEqual(queryJson({ $subsequence: [{ $seq: [10, 20, 30, 40] }, 1, 2] }, null), [20, 30]);
      assert.deepStrictEqual(queryJson({ $subsequence: [{ $seq: [10, 20, 30, 40] }, 2] }, null), [30, 40]);
      assert.strictEqual(queryJson({ $subsequence: [{ $seq: [10, 20] }, 5] }, null), undefined);
      assert.deepStrictEqual(
        queryJson({ $subsequence: ['$.store.book[*]', 1, 2] }, bookstore),
        [bookstore.store.book[1], bookstore.store.book[2]]);
    });

    it('should apply the F&O rounding and NaN rules', () => {
      assert.deepStrictEqual(queryJson({ $subsequence: [{ $seq: [10, 20, 30] }, -1, 2] }, null), 10);
      assert.deepStrictEqual(queryJson({ $subsequence: [{ $seq: [10, 20, 30] }, 0.5, 1.5] }, null), [20, 30]);
      assert.strictEqual(queryJson({ $subsequence: [{ $seq: [10, 20] }, NAN] }, null), undefined);
      assert.strictEqual(queryJson({ $subsequence: [{ $seq: [10, 20] }, 0, NAN] }, null), undefined);
    });

    it('should handle empty and singleton operands', () => {
      assert.strictEqual(queryJson({ $subsequence: ['$.missing', 0] }, {}), undefined);
      assert.strictEqual(queryJson({ $subsequence: [5, 0] }, null), 5);
      assert.strictEqual(queryJson({ $subsequence: [5, 1] }, null), undefined);
    });

    it('should raise JQ2001 for non-number positions', () => {
      runtimeFails({ $subsequence: [{ $seq: [1, 2] }, '1'] }, null, 'JQ2001', '/$subsequence/1');
      runtimeFails({ $subsequence: [{ $seq: [1, 2] }, 0, null] }, null, 'JQ2001', '/$subsequence/2');
      runtimeFails({ $subsequence: [{ $seq: [1, 2] }, '$.missing'] }, {}, 'JQ2001', '/$subsequence/1');
    });
  });

  describe('$index-of (0-based, D6)', () => {
    it('should return the 0-based positions of deep-equal items', () => {
      assert.deepStrictEqual(
        queryJson({ '$index-of': ['$.store.book[*].category', 'fiction'] }, bookstore),
        [1, 2, 3]);
      assert.strictEqual(
        queryJson({ '$index-of': ['$.store.book[*].category', 'reference'] }, bookstore),
        0);
      assert.strictEqual(queryJson({ '$index-of': [{ $seq: [1, 2, 3] }, 4] }, null), undefined);
    });

    it('should use deep equality (D2): objects by structure, 1 equals 1.0', () => {
      assert.deepStrictEqual(
        queryJson({ '$index-of': [{ $seq: [{ $const: { a: 1, b: 2 } }, 'x'] }, { $const: { b: 2, a: 1 } }] }, null),
        0);
      assert.strictEqual(queryJson({ '$index-of': [{ $seq: [0, 1] }, 1.0] }, null), 1);
      assert.strictEqual(queryJson({ '$index-of': [{ $seq: [1, 0] }, NEG_ZERO] }, null), 1);
      // ... where NaN equals nothing, unlike $distinct's grouping relation
      assert.strictEqual(queryJson({ '$index-of': [{ $seq: [NAN, 1] }, NAN] }, null), undefined);
    });

    it('should be empty over an empty sequence', () => {
      assert.strictEqual(queryJson({ '$index-of': ['$.missing', 1] }, {}), undefined);
    });

    it('should raise JQ2001 unless the search item is exactly one item', () => {
      runtimeFails({ '$index-of': [{ $seq: [1, 2] }, '$.missing'] }, {}, 'JQ2001', '/$index-of/1');
      runtimeFails({ '$index-of': [{ $seq: [1, 2] }, { $seq: [1, 2] }] }, null, 'JQ2001', '/$index-of/1');
    });
  });

  describe('$range', () => {
    it('should build inclusive integer ranges (XQuery to)', () => {
      assert.deepStrictEqual(queryJson({ $range: [1, 5] }, null), [1, 2, 3, 4, 5]);
      assert.deepStrictEqual(queryJson({ $range: [-2, 1] }, null), [-2, -1, 0, 1]);
      assert.strictEqual(queryJson({ $range: [2, 2] }, null), 2);
      assert.strictEqual(queryJson({ $range: [5, 1] }, null), undefined);
    });

    it('should be empty when either operand is empty (XQuery to)', () => {
      assert.strictEqual(queryJson({ $range: ['$.missing', 5] }, {}), undefined);
      assert.strictEqual(queryJson({ $range: [1, '$.missing'] }, {}), undefined);
    });

    it('should raise JQ2001 for non-integral bounds', () => {
      runtimeFails({ $range: [1.5, 3] }, null, 'JQ2001', '/$range/0');
      runtimeFails({ $range: [1, 'x'] }, null, 'JQ2001', '/$range/1');
      runtimeFails({ $range: [true, 3] }, null, 'JQ2001', '/$range/0');
      runtimeFails({ $range: [1, { $div: [1, 0] }] }, null, 'JQ2001', '/$range/1');
    });

    it('should raise JQ2007 beyond the 2^32-item resource guard', () => {
      runtimeFails({ $range: [0, 4294967296] }, null, 'JQ2007', '/$range');
      runtimeFails({ $range: [1, 1e15] }, null, 'JQ2007', '/$range');
    });
  });

  describe('$get (dynamic lookup)', () => {
    it('should look up object members by string key', () => {
      assert.strictEqual(queryJson({ $get: ['$.store.bicycle', 'color'] }, bookstore), 'red');
      assert.strictEqual(queryJson({ $get: ['$.store.bicycle', 'missing'] }, bookstore), undefined);
      assert.strictEqual(
        queryJson({ $get: ['$.store.book[0]', { $concat: ['ti', 'tle'] }] }, bookstore),
        'Sayings of the Century');
    });

    it('should index arrays 0-based (D6), negative from the end', () => {
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20, 30] }, 0] }, null), 10);
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20, 30] }, 2] }, null), 30);
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20, 30] }, -1] }, null), 30);
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20, 30] }, 3] }, null), undefined);
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20, 30] }, -4] }, null), undefined);
    });

    it('should be empty for every other combination, never an error', () => {
      assert.strictEqual(queryJson({ $get: [{ $const: [10] }, 'x'] }, null), undefined);
      assert.strictEqual(queryJson({ $get: ['$.store.bicycle', 0] }, bookstore), undefined);
      assert.strictEqual(queryJson({ $get: [{ $const: [10, 20] }, 0.5] }, null), undefined);
      assert.strictEqual(queryJson({ $get: ['abc', 0] }, null), undefined);
      assert.strictEqual(queryJson({ $get: ['$.missing', 'x'] }, {}), undefined);
      assert.strictEqual(queryJson({ $get: ['$.store.bicycle', '$.missing'] }, bookstore), undefined);
      assert.strictEqual(queryJson({ $get: ['$.store.book[*]', 0] }, bookstore), undefined); // a sequence is not an array
      assert.strictEqual(queryJson({ $get: [{ $const: {} }, null] }, null), undefined);
    });
  });

  //#endregion

  //#region types and casts (section 8.10)

  describe('type predicates - $is-*', () => {
    it('should test singleton types', () => {
      assert.strictEqual(queryJson({ '$is-string': 'abc' }, null), true);
      assert.strictEqual(queryJson({ '$is-number': 1 }, null), true);
      assert.strictEqual(queryJson({ '$is-boolean': true }, null), true);
      assert.strictEqual(queryJson({ '$is-null': null }, null), true);
      assert.strictEqual(queryJson({ '$is-array': { $const: [1] } }, null), true);
      assert.strictEqual(queryJson({ '$is-object': { $const: {} } }, null), true);
    });

    it('should be false for other singleton types', () => {
      assert.strictEqual(queryJson({ '$is-string': 1 }, null), false);
      assert.strictEqual(queryJson({ '$is-number': '1' }, null), false);
      assert.strictEqual(queryJson({ '$is-boolean': 0 }, null), false);
      assert.strictEqual(queryJson({ '$is-null': 0 }, null), false);
      assert.strictEqual(queryJson({ '$is-array': { $const: {} } }, null), false);
      assert.strictEqual(queryJson({ '$is-object': { $const: [1] } }, null), false);
      assert.strictEqual(queryJson({ '$is-object': null }, null), false);
    });

    it('should be false - not an error - for empty and multi-item operands', () => {
      assert.strictEqual(queryJson({ '$is-string': '$.missing' }, {}), false);
      assert.strictEqual(queryJson({ '$is-null': '$.missing' }, {}), false);
      assert.strictEqual(queryJson({ '$is-number': { $seq: [1, 2] } }, null), false);
      assert.strictEqual(queryJson({ '$is-object': { $seq: [{ $const: {} }, { $const: {} }] } }, null), false);
    });
  });

  describe('$string', () => {
    it('should cast singletons per the cast table', () => {
      assert.strictEqual(queryJson({ $string: 'abc' }, null), 'abc');
      assert.strictEqual(queryJson({ $string: 12 }, null), '12');
      assert.strictEqual(queryJson({ $string: 3.14 }, null), '3.14');
      assert.strictEqual(queryJson({ $string: true }, null), 'true');
      assert.strictEqual(queryJson({ $string: false }, null), 'false');
      assert.strictEqual(queryJson({ $string: null }, null), 'null');
      assert.strictEqual(queryJson({ $string: NAN }, null), 'NaN');
      assert.strictEqual(queryJson({ $string: { $div: [1, 0] } }, null), 'Infinity');
    });

    it('should propagate the empty sequence', () => {
      assert.strictEqual(queryJson({ $string: '$.missing' }, {}), undefined);
    });

    it('should raise JQ2001 for arrays, objects, and multi-item operands', () => {
      runtimeFails({ $string: { $const: [1] } }, null, 'JQ2001', '/$string');
      runtimeFails({ $string: { $const: {} } }, null, 'JQ2001', '/$string');
      runtimeFails({ $string: { $seq: [1, 2] } }, null, 'JQ2001', '/$string');
    });
  });

  describe('$number', () => {
    it('should parse strict JSON numbers and map booleans', () => {
      assert.strictEqual(queryJson({ $number: '12' }, null), 12);
      assert.strictEqual(queryJson({ $number: '-0.5e2' }, null), -50);
      assert.strictEqual(queryJson({ $number: '0.25' }, null), 0.25);
      assert.strictEqual(queryJson({ $number: '1E3' }, null), 1000);
      assert.strictEqual(queryJson({ $number: true }, null), 1);
      assert.strictEqual(queryJson({ $number: false }, null), 0);
      assert.strictEqual(queryJson({ $number: 42 }, null), 42);
    });

    it('should propagate the empty sequence', () => {
      assert.strictEqual(queryJson({ $number: '$.missing' }, {}), undefined);
    });

    it('should raise JQ2001 for strings outside the JSON number grammar', () => {
      runtimeFails({ $number: 'abc' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: '01' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: '+1' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: ' 1' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: '1.' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: '.5' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: 'Infinity' }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: 'NaN' }, null, 'JQ2001', '/$number');
    });

    it('should raise JQ2001 for null, arrays, objects, and multi-item operands', () => {
      runtimeFails({ $number: null }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: { $const: [1] } }, null, 'JQ2001', '/$number');
      runtimeFails({ $number: { $seq: [1, 2] } }, null, 'JQ2001', '/$number');
    });
  });

  describe('$boolean (the EBV as an operator)', () => {
    it('should follow the EBV table of section 2.2', () => {
      assert.strictEqual(queryJson({ $boolean: 1 }, null), true);
      assert.strictEqual(queryJson({ $boolean: 0 }, null), false);
      assert.strictEqual(queryJson({ $boolean: NAN }, null), false);
      assert.strictEqual(queryJson({ $boolean: 'a' }, null), true);
      assert.strictEqual(queryJson({ $boolean: '' }, null), false);
      assert.strictEqual(queryJson({ $boolean: null }, null), false);
      assert.strictEqual(queryJson({ $boolean: true }, null), true);
      assert.strictEqual(queryJson({ $boolean: '$.missing' }, {}), false);
      // D3: singleton arrays and objects are true
      assert.strictEqual(queryJson({ $boolean: { $const: [] } }, null), true);
      assert.strictEqual(queryJson({ $boolean: { $const: {} } }, null), true);
    });

    it('should raise JQ2003 for a multi-item operand', () => {
      runtimeFails({ $boolean: { $seq: [1, 2] } }, null, 'JQ2003', '/$boolean');
    });
  });

  describe('$coalesce / $default', () => {
    it('should return the first non-empty operand', () => {
      assert.strictEqual(queryJson({ $coalesce: ['$.missing', 'fallback'] }, {}), 'fallback');
      assert.strictEqual(queryJson({ $coalesce: ['$.a', '$.b'] }, { a: 1, b: 2 }), 1);
      assert.strictEqual(queryJson({ $coalesce: ['$.missing'] }, {}), undefined);
      assert.strictEqual(queryJson({ $coalesce: ['$.x', '$.y', 3] }, {}), 3);
      assert.deepStrictEqual(queryJson({ $coalesce: ['$.missing', { $seq: [1, 2] }] }, {}), [1, 2]);
      assert.strictEqual(queryJson({ $default: ['$.missing', 0] }, {}), 0);
      assert.strictEqual(queryJson({ $default: ['$.a', 0] }, { a: 7 }), 7);
    });

    it('should evaluate lazily: operands after the deciding one cannot error', () => {
      // the second operand would raise JQ2001 if evaluated
      assert.strictEqual(queryJson({ $coalesce: [1, { $sum: true }] }, null), 1);
      assert.strictEqual(queryJson({ $default: ['x', { $number: 'nope' }] }, null), 'x');
      // ... and it does raise once it is the deciding one
      runtimeFails({ $coalesce: ['$.missing', { $sum: true }] }, {}, 'JQ2001', '/$coalesce/1/$sum');
    });
  });

  //#endregion

  //#region the spec's combined section-8 example fixtures, evaluated

  describe('section 8 fixture documents against the bookstore', () => {
    function fixture(name) {
      return JSON.parse(fs.readFileSync(path.join(fixturesDir, 'valid', name), 'utf8'));
    }

    it('should evaluate op-strings.json (section 8.7 example)', () => {
      assert.deepStrictEqual(queryJson(fixture('op-strings.json'), bookstore), [
        'ab',
        'Sayings of the Century, Sword of Honour, Moby Dick, The Lord of the Rings',
        'ell',
        true, true, true,
        'ABC', 'abc',
        3, 'a b',
        true, true,
        'axc',
      ]);
    });

    it('should evaluate op-aggregates-sequences.json (sections 8.8/8.9 example)', () => {
      const books = bookstore.store.book;
      assert.deepStrictEqual(queryJson(fixture('op-aggregates-sequences.json'), bookstore), [
        4,
        8.95 + 12.99 + 8.99 + 22.99,
        (8.95 + 12.99 + 8.99 + 22.99) / 4,
        8.95,
        22.99,
        'reference', 'fiction',
        books[3].title, books[2].title, books[1].title, books[0].title,
        8.95, 8.99, 12.99, 22.99,
        books[0],
        books[1], books[2], books[3],
        books[1], books[2],
        1, 2, 3,
        1, 2, 3, 4, 5,
        'red',
      ]);
    });

    it('should evaluate op-types-casts.json (section 8.10 example)', () => {
      assert.deepStrictEqual(queryJson(fixture('op-types-casts.json'), bookstore), [
        true, true, true, true, true, true,
        '12', 12, true,
        'fallback', 0,
      ]);
    });
  });

  //#endregion
});

describe('section 8.13 — dates and times', () => {
  const doc = {
    at: '2026-07-27T14:30:05.5+02:00',
    day: '2026-07-27',
    clock: '14:30:05Z',
    span: 'P1Y2M3DT4H5M6S',
  };
  const run = (q, data = doc) => queryJson(q, data);

  it('should test the RFC 3339 lexical forms', () => {
    assert.strictEqual(run({ '$is-datetime': '$.at' }), true);
    assert.strictEqual(run({ '$is-date': '$.day' }), true);
    assert.strictEqual(run({ '$is-time': '$.clock' }), true);
    assert.strictEqual(run({ '$is-duration': '$.span' }), true);
    // the forms are distinct: a date-time is not a date
    assert.strictEqual(run({ '$is-date': '$.at' }), false);
    assert.strictEqual(run({ '$is-datetime': '$.day' }), false);
    // like the $is-* family, a non-string is false, never an error
    assert.strictEqual(run({ '$is-date': 42 }), false);
    assert.strictEqual(run({ '$is-date': '$.missing' }), false);
  });

  it('should read components lexically, in the value\'s own offset', () => {
    assert.strictEqual(run({ '$year': '$.at' }), 2026);
    assert.strictEqual(run({ '$month': '$.at' }), 7);
    assert.strictEqual(run({ '$day': '$.at' }), 27);
    // 14, not the 12 it would be shifted to UTC
    assert.strictEqual(run({ '$hours': '$.at' }), 14);
    assert.strictEqual(run({ '$minutes': '$.at' }), 30);
    assert.strictEqual(run({ '$seconds': '$.at' }), 5.5);
    assert.strictEqual(run({ '$offset': '$.at' }), 120);
  });

  it('should propagate the empty sequence through every component', () => {
    for (const op of ['$year', '$month', '$day', '$hours', '$minutes', '$seconds', '$offset', '$epoch']) {
      assert.strictEqual(run({ [op]: '$.missing' }), undefined, op);
    }
  });

  it('should reject a value whose half is missing', () => {
    assert.throws(() => run({ '$hours': '$.day' }),
      (e) => e.code === 'JQ2001' && /no time component/.test(e.message));
    assert.throws(() => run({ '$year': '$.clock' }),
      (e) => e.code === 'JQ2001' && /no date component/.test(e.message));
    assert.throws(() => run({ '$epoch': '$.clock' }),
      (e) => e.code === 'JQ2001' && /no date component/.test(e.message));
    // a bare full-date has no offset at all — empty, not an error
    assert.strictEqual(run({ '$offset': '$.day' }), undefined);
  });

  it('should report a malformed string by value', () => {
    assert.throws(() => run({ '$year': { $const: '2026-13-99' } }),
      (e) => e.code === 'JQ2001' && /"2026-13-99"/.test(e.message));
    assert.throws(() => run({ '$year': 42 }),
      (e) => e.code === 'JQ2001' && /a number/.test(e.message));
  });

  it('should place instants on the epoch and back again', () => {
    assert.strictEqual(run({ '$epoch': '$.at' }), Date.parse(doc.at));
    assert.strictEqual(run({ '$epoch': '$.day' }), Date.UTC(2026, 6, 27));
    assert.strictEqual(run({ '$datetime': { '$epoch': '$.at' } }), '2026-07-27T12:30:05.5Z');
    // whole seconds drop the fraction, so the form stays canonical
    assert.strictEqual(run({ '$datetime': 0 }), '1970-01-01T00:00:00Z');
    assert.throws(() => run({ '$datetime': 1e18 }), (e) => e.code === 'JQ2001');
    assert.throws(() => run({ '$datetime': '$.at' }), (e) => e.code === 'JQ2001');
  });

  it('should compare across offsets through $epoch', () => {
    // the same instant, spelled in two offsets: string order disagrees,
    // epoch order does not
    const data = { a: '2026-07-27T14:00:00+02:00', b: '2026-07-27T12:00:00Z' };
    assert.strictEqual(queryJson({ '$lt': ['$.a', '$.b'] }, data), false,
      'as strings, "14:00" sorts after "12:00"');
    assert.strictEqual(
      queryJson({ '$eq': [{ '$epoch': '$.a' }, { '$epoch': '$.b' }] }, data), true);
  });

  it('should group by a date component in a phrase', () => {
    const events = [
      { on: '2026-01-15', what: 'a' },
      { on: '2026-01-20', what: 'b' },
      { on: '2027-03-02', what: 'c' },
    ];
    const out = queryJson({
      $for: { e: '$[*]' },
      $groupby: { y: { '$year': '$e.on' } },
      $orderby: ['$y'],
      $return: { year: '$y', count: { $count: '$e.what' } },
    }, events);
    assert.deepStrictEqual(out, [{ year: 2026, count: 2 }, { year: 2027, count: 1 }]);
  });
});

describe('section 8.13 — date arithmetic', () => {
  const doc = {
    start: '2026-01-31',
    at: '2026-07-27T14:30:05+02:00',
    end: '2026-12-25',
  };
  const run = (q, data = doc) => queryJson(q, data);

  it('should shift a date by a duration or by an amount and unit', () => {
    assert.strictEqual(run({ '$date-add': ['$.start', 'P1M'] }), '2026-02-28');
    assert.strictEqual(run({ '$date-add': ['$.start', 3, 'day'] }), '2026-02-03');
    assert.strictEqual(run({ '$date-sub': ['$.start', 'P1M'] }), '2025-12-31');
    assert.strictEqual(run({ '$date-sub': ['$.start', 1, 'year'] }), '2025-01-31');
    // a negative duration and $date-sub agree
    assert.strictEqual(run({ '$date-add': ['$.start', '-P1M'] }),
      run({ '$date-sub': ['$.start', 'P1M'] }));
  });

  it('should keep the lexical form it was given', () => {
    // a query that buckets dates must not start emitting date-times
    assert.strictEqual(run({ '$date-add': ['$.start', 1, 'day'] }), '2026-02-01');
    assert.strictEqual(run({ '$date-add': ['$.at', 'P1D'] }), '2026-07-28T14:30:05+02:00');
    assert.strictEqual(run({ '$date-sub': ['$.at', 'PT90M'] }), '2026-07-27T13:00:05+02:00');
  });

  it('should clamp month arithmetic, matching the kernel rule', () => {
    assert.strictEqual(run({ '$date-add': ['$.start', 'P1M'] }), '2026-02-28');
    assert.strictEqual(run({ '$date-add': [{ $const: '2024-01-31' }, 'P1M'] }), '2024-02-29');
  });

  it('should truncate to a calendar unit with $start-of and $end-of', () => {
    assert.strictEqual(run({ '$start-of': ['$.at', 'month'] }), '2026-07-01T00:00:00+02:00');
    assert.strictEqual(run({ '$start-of': ['$.end', 'week'] }), '2026-12-21', 'weeks start Monday');
    assert.strictEqual(run({ '$start-of': ['$.end', 'quarter'] }), '2026-10-01');
    // a full-date has nowhere to put a last millisecond, so it ends on a day
    assert.strictEqual(run({ '$end-of': ['$.start', 'month'] }), '2026-01-31');
    assert.strictEqual(run({ '$end-of': ['$.at', 'day'] }), '2026-07-27T23:59:59.999+02:00');
  });

  it('should measure whole units with $date-diff', () => {
    assert.strictEqual(run({ '$date-diff': ['$.start', '$.end', 'day'] }), 328);
    assert.strictEqual(run({ '$date-diff': ['$.start', '$.end', 'month'] }), 10);
    assert.strictEqual(run({ '$date-diff': ['$.start', '$.end', 'quarter'] }), 3);
    assert.strictEqual(run({ '$date-diff': ['$.start', '$.end', 'year'] }), 0);
    // reversing the operands negates the answer
    assert.strictEqual(run({ '$date-diff': ['$.end', '$.start', 'month'] }), -10);
  });

  it('should format through a compiled LDML pattern', () => {
    assert.strictEqual(run({ '$date-format': ['$.at', 'yyyy/MM/dd HH:mm'] }), '2026/07/27 14:30');
    assert.strictEqual(run({ '$date-format': ['$.end', "yyyy-'W'ww"] }), '2026-W52');
    assert.strictEqual(run({ '$date-format': ['$.end', 'd'] }), '25');
    // a dynamic pattern goes through the per-callsite cache
    assert.deepStrictEqual(
      queryJson({ $for: { p: '$.patterns[*]' }, $return: { '$date-format': ['$.d', '$p'] } },
        { d: '2026-07-27', patterns: ['yyyy', 'MM', 'dd'] }),
      ['2026', '07', '27']);
  });

  it('should reject a locale-dependent pattern, at compile time when literal', () => {
    // the query engine has no locale, and a silent English fallback
    // would put English into every localized render
    assert.throws(() => compileJsonQuery({ '$date-format': ['$.at', 'MMMM'] }),
      (e) => e.code === 'JQ0003' && /names provider/.test(e.message));
    assert.throws(() => queryJson({ '$date-format': ['$.at', '$.p'] }, { at: doc.at, p: 'EEEE' }),
      (e) => e.code === 'JQ2001');
  });

  it('should read the derived calendar fields', () => {
    assert.strictEqual(run({ $week: '$.end' }), 52);
    assert.strictEqual(run({ $quarter: '$.end' }), 4);
    assert.strictEqual(run({ $weekday: '$.end' }), 5, '2026-12-25 is a Friday');
    // the ISO week year is not always the calendar year
    assert.strictEqual(run({ '$week-year': { $const: '2027-01-01' } }), 2026);
    assert.strictEqual(run({ $week: { $const: '2027-01-01' } }), 53);
  });

  it('should propagate the empty sequence through every operator', () => {
    assert.strictEqual(run({ '$date-add': ['$.missing', 'P1D'] }), undefined);
    assert.strictEqual(run({ '$start-of': ['$.missing', 'day'] }), undefined);
    assert.strictEqual(run({ '$date-diff': ['$.missing', '$.end', 'day'] }), undefined);
    assert.strictEqual(run({ '$date-format': ['$.missing', 'yyyy'] }), undefined);
    assert.strictEqual(run({ $week: '$.missing' }), undefined);
  });

  it('should reject bad units, durations and operands', () => {
    assert.throws(() => run({ '$start-of': ['$.start', 'fortnight'] }),
      (e) => e.code === 'JQ2001' && /calendar unit/.test(e.message));
    assert.throws(() => run({ '$date-add': ['$.start', 'nope'] }),
      (e) => e.code === 'JQ2001' && /ISO 8601 duration/.test(e.message));
    assert.throws(() => run({ '$date-add': ['$.start', 'x', 'day'] }),
      (e) => e.code === 'JQ2001' && /number of units/.test(e.message));
    assert.throws(() => run({ '$date-diff': [{ $const: '14:30:00Z' }, '$.end', 'day'] }),
      (e) => e.code === 'JQ2001' && /no date/.test(e.message));
  });

  it('should bucket a series by week — the shape that needed all of this', () => {
    const events = [
      { on: '2026-01-05' }, { on: '2026-01-08' }, { on: '2026-01-14' }, { on: '2026-01-20' },
    ];
    assert.deepStrictEqual(queryJson({
      $for: { e: '$[*]' },
      $groupby: { w: { '$start-of': ['$e.on', 'week'] } },
      $orderby: ['$w'],
      $return: { week: '$w', count: { $count: '$e' } },
    }, events), [
      { week: '2026-01-05', count: 2 },
      { week: '2026-01-12', count: 1 },
      { week: '2026-01-19', count: 1 },
    ]);
  });
});
