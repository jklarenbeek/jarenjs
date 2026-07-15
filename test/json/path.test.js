import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  parseJSONPath,
  compileJSONPath,
  queryJSONPath,
  isValidJSONPathStrict,
  JSONPathSyntaxError,
} from '@jarenjs/json';

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

function values(path, data) {
  return compileJSONPath(path)(data);
}

describe('parseJSONPath', () => {
  it('should parse the root-only query', () => {
    assert.deepEqual(parseJSONPath('$'), { relative: false, segments: [] });
  });

  it('should parse shorthand and bracketed names to the same AST', () => {
    assert.deepEqual(parseJSONPath('$.a'), parseJSONPath("$['a']"));
    assert.deepEqual(parseJSONPath('$.a'), parseJSONPath('$["a"]'));
  });

  it('should parse descendant segments', () => {
    const ast = parseJSONPath('$..price');
    assert.isTrue(ast.segments[0].descendant);
    assert.deepEqual(ast.segments[0].selectors, [{ kind: 'name', name: 'price' }]);
  });

  it('should decode string literal escapes', () => {
    assert.deepEqual(
      parseJSONPath('$["\\u0061\\n\\t\\\\\\/"]').segments[0].selectors[0],
      { kind: 'name', name: 'a\n\t\\/' });
    assert.deepEqual(
      parseJSONPath("$['\\''] ".trim()).segments[0].selectors[0],
      { kind: 'name', name: "'" });
  });

  it('should decode surrogate pair escapes', () => {
    assert.deepEqual(
      parseJSONPath('$["\\uD834\\uDD1E"]').segments[0].selectors[0],
      { kind: 'name', name: '\u{1D11E}' });
  });

  it('should throw JSONPathSyntaxError on invalid queries', () => {
    assert.throws(() => parseJSONPath('store'), JSONPathSyntaxError);
    assert.throws(() => parseJSONPath('$[?@.a = 1]'), JSONPathSyntaxError);
  });
});

describe('name selector (RFC 9535 2.3.1)', () => {
  // example document of section 2.3.1.3
  const data = { o: { 'j j': { 'k.k': 3 } }, "'": { '@': 2 } };

  it('should select named values with bracket notation', () => {
    assert.deepEqual(values("$.o['j j']", data), [{ 'k.k': 3 }]);
    assert.deepEqual(values("$.o['j j']['k.k']", data), [3]);
    assert.deepEqual(values('$.o["j j"]["k.k"]', data), [3]);
    assert.deepEqual(values('$["\'"]["@"]', data), [2]);
  });

  it('should select nothing for a missing member', () => {
    assert.deepEqual(values('$.nosuch', data), []);
  });

  it('should not select from arrays or primitives', () => {
    assert.deepEqual(values('$.length', [1, 2, 3]), []);
    assert.deepEqual(values('$.a', 'a'), []);
  });

  it('should not consult the prototype chain', () => {
    assert.deepEqual(values('$.toString', { a: 1 }), []);
    assert.deepEqual(values('$.constructor', { a: 1 }), []);
  });
});

describe('wildcard selector (RFC 9535 2.3.2)', () => {
  // example document of section 2.3.2.3
  const data = { o: { j: 1, k: 2 }, a: [5, 3] };

  it('should select all children of the root', () => {
    assert.deepEqual(values('$[*]', data), [{ j: 1, k: 2 }, [5, 3]]);
  });

  it('should select object member values', () => {
    assert.deepEqual(values('$.o[*]', data), [1, 2]);
    assert.deepEqual(values('$.o.*', data), [1, 2]);
  });

  it('should apply each selector of a multi-selector per node', () => {
    assert.deepEqual(values('$.o[*, *]', data), [1, 2, 1, 2]);
  });

  it('should select array elements', () => {
    assert.deepEqual(values('$.a[*]', data), [5, 3]);
  });

  it('should select nothing on primitives', () => {
    assert.deepEqual(values('$[*]', 42), []);
    assert.deepEqual(values('$[*]', null), []);
  });
});

describe('index selector (RFC 9535 2.3.3)', () => {
  // example document of section 2.3.3.3
  const data = ['a', 'b'];

  it('should select an element by index', () => {
    assert.deepEqual(values('$[1]', data), ['b']);
    assert.deepEqual(values('$[0]', data), ['a']);
  });

  it('should select from the end with a negative index', () => {
    assert.deepEqual(values('$[-2]', data), ['a']);
    assert.deepEqual(values('$[-1]', data), ['b']);
  });

  it('should select nothing when out of bounds', () => {
    assert.deepEqual(values('$[2]', data), []);
    assert.deepEqual(values('$[-3]', data), []);
  });

  it('should not apply to objects', () => {
    assert.deepEqual(values('$[0]', { 0: 'x' }), []);
  });
});

describe('slice selector (RFC 9535 2.3.4)', () => {
  // example document of section 2.3.4.3
  const data = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('should slice with start and end', () => {
    assert.deepEqual(values('$[1:3]', data), ['b', 'c']);
  });

  it('should slice with default end', () => {
    assert.deepEqual(values('$[5:]', data), ['f', 'g']);
  });

  it('should slice with a step', () => {
    assert.deepEqual(values('$[1:5:2]', data), ['b', 'd']);
  });

  it('should slice backwards with a negative step', () => {
    assert.deepEqual(values('$[5:1:-2]', data), ['f', 'd']);
    assert.deepEqual(values('$[::-1]', data), ['g', 'f', 'e', 'd', 'c', 'b', 'a']);
  });

  it('should select nothing with step 0', () => {
    assert.deepEqual(values('$[0:5:0]', data), []);
  });

  it('should clamp out-of-range bounds', () => {
    assert.deepEqual(values('$[-100:100]', data), data);
    assert.deepEqual(values('$[100:200]', data), []);
  });

  it('should accept whitespace within the slice', () => {
    assert.deepEqual(values('$[1 :5: 2]', data), ['b', 'd']);
    assert.deepEqual(values('$[1:2: ]', data), ['b']);
  });

  it('should not apply to objects', () => {
    assert.deepEqual(values('$[0:2]', { a: 1 }), []);
  });
});

describe('filter selector (RFC 9535 2.3.5)', () => {
  // example document of section 2.3.5.3
  const data = {
    a: [3, 5, 1, 2, 4, 6, { b: 'j' }, { b: 'k' }, { b: {} }, { b: 'kilo' }],
    o: { p: 1, q: 2, r: 3, s: 5, t: { u: 6 } },
    e: 'f',
  };

  it('should filter by member value comparison', () => {
    assert.deepEqual(values("$.a[?@.b == 'kilo']", data), [{ b: 'kilo' }]);
    assert.deepEqual(values('$.a[?(@.b == "kilo")]', data), [{ b: 'kilo' }]);
  });

  it('should compare the current node itself', () => {
    assert.deepEqual(values('$.a[?@>3.5]', data), [5, 4, 6]);
  });

  it('should test existence of a member', () => {
    assert.deepEqual(values('$.a[?@.b]', data), [{ b: 'j' }, { b: 'k' }, { b: {} }, { b: 'kilo' }]);
  });

  it('should support non-singular existence tests', () => {
    assert.deepEqual(values('$[?@.*]', data), [data.a, data.o]);
    assert.deepEqual(values('$[?@[?@.b]]', data), [data.a]);
  });

  it('should keep duplicates from multiple filter selectors', () => {
    assert.deepEqual(values('$.o[?@<3, ?@<3]', data), [1, 2, 1, 2]);
  });

  it('should support logical or and and', () => {
    assert.deepEqual(values('$.a[?@<2 || @.b == "k"]', data), [1, { b: 'k' }]);
    assert.deepEqual(values('$.o[?@>1 && @<4]', data), [2, 3]);
    assert.deepEqual(values('$.o[?@.u || @.x]', data), [{ u: 6 }]);
  });

  it('should support logical not', () => {
    assert.deepEqual(values('$.a[?!@.b]', data), [3, 5, 1, 2, 4, 6]);
    assert.deepEqual(values('$.o[?!(@<3)]', data), [3, 5, { u: 6 }]);
  });

  it('should compare against absolute singular queries', () => {
    // Nothing == Nothing is true; numbers have no member b
    assert.deepEqual(values('$.a[?@.b == $.x]', data), [3, 5, 1, 2, 4, 6]);
    assert.deepEqual(values('$.a[?@ == @]', data), data.a);
  });

  it('should filter object member values', () => {
    assert.deepEqual(values('$.o[?@ == 1]', data), [1]);
  });

  it('should select nothing on primitives', () => {
    assert.deepEqual(values('$.e[?@]', data), []);
  });
});

describe('comparison semantics (RFC 9535 2.3.5.2.2)', () => {
  // example document of section 2.3.5.3, comparison table
  const data = { obj: { x: 'y' }, arr: [2, 3], probe: [0] };

  function truth(expr) {
    return compileJSONPath(`$.probe[?${expr}]`)(data).length === 1;
  }

  it('should treat two empty nodelists as equal', () => {
    assert.isTrue(truth('$.absent1 == $.absent2'));
    assert.isTrue(truth('$.absent1 <= $.absent2'));
    assert.isFalse(truth('$.absent1 != $.absent2'));
    assert.isFalse(truth("$.absent == 'g'"));
    assert.isTrue(truth("$.absent != 'g'"));
    assert.isFalse(truth("$.absent < 'g'"));
  });

  it('should order numbers and strings only', () => {
    assert.isTrue(truth('1 <= 2'));
    assert.isFalse(truth('1 > 2'));
    assert.isFalse(truth("13 == '13'"));
    assert.isTrue(truth("'a' <= 'b'"));
    assert.isFalse(truth("'a' > 'b'"));
    assert.isFalse(truth('1 <= $.arr'));
    assert.isFalse(truth('1 >= $.arr'));
    assert.isFalse(truth('1 > $.arr'));
    assert.isFalse(truth('1 < $.arr'));
  });

  it('should deep-compare structured values', () => {
    assert.isFalse(truth('$.obj == $.arr'));
    assert.isTrue(truth('$.obj != $.arr'));
    assert.isTrue(truth('$.obj == $.obj'));
    assert.isFalse(truth('$.obj != $.obj'));
    assert.isTrue(truth('$.arr == $.arr'));
    assert.isTrue(truth('$.obj <= $.obj'));
    assert.isFalse(truth('$.obj < $.obj'));
  });

  it('should compare booleans by equality only', () => {
    assert.isTrue(truth('true <= true'));
    assert.isFalse(truth('true > true'));
    assert.isFalse(truth('true < true'));
    assert.isTrue(truth('null == null'));
    assert.isFalse(truth('null == false'));
  });

  it('should compare numbers mathematically', () => {
    assert.isTrue(truth('1 == 1.0'));
    assert.isTrue(truth('1e2 == 100'));
    assert.isTrue(truth('-0 == 0'));
    assert.isTrue(truth('0.5 == 5e-1'));
  });
});

describe('function extensions (RFC 9535 2.4)', () => {
  it('should compute length() of strings, arrays and objects', () => {
    const data = [{ v: 'ab' }, { v: 'a\u{1D11E}' }, { v: [1, 2, 3] }, { v: { a: 1 } }, { v: 5 }, {}];
    assert.deepEqual(values('$[?length(@.v) == 2]', data),
      [{ v: 'ab' }, { v: 'a\u{1D11E}' }]); // code points, not UTF-16 units
    assert.deepEqual(values('$[?length(@.v) == 3]', data), [{ v: [1, 2, 3] }]);
    assert.deepEqual(values('$[?length(@.v) == 1]', data), [{ v: { a: 1 } }]);
    // length of a number or of Nothing is Nothing; comparisons are false
    assert.deepEqual(values('$[?length(@.v) >= 0]', data),
      [{ v: 'ab' }, { v: 'a\u{1D11E}' }, { v: [1, 2, 3] }, { v: { a: 1 } }]);
  });

  it('should count() the nodes of any query', () => {
    const data = [{ a: [1, 2, 3] }, { a: [1] }, { a: 'scalar' }];
    assert.deepEqual(values('$[?count(@.a[*]) == 3]', data), [{ a: [1, 2, 3] }]);
    assert.deepEqual(values('$[?count(@.a) == 1]', data), data);
    assert.deepEqual(values('$[?count(@.missing) == 0]', data), data);
  });

  it('should resolve value() of a single-node query', () => {
    const data = [{ color: 'red' }, { deep: { color: 'red' } }, { color: 'blue' }];
    assert.deepEqual(values('$[?value(@..color) == "red"]', data),
      [{ color: 'red' }, { deep: { color: 'red' } }]);
  });

  it('should match() the entire string against an I-Regexp', () => {
    const data = { a: [3, 5, 1, 2, 4, 6, { b: 'j' }, { b: 'k' }, { b: {} }, { b: 'kilo' }] };
    assert.deepEqual(values('$.a[?match(@.b, "[jk]")]', data), [{ b: 'j' }, { b: 'k' }]);
  });

  it('should search() for a substring match', () => {
    const data = { a: [3, 5, 1, 2, 4, 6, { b: 'j' }, { b: 'k' }, { b: {} }, { b: 'kilo' }] };
    assert.deepEqual(values('$.a[?search(@.b, "[jk]")]', data), [{ b: 'j' }, { b: 'k' }, { b: 'kilo' }]);
  });

  it('should translate I-Regexp dots to not match line terminators', () => {
    assert.deepEqual(values('$[?match(@, "a.b")]', ['axb', 'a\nb', 'ab']), ['axb']);
  });

  it('should evaluate dynamic (non-literal) regexp patterns', () => {
    const data = [{ s: 'hello', re: 'h.*' }, { s: 'hello', re: 'x.*' }];
    assert.deepEqual(values('$[?match(@.s, @.re)]', data), [{ s: 'hello', re: 'h.*' }]);
  });

  it('should return false for invalid or non-string regexp inputs', () => {
    assert.deepEqual(values('$[?match(@, "([")]', ['a']), []);
    assert.deepEqual(values('$[?match(@, 5)]', ['a']), []);
    assert.deepEqual(values('$[?search(@.x, "a")]', [{ x: 5 }]), []);
  });

  it('should allow function results in comparisons and nesting', () => {
    const data = [{ a: 'abcd' }, { a: 'ab' }];
    assert.deepEqual(values('$[?length(@.a) > 3]', data), [{ a: 'abcd' }]);
    assert.deepEqual(values('$[?length(value($[0].a)) == 4]', data), data);
  });
});

describe('child and descendant segments (RFC 9535 2.5)', () => {
  it('should apply multiple selectors in order per node', () => {
    // example document of section 2.5.1.3
    const data = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.deepEqual(values('$[0, 3]', data), ['a', 'd']);
    assert.deepEqual(values('$[0:2, 5]', data), ['a', 'b', 'f']);
    assert.deepEqual(values('$[0, 0]', data), ['a', 'a']);
  });

  it('should visit descendants in document order', () => {
    // example document of section 2.5.2.3
    const data = { o: { j: 1, k: 2 }, a: [5, 3, [{ j: 4 }, { k: 6 }]] };
    assert.deepEqual(values('$..j', data), [1, 4]);
    assert.deepEqual(values('$..[0]', data), [5, { j: 4 }]);
    assert.deepEqual(values('$..[*]', data).length, 11);
    assert.deepEqual(values('$..*', data).length, 11);
    assert.deepEqual(values('$..o', data), [{ j: 1, k: 2 }]);
    assert.deepEqual(values('$.o..[*, *]', data), [1, 2, 1, 2]);
    assert.deepEqual(values('$.a..[0, 1]', data), [5, 3, { j: 4 }, { k: 6 }]);
  });

  it('should run the bookstore examples of section 1.5', () => {
    assert.deepEqual(values('$.store.book[*].author', bookstore),
      ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
    assert.deepEqual(values('$..author', bookstore),
      ['Nigel Rees', 'Evelyn Waugh', 'Herman Melville', 'J. R. R. Tolkien']);
    assert.deepEqual(values('$.store.*', bookstore), [bookstore.store.book, bookstore.store.bicycle]);
    assert.deepEqual(values('$.store..price', bookstore), [8.95, 12.99, 8.99, 22.99, 399]);
    assert.deepEqual(values('$..book[2].author', bookstore), ['Herman Melville']);
    assert.deepEqual(values('$..book[2].publisher', bookstore), []);
    assert.deepEqual(values('$..book[-1]', bookstore), [bookstore.store.book[3]]);
    assert.deepEqual(values('$..book[0,1]', bookstore), bookstore.store.book.slice(0, 2));
    assert.deepEqual(values('$..book[:2]', bookstore), bookstore.store.book.slice(0, 2));
    assert.deepEqual(values('$..book[?@.isbn]', bookstore), bookstore.store.book.slice(2));
    assert.deepEqual(values('$..book[?@.price<10]', bookstore),
      [bookstore.store.book[0], bookstore.store.book[2]]);
    assert.deepEqual(values('$..*', bookstore).length, 27);
  });
});

describe('null semantics (RFC 9535 2.6)', () => {
  // example document of section 2.6.1
  const data = { a: null, b: [null], c: [{}], null: 1 };

  it('should treat null as a regular member value', () => {
    assert.deepEqual(values('$.a', data), [null]);
    assert.deepEqual(values('$.null', data), [1]);
  });

  it('should not treat null as a container', () => {
    assert.deepEqual(values('$.a[0]', data), []);
    assert.deepEqual(values('$.a.d', data), []);
  });

  it('should select null array elements', () => {
    assert.deepEqual(values('$.b[0]', data), [null]);
    assert.deepEqual(values('$.b[*]', data), [null]);
    assert.deepEqual(values('$.b[?@]', data), [null]);
    assert.deepEqual(values('$.b[?@==null]', data), [null]);
  });

  it('should distinguish null from missing (Nothing)', () => {
    assert.deepEqual(values('$.c[?@.d==null]', data), []);
  });
});

describe('normalized paths (RFC 9535 2.7)', () => {
  it('should produce bracketed single-quoted paths', () => {
    const q = compileJSONPath('$.store.book[?@.price<10].title');
    assert.deepEqual(q.paths(bookstore), [
      "$['store']['book'][0]['title']",
      "$['store']['book'][2]['title']",
    ]);
  });

  it('should pair paths with values in nodes()', () => {
    const q = compileJSONPath('$..book[-1].title');
    assert.deepEqual(q.nodes(bookstore), [
      { path: "$['store']['book'][3]['title']", value: 'The Lord of the Rings' },
    ]);
  });

  it('should escape names in normalized paths', () => {
    const nulKey = String.fromCharCode(0) + '\n\\';
    const data = { 'a b': { "c'd": { [nulKey]: 1 } } };
    const q = compileJSONPath('$..*');
    const paths = q.paths(data);
    assert.deepEqual(paths, [
      "$['a b']",
      "$['a b']['c\\'d']",
      "$['a b']['c\\'d']['\\u0000\\n\\\\']",
    ]);
  });

  it('should normalize negative indexes and slices to element indexes', () => {
    const q = compileJSONPath('$[-1]');
    assert.deepEqual(q.paths(['x', 'y']), ['$[1]']);
    const s = compileJSONPath('$[::-1]');
    assert.deepEqual(s.paths(['x', 'y']), ['$[1]', '$[0]']);
  });

  it('should return the root path for $', () => {
    assert.deepEqual(compileJSONPath('$').paths(bookstore), ['$']);
  });
});

describe('compiled query API', () => {
  it('should expose values, first and exists', () => {
    const q = compileJSONPath('$..price');
    assert.deepEqual(q(bookstore), [8.95, 12.99, 8.99, 22.99, 399]);
    assert.deepEqual(q.values(bookstore), q(bookstore));
    assert.deepEqual(q.first(bookstore), 8.95);
    assert.isTrue(q.exists(bookstore));
    assert.isFalse(q.exists({}));
    assert.deepEqual(compileJSONPath('$.missing').first(bookstore), undefined);
  });

  it('should use the singular fast path consistently', () => {
    const q = compileJSONPath('$.store.book[1].title');
    assert.deepEqual(q(bookstore), ['Sword of Honour']);
    assert.deepEqual(q.first(bookstore), 'Sword of Honour');
    assert.isTrue(q.exists(bookstore));
    assert.deepEqual(q.paths(bookstore), ["$['store']['book'][1]['title']"]);
    const missing = compileJSONPath('$.store.book[9].title');
    assert.deepEqual(missing(bookstore), []);
    assert.isFalse(missing.exists(bookstore));
  });

  it('should select the root document with $', () => {
    assert.deepEqual(compileJSONPath('$')(bookstore), [bookstore]);
    assert.deepEqual(compileJSONPath('$')(null), [null]);
    assert.deepEqual(compileJSONPath('$')(42), [42]);
  });

  it('should expose source and ast', () => {
    const q = compileJSONPath('$.a[*]');
    assert.deepEqual(q.source, '$.a[*]');
    assert.deepEqual(q.ast.segments.length, 2);
  });

  it('should answer one-shot queries through the cache', () => {
    assert.deepEqual(queryJSONPath('$[0]', ['a']), ['a']);
    assert.deepEqual(queryJSONPath('$[0]', ['b']), ['b']);
  });
});

describe('I-Regexp conformance (RFC 9485)', () => {
  // RFC 9535 2.4.6/2.4.7: match()/search() with a pattern that is not a
  // valid I-Regexp must yield LogicalFalse, even when ECMAScript would
  // happily execute it.
  it('should reject ECMAScript-only syntax as LogicalFalse', () => {
    assert.deepEqual(values('$[?match(@, "(?=a)a")]', ['a']), []); // lookahead
    assert.deepEqual(values('$[?match(@, "(?:a)")]', ['a']), []); // non-capturing group
    assert.deepEqual(values('$[?match(@, "(?i)a")]', ['A']), []); // inline flags
    assert.deepEqual(values('$[?match(@, "(a)\\\\1")]', ['aa']), []); // backreference
    assert.deepEqual(values('$[?search(@, "\\\\d")]', ['5']), []); // multi-char escape
    assert.deepEqual(values('$[?search(@, "\\\\w")]', ['x']), []);
    assert.deepEqual(values('$[?search(@, "\\\\b5")]', ['5']), []); // word boundary
    assert.deepEqual(values('$[?match(@, "a*?")]', ['a']), []); // lazy quantifier
    assert.deepEqual(values('$[?match(@, "a{1,2}?")]', ['a']), []);
    assert.deepEqual(values('$[?match(@, "[]")]', ['a']), []); // empty class
    assert.deepEqual(values('$[?match(@, "[^]")]', ['a']), []); // forbidden by RFC 9485
    assert.deepEqual(values('$[?match(@, "\\\\p{Xx}")]', ['a']), []); // unknown category
    assert.deepEqual(values('$[?match(@, "\\\\p{Lul}")]', ['a']), []);
    assert.deepEqual(values('$[?match(@, "a{2,1}")]', ['a']), []); // out-of-order bounds
  });

  it('should give unescaped ^ and $ anchor semantics per the RFC 9485 5.3 conversion', () => {
    // the CTS "explicit caret/dollar" tests require this behavior
    assert.deepEqual(values('$[?match(@, "^ab.*")]', ['abc', 'axc', 'ab', 'xab']), ['abc', 'ab']);
    assert.deepEqual(values('$[?match(@, ".*bc$")]', ['abc', 'axc', 'ab', 'abcx']), ['abc']);
    assert.deepEqual(values('$[?search(@, "^ab")]', ['xab', 'aby']), ['aby']);
    // literal forms: '\^' is a valid escape, a literal dollar needs a class
    assert.deepEqual(values('$[?match(@, "\\\\^a")]', ['^a', 'a']), ['^a']);
    assert.deepEqual(values('$[?match(@, "a[$]")]', ['a$', 'a']), ['a$']);
    assert.deepEqual(values('$[?match(@, "a\\\\$")]', ['a$']), []); // \$ is not I-Regexp
  });

  it('should support the full I-Regexp feature set', () => {
    assert.deepEqual(values('$[?match(@, "a|b")]', ['a', 'b', 'c']), ['a', 'b']);
    assert.deepEqual(values('$[?match(@, "(ab)+")]', ['abab', 'aba']), ['abab']);
    assert.deepEqual(values('$[?match(@, "a{2}")]', ['aa', 'a']), ['aa']);
    assert.deepEqual(values('$[?match(@, "a{2,}")]', ['aaa', 'a']), ['aaa']);
    assert.deepEqual(values('$[?match(@, "[a-c]")]', ['b', 'd']), ['b']);
    assert.deepEqual(values('$[?match(@, "[^a-c]")]', ['b', 'd']), ['d']);
    assert.deepEqual(values('$[?match(@, "[-a]")]', ['-', 'a', 'b']), ['-', 'a']);
    assert.deepEqual(values('$[?match(@, "[a-]")]', ['-', 'a', 'b']), ['-', 'a']);
    assert.deepEqual(values('$[?match(@, "\\\\p{Lu}")]', ['A', 'a']), ['A']);
    assert.deepEqual(values('$[?match(@, "\\\\P{Lu}")]', ['A', 'a']), ['a']);
    assert.deepEqual(values('$[?match(@, "\\\\(\\\\)")]', ['()']), ['()']);
    assert.deepEqual(values('$[?match(@, "a\\\\-b")]', ['a-b']), ['a-b']); // \- outside class
    assert.deepEqual(values('$[?match(@, "[\\\\n-\\\\r]")]', ['\n', 'a']), ['\n']); // escape range
    assert.deepEqual(values('$[?match(@, "")]', ['', 'a']), ['']); // empty pattern
    assert.deepEqual(values('$[?match(@, "a|")]', ['a', '']), ['a', '']); // empty branch
  });
});

describe('Unicode scalar value ordering (RFC 9535 2.3.5.2.2)', () => {
  it('should order strings by code points, not UTF-16 code units', () => {
    // U+E000 < U+10000 by scalar value; UTF-16 code units say otherwise
    assert.deepEqual(values('$[?@ < "\u{10000}"]', ['']), ['']);
    assert.deepEqual(values('$[?@ > ""]', ['\u{10000}']), ['\u{10000}']);
    assert.deepEqual(values('$[?@ < ""]', ['\u{10000}']), []);
    assert.deepEqual(values('$[?@ <= "\u{10000}"]', ['\u{10000}']), ['\u{10000}']);
  });

  it('should order plain strings lexicographically', () => {
    assert.deepEqual(values('$[?@ < "b"]', ['a', 'c']), ['a']);
    assert.deepEqual(values('$[?@ < "ab"]', ['a', 'ab', 'abc']), ['a']);
    assert.deepEqual(values('$[?@ >= "ab"]', ['a', 'ab', 'abc']), ['ab', 'abc']);
  });
});

describe('lone surrogate rejection (RFC 9535 2.1)', () => {
  const HI = String.fromCharCode(0xD834);
  const LO = String.fromCharCode(0xDD1E);

  it('should reject raw lone surrogates in member-name shorthand', () => {
    assert.isFalse(isValidJSONPathStrict('$.' + HI));
    assert.isFalse(isValidJSONPathStrict('$.a' + HI + 'b'));
    assert.isFalse(isValidJSONPathStrict('$.' + LO));
  });

  it('should reject raw lone surrogates in string literals', () => {
    assert.isFalse(isValidJSONPathStrict("$['" + HI + "']"));
    assert.isFalse(isValidJSONPathStrict('$["' + LO + '"]'));
  });

  it('should accept well-formed raw surrogate pairs', () => {
    assert.isTrue(isValidJSONPathStrict('$.' + HI + LO));
    assert.isTrue(isValidJSONPathStrict("$['" + HI + LO + "']"));
    assert.deepEqual(values('$.' + HI + LO, { [HI + LO]: 1 }), [1]);
  });
});

describe('AST immutability', () => {
  it('should expose a deeply frozen AST', () => {
    const q = compileJSONPath('$.a[?@.b == 1]');
    assert.isTrue(Object.isFrozen(q.ast));
    assert.isTrue(Object.isFrozen(q.ast.segments));
    assert.isTrue(Object.isFrozen(q.ast.segments[0].selectors[0]));
    assert.isTrue(Object.isFrozen(q.ast.segments[1].selectors[0].expr));
  });

  it('should keep value mode and path mode in agreement', () => {
    const q = compileJSONPath('$.a');
    assert.throws(() => { q.ast.segments[0].selectors[0].name = 'b'; }, TypeError);
    assert.deepEqual(q({ a: 1, b: 2 }), [1]);
    assert.deepEqual(q.paths({ a: 1, b: 2 }), ["$['a']"]);
  });

  it('should return a fresh mutable AST from parseJSONPath', () => {
    const ast = parseJSONPath('$.a');
    assert.isFalse(Object.isFrozen(ast));
  });
});

describe('isValidJSONPathStrict', () => {
  it('should accept valid queries', () => {
    const valid = [
      '$',
      '$.a',
      '$ .a',
      '$.a.b.c',
      '$.a[*]',
      '$.*',
      '$..a',
      '$..*',
      '$..[0]',
      "$['a']",
      '$["a"]',
      "$['\\u0061']",
      '$[0]',
      '$[-1]',
      '$[0, 1]',
      '$[0:5]',
      '$[0:5:2]',
      '$[::-1]',
      '$[:]',
      '$[ 1 , 2 ]',
      '$[?@.a]',
      '$[? @.a]',
      '$[?(@.a)]',
      '$[?!@.a]',
      '$[?!(@.a == 1)]',
      '$[?@.a == -0]',
      '$[?@.a == 1e3]',
      '$[?@.a == 1.5E-3]',
      "$[?@.a == 'b' && @.c > 1 || @.d]",
      '$[?@.a == $.b.c]',
      '$[?@ == @]',
      '$[?length(@) == 1]',
      '$[?count(@.*) > 2]',
      "$[?match(@.a, 'x.*')]",
      "$[?search(@.a, 'x')]",
      '$[?value(@..a) == 2]',
      '$[?length(value(@.a)) == 1]',
      '$[9007199254740991]',
      '$.é世',
      '$._foo',
    ];
    for (const path of valid)
      assert.isTrue(isValidJSONPathStrict(path), `expected valid: ${path}`);
  });

  it('should reject invalid queries', () => {
    const invalid = [
      '',
      '$.',
      '$..',
      '@.a', // queries start at $
      ' $.a', // leading whitespace
      '$.a ', // trailing whitespace
      '$. a', // whitespace after dot
      '$.. a',
      '$.1', // shorthand cannot start with a digit
      '$.-a',
      '$a',
      '$[]',
      '$[1,]',
      '$[,1]',
      '$[01]', // leading zero
      '$[-0]',
      '$[1.5]',
      '$[9007199254740992]', // out of I-JSON range
      "$['a]", // unterminated string
      '$["a\\x"]', // invalid escape
      "$['\\u12']", // bad hex
      '$["\\uD800"]', // lone surrogate
      "$['\n']", // unescaped control character
      "$[\"'\\\"\"]".replace('\\"', "\\'"), // \' inside double quotes
      '$[?]',
      '$[?@.a ==]',
      '$[?@.a = 1]',
      '$[?@.a === 1]',
      '$[?@.a !< 1]',
      '$[?@.a &&]',
      '$[?@[*] == 1]', // non-singular query in comparison
      '$[?@.a == @[*]]',
      '$[?1]', // bare literal is not a test
      '$[?true]',
      '$[?length(@)]', // ValueType function as a test
      '$[?count(1) == 1]', // literal where a query is required
      '$[?count(@.*, 2) == 1]', // wrong arity
      '$[?match(@.a)]',
      '$[?match(@[*], "x")]', // non-singular where ValueType is required
      '$[?nosuch(@)]', // unknown function
      '$[?@.a == true1]',
      '$[0:5:0:1]',
      '$(0)',
      '$[?(@.a]',
      '$..[?@.a', // unterminated bracket
      '$é', // segment must start with . or [
    ];
    for (const path of invalid)
      assert.isFalse(isValidJSONPathStrict(path), `expected invalid: ${path}`);
  });

  it('should reject non-string input', () => {
    assert.isFalse(isValidJSONPathStrict(null));
    assert.isFalse(isValidJSONPathStrict(42));
    assert.isFalse(isValidJSONPathStrict(undefined));
  });
});
