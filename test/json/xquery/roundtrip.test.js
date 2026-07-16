import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseXQuery, compileXQuery } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// Every document the parser emits must validate against both query-format
// schema artifacts before it is compiled and run.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.join(__dirname, '..', '..', '..', 'packages', 'json', 'schemas');

function compileArtifact(name) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemasDir, name), 'utf8'));
  const compiler = new JarenValidator({ formatAssertion: true });
  compiler.addFormats(formats.jsonFormats);
  return compiler.compile(schema);
}

const validators = [
  ['draft 2020-12 (canonical)', compileArtifact('jaren-query.schema.json')],
  ['draft-07 (twin)', compileArtifact('jaren-query.draft-07.schema.json')],
];

// The bookstore example from RFC 9535, section 1.5, plus the ratings array
// of the spec's join example (QUERY-FORMAT.md appendix A)
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
  ratings: [
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-000-00000-0', stars: 1 },
  ],
};

// parse -> schema-validate the emitted document -> compile -> run against
// the bookstore (bound as the $doc external; absolute paths have no
// textual form in the front-end)
function run(text) {
  const doc = parseXQuery(text);
  for (const [draft, validate] of validators) {
    assert.strictEqual(validate(doc), true,
      `emitted document must validate under ${draft}: ${JSON.stringify(doc)}`);
  }
  return compileXQuery(text)(bookstore, { doc: bookstore });
}

describe('XQuery front-end roundtrips', () => {

  describe('spec examples as XQuery text', () => {
    // Appendix A examples use absolute paths ("$.store.book[*]"); the
    // front-end reaches the document through the $doc external instead -
    // same shapes, same results.

    it('should run example A.2 - bookstore FLWOR', () => {
      assert.deepStrictEqual(
        run(`for $b in $doc?store?book?*
             where $b?price lt 10
             order by $b?price
             return map { "title": $b?title, "price": $b?price }`),
        [
          { title: 'Sayings of the Century', price: 8.95 },
          { title: 'Moby Dick', price: 8.99 },
        ]);
    });

    it('should run example A.3 - join over books and ratings', () => {
      assert.deepStrictEqual(
        run(`for $b in $doc?store?book?*, $r in $doc?ratings?*
             where $b?isbn = $r?isbn
             order by $b?price
             return map { "title": $b?title, "stars": $r?stars }`),
        [
          { title: 'Moby Dick', stars: 4 },
          { title: 'The Lord of the Rings', stars: 5 },
        ]);
    });

    it('should run example A.4 - group by with aggregates', () => {
      assert.deepStrictEqual(
        run(`for $b in $doc?store?book?*
             group by $genre := $b?category
             return map { "genre": $genre, "count": count($b), "avg": avg($b?price) }`),
        [
          { genre: 'reference', count: 1, avg: 8.95 },
          { genre: 'fiction', count: 3, avg: (12.99 + 8.99 + 22.99) / 3 },
        ]);
    });

    it('should run example A.7 - quantifier over a let binding', () => {
      assert.strictEqual(
        run(`let $books := $doc?store?book?*
             return some $b in $books satisfies $b?price gt 20`),
        true);
      assert.strictEqual(
        run(`let $books := $doc?store?book?*
             return every $b in $books satisfies $b?price gt 20`),
        false);
    });

    it('should emit example A.2 in the exact spec shape (modulo the $doc root)', () => {
      assert.deepStrictEqual(
        parseXQuery('for $b in $doc?store?book?* where $b?price lt 10 order by $b?price return map { "title": $b?title, "price": $b?price }'),
        {
          '$for': { b: '$doc.store.book[*]' },
          '$where': { '$lt': ['$b.price', 10] },
          '$orderby': '$b.price',
          '$return': { title: '$b.title', price: '$b.price' },
        });
    });
  });

  describe('externals', () => {
    it('should collect free variables as externals (use is the declaration)', () => {
      const q = compileXQuery('for $b in $doc?store?book?* where $b?price ge $minPrice return $b?title');
      assert.deepStrictEqual(q.externals, ['doc', 'minPrice']);
      assert.deepStrictEqual(q(null, { doc: bookstore, minPrice: 20 }), 'The Lord of the Rings');
    });

    it('should accept declare variable ... external as documentation', () => {
      const q = compileXQuery(
        'declare variable $doc external; declare variable $minPrice external; ' +
        'for $b in $doc?store?book?* where $b?price ge $minPrice return $b?title');
      assert.deepStrictEqual(q.externals, ['doc', 'minPrice']);
      assert.deepStrictEqual(q(null, { doc: bookstore, minPrice: 10 }),
        ['Sword of Honour', 'The Lord of the Rings']);
    });
  });

  describe('expressions end-to-end', () => {
    it('should evaluate arithmetic, ranges, and comparisons', () => {
      assert.strictEqual(run('1 + 2 * 3'), 7);
      assert.strictEqual(run('7 idiv 2'), 3);
      assert.strictEqual(run('7 mod 2'), 1);
      assert.strictEqual(run('-(1 + 2)'), -3);
      assert.deepStrictEqual(run('1 to 4'), [1, 2, 3, 4]);
      assert.strictEqual(run('(1 to 3) = 3'), true); // existential general comparison
      assert.deepStrictEqual(run('2 + 3 to 6'), [5, 6]); // range binds below additive
    });

    it('should evaluate string operators', () => {
      assert.strictEqual(run('"a" || "b" || "c"'), 'abc');
      assert.strictEqual(run('upper-case("abc")'), 'ABC');
      assert.strictEqual(run('substring("hello", 2)'), 'ello');
      assert.strictEqual(run('substring("hello", 2, 3)'), 'ell');
      assert.strictEqual(run('substring("hello", 0)'), 'hello');
      assert.strictEqual(run('string-join(("a","b","c"), "-")'), 'a-b-c');
      assert.strictEqual(run('matches("hello", "ell")'), true);
      assert.strictEqual(run('replace("banana", "a", "o")'), 'bonono');
      assert.strictEqual(run('normalize-space("  a   b ")'), 'a b');
      assert.strictEqual(run('string-length("héllo")'), 5);
    });

    it('should evaluate sequence functions with the D6 positions', () => {
      assert.deepStrictEqual(run('subsequence((1,2,3,4), 2, 2)'), [2, 3]);
      assert.deepStrictEqual(run('index-of((10, 20, 10), 10)'), [0, 2]); // 0-based results
      assert.deepStrictEqual(run('reverse((1,2,3))'), [3, 2, 1]);
      assert.deepStrictEqual(run('distinct-values((1,2,1,3))'), [1, 2, 3]);
      assert.strictEqual(run('head((7,8))'), 7);
      assert.strictEqual(run('tail((7,8))'), 8);
      assert.strictEqual(run('count($doc?store?book?*)'), 4);
      assert.strictEqual(run('array:get([10,20,30], 2)'), 20);
      assert.strictEqual(run('map:get($doc?store?bicycle, "color")'), 'red');
    });

    it('should evaluate casts and conditionals', () => {
      assert.strictEqual(run('number("12") + 1'), 13);
      assert.strictEqual(run('string(12)'), '12');
      assert.strictEqual(run('boolean(())'), false);
      assert.strictEqual(run('if (exists($doc?store?bicycle)) then "yes" else "no"'), 'yes');
      assert.strictEqual(run('if (empty($doc?store?bicycle)) then "yes" else ()'), undefined);
    });

    it('should construct maps and arrays', () => {
      assert.deepStrictEqual(run('map { "a": 1 + 1, "b": "$literal" }'), { a: 2, b: '$literal' });
      assert.deepStrictEqual(run('map { concat("a","b"): true() }'), { ab: true });
      assert.deepStrictEqual(run('[1, (2, 3), 4]'), [1, 2, 3, 4]); // member flattening
      assert.deepStrictEqual(run('array { 1 to 3 }'), [1, 2, 3]);
      assert.deepStrictEqual(run('map { "$for": 1 }'), { '$for': 1 });
    });

    it('should evaluate positional bindings 0-based (D6)', () => {
      assert.deepStrictEqual(run('for $x at $i in ("a","b","c") return $i'), [0, 1, 2]);
      assert.deepStrictEqual(run('for $x in ("a","b") count $c return $c'), [0, 1]);
    });

    it('should evaluate nested phrases from out-of-order clauses', () => {
      // let between for and its use: nesting preserves scope
      assert.deepStrictEqual(
        run('for $x in (1,2) let $y := $x * 10 return $y'),
        [10, 20]);
      // shadowing via nesting
      assert.deepStrictEqual(
        run('for $x in (1,2) let $x := $x + 10 return $x'),
        [11, 12]);
      // repeated where: both filters apply
      assert.deepStrictEqual(
        run('for $x in (1,2,3) where $x != 1 where $x != 3 return $x'),
        2);
      // count before where: numbering happens before filtering
      assert.deepStrictEqual(
        run('for $x in ("a","b","c") count $c where $x != "b" return $c'),
        [0, 2]);
      // order by then where: sort first, filter per tuple
      assert.deepStrictEqual(
        run('for $b in $doc?store?book?* order by $b?price where $b?price lt 10 return $b?title'),
        ['Sayings of the Century', 'Moby Dick']);
    });

    it('should evaluate the HAVING pattern (where after group by)', () => {
      assert.deepStrictEqual(
        run('for $b in $doc?store?book?* group by $g := $b?category where count($b) gt 1 return $g'),
        'fiction');
    });

    it('should evaluate order by modifiers', () => {
      assert.deepStrictEqual(
        run('for $b in $doc?store?book?* order by $b?price descending return $b?price'),
        [22.99, 12.99, 8.99, 8.95]);
      assert.deepStrictEqual(
        run('for $b in $doc?store?book?* order by $b?isbn empty greatest, $b?price return $b?price'),
        [22.99, 8.99, 8.95, 12.99]);
    });

    it('should keep XQuery quantifier semantics over empty sequences', () => {
      assert.strictEqual(run('some $x in () satisfies true()'), false);
      assert.strictEqual(run('every $x in () satisfies false()'), true);
      assert.strictEqual(run('some $x in (1,2), $x in (3,4) satisfies $x gt 3'), true);
    });

    it('should surface engine runtime errors from compiled text', () => {
      assert.throws(() => run('1 idiv 0'), (e) => {
        assert.strictEqual(e instanceof JsonQueryRuntimeError, true);
        assert.strictEqual(e.code, 'JQ2002');
        return true;
      });
      assert.throws(() => run('if ((1,2)) then 1 else 2'), (e) => {
        assert.strictEqual(e.code, 'JQ2003'); // EBV of a multi-item sequence
        return true;
      });
    });
  });
});
