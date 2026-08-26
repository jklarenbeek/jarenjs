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
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

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

  describe('$entries (member pairs)', () => {
    it('should yield one { key, value } pair per member, in member order', () => {
      assert.deepStrictEqual(queryJson({ $entries: '$.store.bicycle' }, bookstore), [
        { key: 'color', value: 'red' },
        { key: 'price', value: 399 },
      ]);
      assert.strictEqual(queryJson({ $entries: { $const: {} } }, null), undefined,
        'an empty object has no pairs');
    });

    it('should concatenate pairs over a multi-item operand and skip non-objects', () => {
      assert.deepStrictEqual(
        queryJson({ $entries: '$.rows[*]' }, { rows: [{ x: 1 }, 42, { y: 2 }] }),
        [{ key: 'x', value: 1 }, { key: 'y', value: 2 }]);
      assert.strictEqual(queryJson({ $entries: 42 }, null), undefined);
      assert.strictEqual(queryJson({ $entries: { $const: [1, 2] } }, null), undefined,
        'an array item is not an object');
      assert.strictEqual(queryJson({ $entries: '$.missing' }, {}), undefined);
    });

    it('projects an object map into an id-carrying array (the FLWOR shape)', () => {
      assert.deepStrictEqual(queryJson({
        $for: { e: { $entries: '$' } },
        $return: { id: '$e.key', decl: '$e.value' },
      }, { a: { kind: 'input' }, b: { kind: 'output' } }), [
        { id: 'a', decl: { kind: 'input' } },
        { id: 'b', decl: { kind: 'output' } },
      ]);
    });
  });

  describe('$from-entries (the inverse)', () => {
    it('assembles an object from pairs; later keys win, like $map', () => {
      assert.deepStrictEqual(
        queryJson({ '$from-entries': { $entries: '$' } }, { a: 1, b: [2] }),
        { a: 1, b: [2] }, 'entries → from-entries is the identity on objects');
      assert.deepStrictEqual(
        queryJson({ '$from-entries': { $seq: [
          { key: 'x', value: 1 }, { key: 'x', value: 2 },
        ] } }, null), { x: 2 });
    });

    it('skips keyless items, nulls a missing value, and builds {} from empty', () => {
      assert.deepStrictEqual(
        queryJson({ '$from-entries': { $seq: [42, { value: 9 }, { key: 'y' }] } }, null),
        { y: null });
      assert.deepStrictEqual(queryJson({ '$from-entries': '$.missing' }, {}), {});
    });

    it('rebuilds a renamed object map through FLWOR (the projection shape)', () => {
      assert.deepStrictEqual(queryJson({
        '$from-entries': {
          $for: { e: { $entries: '$' } },
          $return: { key: { $concat: ['node_', '$e.key'] }, value: '$e.value.kind' },
        },
      }, { a: { kind: 'input' }, b: { kind: 'output' } }),
      { node_a: 'input', node_b: 'output' });
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
        { key: 'color', value: 'red' }, { key: 'price', value: 399 },
        { color: 'red', price: 399 },
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

  it('should keep a fixed-width fraction, and refuse a calendar one', () => {
    // the query and the kernel answer the same question the same way:
    // a day and a half is thirty-six hours, and half a month is nothing
    const ts = { $const: '2026-01-01T00:00:00Z' };
    assert.strictEqual(run({ '$date-add': [ts, 1.5, 'day'] }), '2026-01-02T12:00:00Z');
    assert.strictEqual(run({ '$date-add': [ts, 'P1.5D'] }), '2026-01-02T12:00:00Z');
    assert.strictEqual(run({ '$date-sub': [ts, 'PT1.5H'] }), '2025-12-31T22:30:00Z');
    assert.throws(() => run({ '$date-add': ['$.start', 0.5, 'month'] }),
      (e) => e.code === 'JQ2001' && /fraction/.test(e.message));
    assert.throws(() => run({ '$date-add': ['$.start', 'P0.5M'] }),
      (e) => e.code === 'JQ2001' && /fraction/.test(e.message));
    // a fraction with an exact month conversion still applies
    assert.strictEqual(run({ '$date-add': ['$.start', 0.5, 'year'] }), '2026-07-31');
  });

  it('should refuse an operation the value has no half for', () => {
    const time = { $const: '14:30:00Z' };
    assert.throws(() => run({ '$date-add': ['$.start', 3, 'hour'] }),
      (e) => e.code === 'JQ2001' && /time half/.test(e.message));
    assert.throws(() => run({ '$date-add': ['$.start', 'P1.5D'] }),
      (e) => e.code === 'JQ2001' && /time half/.test(e.message));
    assert.throws(() => run({ '$end-of': ['$.start', 'hour'] }),
      (e) => e.code === 'JQ2001' && /time half/.test(e.message));
    assert.throws(() => run({ '$date-add': [time, 1, 'day'] }),
      (e) => e.code === 'JQ2001' && /date half/.test(e.message));
    assert.throws(() => run({ '$start-of': [time, 'month'] }),
      (e) => e.code === 'JQ2001' && /date half/.test(e.message));
    assert.throws(() => run({ '$date-diff': [time, time, 'month'] }),
      (e) => e.code === 'JQ2001' && /no date/.test(e.message));
    // and the operations that ARE defined still answer
    assert.strictEqual(run({ '$date-add': [time, 3, 'hour'] }), '17:30:00Z');
    assert.strictEqual(run({ '$end-of': [time, 'day'] }), '23:59:59.999Z');
    assert.strictEqual(run({ '$date-add': ['$.start', 1, 'day'] }), '2026-02-01');
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

describe('section 8.14 — spatial', () => {
  // a 1-degree box over the western Netherlands
  const box = {
    type: 'Feature',
    properties: { name: 'box' },
    geometry: { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] },
  };
  const doc = {
    ams: [4.9041, 52.3676],
    par: [2.3522, 48.8566],
    area: box,
    cities: [
      { name: 'Amsterdam', at: [4.9041, 52.3676] },
      { name: 'Paris', at: [2.3522, 48.8566] },
      { name: 'Utrecht', at: [5.1214, 52.0907] },
    ],
  };
  const run = (q, data = doc) => queryJson(q, data);

  it('should measure geodesic distance, not a planar one', () => {
    const d = run({ $distance: ['$.ams', '$.par'] });
    assert.ok(Math.abs(d - 429862) < 100, `Amsterdam to Paris was ${d}`);
    assert.strictEqual(run({ $distance: ['$.ams', '$.ams'] }), 0);
    // a degree of longitude is not a fixed distance, so the planar
    // answer on raw degrees would be far larger
    const planar = Math.hypot(4.9041 - 2.3522, 52.3676 - 48.8566) * 111320;
    assert.ok(planar / d > 1.1, 'the planar shortcut must not be what this returns');
  });

  it('should measure bbox, area, length and centroid', () => {
    assert.deepStrictEqual(run({ $bbox: '$.area' }), [4, 52, 5, 53]);
    assert.deepStrictEqual(run({ $centroid: '$.area' }), [4.4, 52.4]);
    // a 1-degree box at 52N is much smaller than one at the equator
    const km2 = run({ $area: '$.area' }) / 1e6;
    assert.ok(km2 > 7000 && km2 < 8000, `area was ${km2} km2`);
    const km = run({ $length: '$.area' }) / 1000;
    assert.ok(km > 300 && km < 400, `perimeter was ${km} km`);
    // things with no surface measure zero rather than erroring
    assert.strictEqual(run({ $area: '$.ams' }), 0);
    assert.strictEqual(run({ $length: '$.ams' }), 0);
  });

  it('should unwrap a Feature, a geometry or a bare position alike', () => {
    const geometry = box.geometry;
    assert.deepStrictEqual(run({ $bbox: { $const: geometry } }), [4, 52, 5, 53]);
    assert.deepStrictEqual(run({ $bbox: { $const: box } }), [4, 52, 5, 53]);
    assert.deepStrictEqual(run({ $bbox: '$.ams' }), [4.9041, 52.3676, 4.9041, 52.3676]);
    const fc = { type: 'FeatureCollection', features: [box] };
    assert.deepStrictEqual(run({ $bbox: { $const: fc } }), [4, 52, 5, 53]);
  });

  it('should test containment', () => {
    assert.strictEqual(run({ $within: ['$.ams', '$.area'] }), true);
    assert.strictEqual(run({ $within: ['$.par', '$.area'] }), false);
    // nothing is inside nothing, and this is false rather than an error
    assert.strictEqual(run({ $within: ['$.missing', '$.area'] }), false);
    assert.strictEqual(run({ $within: ['$.ams', '$.missing'] }), false);
    // only a surface has an inside
    assert.strictEqual(run({ $within: ['$.ams', '$.ams'] }), false);
  });

  it('should say what it tests: bounding boxes, not geometry', () => {
    assert.strictEqual(run({ '$bbox-intersects': ['$.area', '$.ams'] }), true);
    assert.strictEqual(run({ '$bbox-intersects': ['$.area', '$.par'] }), false);
    // the honest case: two shapes whose boxes overlap and which do not.
    // The name promises only the box, which is why it is named that way.
    const ellA = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [0, 1], [0, 0]]] };
    const ellB = { type: 'Polygon', coordinates: [[[0, 2], [3, 2], [3, 3], [0, 3], [0, 2]]] };
    assert.strictEqual(
      queryJson({ '$bbox-intersects': ['$.a', '$.b'] }, { a: ellA, b: ellB }), false);
  });

  it('should encode a geohash, defaulting to precision 9', () => {
    assert.strictEqual(run({ $geohash: ['$.ams', 5] }), 'u173z');
    assert.strictEqual(run({ $geohash: ['$.ams'] }).length, 9);
    assert.ok(run({ $geohash: ['$.ams'] }).startsWith('u173z'), 'precision nests');
    // a non-position value is represented by its centroid
    assert.strictEqual(run({ $geohash: ['$.area', 3] }), 'u17');
  });

  it('should propagate the empty sequence and reject non-spatial operands', () => {
    for (const op of ['$bbox', '$area', '$length', '$centroid'])
      assert.strictEqual(run({ [op]: '$.missing' }), undefined, op);
    assert.strictEqual(run({ $distance: ['$.missing', '$.ams'] }), undefined);
    assert.throws(() => run({ $area: 42 }), (e) => e.code === 'JQ2001');
    assert.throws(() => run({ $distance: ['$.ams', 'nonsense'] }), (e) => e.code === 'JQ2001');
    assert.throws(() => run({ $geohash: ['$.ams', 99] }),
      (e) => e.code === 'JQ2001' && /precision/.test(e.message));
  });

  // Every unary spatial measurement can answer EMPTY for an operand
  // that is present — the non-finite rule, malformed text, a cell
  // outside the alphabet — so its declared cardinality is OPTIONAL,
  // never ONE. Declaring ONE lets the internal empty marker escape into
  // a constructor, where it is neither an item nor a JSON value.
  it('should never leak the empty marker into a constructor', () => {
    const nan = { $div: [0, 0] };
    const leaked = [];
    const cases = {
      '$bbox': { $bbox: [nan, 0] },
      '$centroid': { $centroid: [nan, 0] },
      '$geohash': { $geohash: [[nan, 0]] },
      '$area': { $area: [nan, 0] },
      '$length': { $length: [nan, 0] },
      '$geo-text': { '$geo-text': [nan, 0] },
      '$geo-parse': { '$geo-parse': 'not well-known text' },
      '$geohash-bounds': { '$geohash-bounds': 'u17a' },
    };
    for (const [name, expression] of Object.entries(cases)) {
      const inArray = queryJson([expression], {});
      const inObject = queryJson({ m: expression }, {});
      if (!Array.isArray(inArray) || inArray.length !== 0)
        leaked.push(`${name}: [expr] answered a ${inArray.length}-item array`);
      if (inObject === null || typeof inObject !== 'object' || 'm' in inObject)
        leaked.push(`${name}: {m: expr} kept the member`);
    }
    assert.deepStrictEqual(leaked, []);
  });

  it('should filter, sort and bucket — the shapes this exists for', () => {
    assert.strictEqual(queryJson({
      $for: { c: '$.cities[*]' },
      $where: { $within: ['$c.at', '$.area'] },
      $return: '$c.name',
    }, doc), 'Amsterdam');

    assert.deepStrictEqual(queryJson({
      $for: { c: '$.cities[*]' },
      $orderby: [{ $key: { $distance: ['$c.at', '$.ams'] } }],
      $return: '$c.name',
    }, doc), ['Amsterdam', 'Utrecht', 'Paris']);

    assert.deepStrictEqual(queryJson({
      $for: { c: '$.cities[*]' },
      $groupby: { cell: { $geohash: ['$c.at', 3] } },
      $orderby: ['$cell'],
      $return: { cell: '$cell', names: { '$string-join': ['$c.name', '+'] } },
    }, doc), [
      { cell: 'u09', names: 'Paris' },
      { cell: 'u17', names: 'Amsterdam+Utrecht' },
    ]);
  });

  it('should answer empty for a measurement over a non-finite coordinate', () => {
    // NaN is not a JSON number, but a computed value can carry one, and
    // every formula underneath launders it into something plausible: a
    // great-circle distance from NaN is the antipodal distance, and a
    // NaN area compares false against zero and reports 0
    const bad = {
      line: { type: 'LineString', coordinates: [[NaN, 0], [1, 1]] },
      at: [NaN, 0],
      poly: { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 52]]] },
    };
    for (const op of ['$bbox', '$area', '$length', '$centroid'])
      assert.strictEqual(queryJson({ [op]: '$.line' }, bad), undefined, op);
    assert.strictEqual(queryJson({ $distance: ['$.at', '$.poly'] }, bad), undefined);
    assert.strictEqual(queryJson({ $geohash: ['$.at'] }, bad), undefined);
    // a predicate answers its own missing-operand value, not empty
    assert.strictEqual(queryJson({ $within: ['$.at', '$.poly'] }, bad), false);
    assert.strictEqual(queryJson({ '$bbox-intersects': ['$.line', '$.poly'] }, bad), false);
    // a value with no positions is a different thing, and still measures
    const none = { fc: { type: 'FeatureCollection', features: [] }, at: [1, 2] };
    assert.strictEqual(queryJson({ $area: '$.fc' }, none), 0);
    assert.strictEqual(queryJson({ $area: '$.at' }, none), 0, 'a point has no surface, not no answer');
    assert.strictEqual(queryJson({ $length: '$.at' }, none), 0);
  });

  it('should read and write Well-Known Text', () => {
    const wkt = 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))';
    assert.deepStrictEqual(queryJson({ '$geo-parse': '$.w' }, { w: wkt }),
      { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] });
    // a geometry, never a Feature: WKT carries no properties to put in one
    assert.strictEqual(queryJson({ '$geo-parse': '$.w' }, { w: wkt }).type, 'Polygon');
    assert.strictEqual(run({ '$geo-text': '$.area' }), wkt, 'a Feature writes its geometry');
    assert.strictEqual(run({ '$geo-text': '$.ams' }), 'POINT (4.9041 52.3676)');
    // through the language, not only through the kernel
    assert.strictEqual(queryJson({ '$geo-text': { '$geo-parse': '$.w' } }, { w: wkt }), wkt);
    // text that is not WKT is empty, not an error; a non-string is JQ2001
    assert.strictEqual(queryJson({ '$geo-parse': '$.w' }, { w: 'POINT (1' }), undefined);
    assert.strictEqual(queryJson({ '$geo-parse': '$.w' }, { w: 'CIRCLE EMPTY' }), undefined);
    runtimeFails({ '$geo-parse': '$.n' }, { n: 42 }, 'JQ2001');
    // a value with no WKT spelling is empty, never written approximately
    assert.strictEqual(queryJson({ '$geo-text': '$.at' }, { at: [NaN, 2] }), undefined);
  });

  it('should decode a geohash cell to the polygon it covers', () => {
    const cell = queryJson({ '$geohash-bounds': '$.c' }, { c: 'u173z' });
    assert.strictEqual(cell.type, 'Polygon');
    // the round trip closes: the cell's own centre encodes back to it
    assert.strictEqual(queryJson({ $geohash: [{ '$geohash-bounds': '$.c' }, 5] }, { c: 'u173z' }),
      'u173z');
    assert.strictEqual(queryJson({ $within: ['$.at', { '$geohash-bounds': '$.c' }] },
      { c: 'u173z', at: [4.9041, 52.3676] }), true);
    // outside the base-32 alphabet there is no cell
    assert.strictEqual(queryJson({ '$geohash-bounds': '$.c' }, { c: 'u17a' }), undefined);
    runtimeFails({ '$geohash-bounds': '$.c' }, { c: 5 }, 'JQ2001');
  });

  it('should probe the neighbourhood — a prefix is bucketing, not proximity', () => {
    // Greenwich, on a level-1 cell boundary: two points 9.7 m apart whose
    // cells differ in the FIRST character. A single-prefix test misses
    // the neighbour at every cell edge, which is everywhere a customer
    // actually looks; the nine-cell probe finds it.
    const data = {
      here: [-0.00007, 51.4779],
      places: [
        { name: 'across the meridian', at: [0.00007, 51.4779] },
        { name: 'far away', at: [4.9041, 52.3676] },
      ],
    };
    const cells = queryJson({ '$geohash-neighbours': { $geohash: ['$.here', 6] } }, data);
    assert.strictEqual(cells.length, 9);
    assert.strictEqual(cells[4], 'gcpuzg', 'reading order: the cell itself is the middle one');
    assert.strictEqual(cells[0], 'gcpuzs', 'and the north-west neighbour is the first');

    const neighbourhood = {
      $let: { cells: { '$geohash-neighbours': { $geohash: ['$.here', 6] } } },
      $return: {
        $for: { p: '$.places[*]' },
        $where: { $exists: { '$index-of': ['$cells', { $geohash: ['$p.at', 6] }] } },
        $return: '$p.name',
      },
    };
    assert.strictEqual(queryJson(neighbourhood, data), 'across the meridian');

    const singlePrefix = {
      $for: { p: '$.places[*]' },
      $where: { '$starts-with': [{ $geohash: ['$p.at', 9] }, { $geohash: ['$.here', 6] }] },
      $return: '$p.name',
    };
    assert.strictEqual(queryJson(singlePrefix, data), undefined,
      'the prefix finds nothing 9.7 m away — this is why the operator exists');

    assert.strictEqual(queryJson({ '$geohash-neighbours': '$.c' }, { c: '!!' }), undefined);
    runtimeFails({ '$geohash-neighbours': '$.c' }, { c: 5 }, 'JQ2001');
  });

  it('should simplify for storage and transport, keeping the value valid', () => {
    const line = { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0], [2, 2]] };
    assert.deepStrictEqual(queryJson({ '$geo-simplify': ['$.l', 0.01] }, { l: line }),
      { type: 'LineString', coordinates: [[0, 0], [2, 0], [2, 2]] },
      'both endpoints survive');
    const ring = {
      type: 'Polygon',
      coordinates: [[[0, 0], [1, 0.0001], [2, 0], [2, 2], [0, 2], [0, 0]]],
    };
    const reduced = queryJson({ '$geo-simplify': ['$.p', 0.01] }, { p: ring });
    const positions = reduced.coordinates[0];
    assert.ok(positions.length < ring.coordinates[0].length, 'a vertex was dropped');
    assert.deepStrictEqual(positions[0], positions[positions.length - 1], 'the ring stays closed');
    // a tolerance is a non-negative number of DEGREES, never a distance
    runtimeFails({ '$geo-simplify': ['$.p', -1] }, { p: ring }, 'JQ2001');
    runtimeFails({ '$geo-simplify': ['$.p', '10m'] }, { p: ring }, 'JQ2001');
    assert.strictEqual(queryJson({ '$geo-simplify': ['$.missing', 0.01] }, { p: ring }), undefined);
  });
});

describe('section 8.14 — spatial, inherited by JSLT', () => {
  // A JSLT rule body IS a query expression, so the conversion family
  // arrived in stylesheets with no JSLT change at all. This test exists
  // to prove that claim rather than assert it: if it ever needs a JSLT
  // code change to pass, the inheritance broke.
  it('should run every conversion operator in a rule body', () => {
    const transform = compileJsltStylesheet([
      { match: '$.places[*]', body: {
        name: '$.name',
        wkt: { '$geo-text': '$.at' },
        cell: { $geohash: ['$.at', 5] },
        // a multi-item sequence in member position is JQ2001; the array
        // constructor is what puts a sequence into a member
        near: [{ '$geohash-neighbours': { $geohash: ['$.at', 5] } }],
      } },
      { match: '$.region', body: { '$geo-parse': '$' } },
      { match: '$.route', body: { '$geo-simplify': ['$', 0.01] } },
    ]);
    const out = transform({
      places: [{ name: 'Amsterdam', at: [4.9041, 52.3676] }],
      region: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))',
      route: { type: 'LineString', coordinates: [[0, 0], [1, 0.0001], [2, 0]] },
    });
    assert.strictEqual(out.places[0].wkt, 'POINT (4.9041 52.3676)');
    assert.strictEqual(out.places[0].cell, 'u173z');
    assert.strictEqual(out.places[0].near.length, 9);
    assert.strictEqual(out.region.type, 'Polygon');
    assert.deepStrictEqual(out.route.coordinates, [[0, 0], [2, 0]]);
  });

  it('should decode a cell to a polygon in a rule body', () => {
    const transform = compileJsltStylesheet([
      { match: '$.cell', body: { '$geohash-bounds': '$' } },
    ]);
    assert.strictEqual(transform({ cell: 'u173z' }).cell.type, 'Polygon');
  });
});

describe('section 8.15 — vectors', () => {
  // A vector is an array of numbers, so every case here is a value a
  // JSON document could actually hold. The exact answers are safe to
  // pin: cosine over these components is a ratio of small integers, not
  // a rounded measurement.
  const NAN = { $div: [0, 0] };
  const INF = { $div: [1, 0] };

  it('should answer the cosine of two vectors, higher-is-better', () => {
    assert.strictEqual(queryJson({ $similarity: [[1, 0], [1, 0]] }, {}), 1);
    assert.strictEqual(queryJson({ $similarity: [[1, 0], [0, 1]] }, {}), 0);
    assert.strictEqual(queryJson({ $similarity: [[1, 0], [-1, 0]] }, {}), -1);
    // 24/25: a ratio of integers, exact in binary64
    assert.strictEqual(queryJson({ $similarity: [[3, 4], [4, 3]] }, {}), 0.96);
    // magnitude is not direction — cosine ignores the scale of both
    assert.strictEqual(queryJson({ $similarity: [[3, 4], [30, 40]] }, {}), 1);
    // and it reads the document, not only literals
    assert.strictEqual(
      queryJson({ $similarity: ['$.a', '$.b'] }, { a: [1, 0, 0], b: [1, 0, 0] }), 1);
    assert.strictEqual(
      queryJson({ $similarity: ['$.a', '$q'] }, { a: [0, 1] }, { q: [0, 2] }), 1);
  });

  it('should refuse an operand that is not an array of numbers (JQ2001)', () => {
    // the type-level half of §8.14's split: a value with no components
    // has no similarity to anything, and answering empty would hide a
    // wrong column rather than name it
    runtimeFails({ $similarity: ['$.s', [1, 0]] }, { s: 'text' }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: [[1, 0], '$.s'] }, { s: 'text' }, 'JQ2001', '/$similarity/1');
    runtimeFails({ $similarity: ['$.o', [1, 0]] }, { o: { x: 1 } }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: ['$.n', [1, 0]] }, { n: 3 }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: ['$.b', [1, 0]] }, { b: true }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: ['$.z', [1, 0]] }, { z: null }, 'JQ2001', '/$similarity/0');
    // a MIXED array is the case that matters: it is shaped like a
    // vector and is not one
    runtimeFails({ $similarity: ['$.m', [1, 0]] }, { m: [1, 'x'] }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: ['$.m', [1, 0]] }, { m: [1, null] }, 'JQ2001', '/$similarity/0');
    runtimeFails({ $similarity: ['$.m', [1, 0]] }, { m: [[1], [0]] }, 'JQ2001', '/$similarity/0');
    // and the message names the component, not just the array
    assert.throws(() => queryJson({ $similarity: ['$.m', [1, 0]] }, { m: [1, 'x'] }),
      (e) => /at index 1/.test(e.message));
  });

  it('should answer empty for a comparison it cannot make', () => {
    // the data-level half: both operands ARE vectors and there is still
    // no answer. Nothing is padded, truncated or zero-filled to invent
    // one — two widths are not a near miss, they are unrelated
    assert.strictEqual(queryJson({ $similarity: [[3], [3, 4]] }, {}), undefined);
    assert.strictEqual(queryJson({ $similarity: [[3, 4], [3]] }, {}), undefined);
    assert.strictEqual(queryJson({ $similarity: [[], []] }, {}), undefined);
    assert.strictEqual(queryJson({ $similarity: [[], [1]] }, {}), undefined);
    // NaN and Infinity are not JSON numbers, but a computed value can
    // carry one, and the kernel's 0-on-malformed convention must not
    // leak here: 0 is a real similarity and this is not one
    assert.strictEqual(queryJson({ $similarity: [[NAN, 1], [1, 0]] }, {}), undefined);
    assert.strictEqual(queryJson({ $similarity: [[1, 0], [INF, 1]] }, {}), undefined);
    // and a missing operand propagates, as everywhere else
    assert.strictEqual(queryJson({ $similarity: ['$.nope', [1, 0]] }, {}), undefined);
  });

  it('should never leak the empty marker into a constructor', () => {
    // the cardinality declaration, proven from the outside: OPTIONAL,
    // never ONE. Declaring exactly-one lets the internal empty marker
    // escape into an array or object constructor, where it is neither
    // an item nor a JSON value
    const mismatch = { $similarity: [[3], [3, 4]] };
    assert.deepStrictEqual(queryJson([mismatch], {}), []);
    assert.deepStrictEqual(queryJson({ score: mismatch }, {}), {});
    // a document with no score is honest; one carrying 0 for a
    // comparison that never happened is not
    assert.deepStrictEqual(
      queryJson({ id: '$.id', score: { $similarity: ['$.v', '$q'] } },
        { id: 'a' }, { q: [1, 0] }),
      { id: 'a' });
  });

  it('should spell k-nearest as an ordering and a window, with no new keyword', () => {
    const data = {
      memories: [
        { id: 'a', text: 'alpha', embedding: [1, 0] },
        { id: 'b', text: 'beta', embedding: [0, 1] },
        { id: 'c', text: 'gamma' },
        { id: 'd', text: 'delta', embedding: [1, 0] },
        { id: 'e', text: 'epsilon', embedding: [1, 2, 3] },
      ],
    };
    const ranked = {
      $for: { m: '$.memories[*]' },
      $orderby: [
        { $key: { $similarity: ['$m.embedding', '$query'] }, $dir: 'desc', $empty: 'least' },
        '$m.id',
      ],
      $return: '$m.id',
    };
    // 'least' under 'desc' puts an empty key LAST, which is where a row
    // with no vector (c) or one of the wrong width (e) belongs: present
    // in the input, never in the top k, never scored
    assert.deepStrictEqual(queryJson(ranked, data, { query: [1, 0] }),
      ['a', 'd', 'b', 'c', 'e']);
    // the tie is broken by row identity, not by input order: stability
    // is only about the input, and identical similarities are exactly
    // what a corpus of near-duplicates produces
    const reversed = { memories: [...data.memories].reverse() };
    assert.deepStrictEqual(queryJson(ranked, reversed, { query: [1, 0] }),
      ['a', 'd', 'b', 'c', 'e']);
    // and the k is a window OUTSIDE the phrase
    assert.deepStrictEqual(
      queryJson({ $subsequence: [ranked, 0, 2] }, data, { query: [1, 0] }), ['a', 'd']);
  });

  it('should filter by a threshold, dropping the unvectored for free', () => {
    const data = { rows: [{ v: [1, 0] }, { v: [0, 1] }, { v: [0.9, 0.1] }, {}] };
    assert.deepStrictEqual(
      queryJson({
        $for: { r: '$.rows[*]' },
        $where: { $gt: [{ $similarity: ['$r.v', '$q'] }, 0.8] },
        $return: { $similarity: ['$r.v', '$q'] },
      }, data, { q: [1, 0] }),
      [1, 0.9938837346736189]);
  });

  it('should score the zero vector 0, the kernel\'s answer and not a refusal', () => {
    // the one degenerate pair the shape guard does not catch, and the
    // only place the operator answers a number it did not derive from a
    // direction: a zero vector has no direction, and @jarenjs/core's
    // kernel documents that it scores 0 against everything. Refusing it
    // here would put a fourth rule in the language that the kernel, the
    // ranked recall and the store would each have to learn too — and 0
    // is the truthful answer to \"how aligned are these\" when one of
    // them points nowhere
    assert.strictEqual(queryJson({ $similarity: [[0, 0], [1, 0]] }, {}), 0);
    assert.strictEqual(queryJson({ $similarity: [[0, 0], [0, 0]] }, {}), 0);
    // it is a SCORE, so it sorts like one — below every real alignment
    // and above nothing, which is where an all-zero embedding belongs
    assert.deepStrictEqual(
      queryJson({
        $for: { r: '$.rows[*]' },
        $orderby: [{ $key: { $similarity: ['$r.v', '$q'] }, $dir: 'desc', $empty: 'least' }, '$r.id'],
        $return: '$r.id',
      }, { rows: [{ id: 'zero', v: [0, 0] }, { id: 'near', v: [1, 0] }, { id: 'none' }] },
      { q: [1, 0] }),
      ['near', 'zero', 'none']);
  });

  it('should be inherited by a JSLT stylesheet, with no stylesheet feature', () => {
    // the operator registry is one table and JSLT rule bodies are query
    // expressions, so §8.15 arrives in stylesheets and in @jarenjs/linq
    // by construction — this proves it rather than assuming it
    const transform = compileJsltStylesheet([
      { match: '$.rows[*]', body: {
        id: '$.id',
        score: { $similarity: ['$.v', { $const: [1, 0] }] },
      } },
    ]);
    assert.deepStrictEqual(transform({ rows: [{ id: 'a', v: [3, 4] }, { id: 'b' }] }),
      { rows: [{ id: 'a', score: 0.6 }, { id: 'b' }] });
  });
});
