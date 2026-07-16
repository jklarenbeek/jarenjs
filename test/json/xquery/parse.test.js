import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';

import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// The parser must never emit an invalid document: every emitted document
// is asserted against both query-format schema artifacts (the internal
// debug assertion required by the front-end contract).
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

// parses + deep-equals the expected document + schema-validates the emission
function parses(src, expected) {
  const doc = parseXQuery(src);
  assert.deepStrictEqual(doc, expected, `parse of ${JSON.stringify(src)}`);
  for (const [draft, validate] of validators) {
    assert.strictEqual(validate(doc), true,
      `emitted document must validate under ${draft}: ${JSON.stringify(doc)}`);
  }
  return doc;
}

// asserts an XQuerySyntaxError whose message contains `part`, at `position`
function failsWith(src, part, position) {
  assert.throws(() => parseXQuery(src), (e) => {
    assert.strictEqual(e instanceof XQuerySyntaxError, true,
      `expected XQuerySyntaxError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.name, 'XQuerySyntaxError');
    assert.strictEqual(e.source, typeof src === 'string' ? src : String(src));
    assert.ok(e.message.includes(part),
      `expected message to include ${JSON.stringify(part)}, got: ${e.message}`);
    if (position !== undefined)
      assert.strictEqual(e.position, position, `expected position ${position}, got ${e.position}: ${e.message}`);
    return true;
  });
}

describe('XQuery front-end parser', () => {

  describe('prolog', () => {
    it('should parse and ignore the version declaration', () => {
      parses('xquery version "3.1"; 42', 42);
      parses('xquery version "1.0" encoding "utf-8"; 1', 1);
      parses('xquery encoding "utf-8"; 1', 1);
    });

    it('should treat nestable comments as whitespace', () => {
      parses('(: a (: nested :) comment :) 7', 7);
      parses('1 (: mid :) + (: mid :) 2', { '$add': [1, 2] });
      parses('for (:c:) $x (:c:) in (:c:) (1) return (:c:) $x',
        { '$for': { x: 1 }, '$return': '$x' });
    });

    it('should accept external variable declarations as no-ops', () => {
      parses('declare variable $minPrice external; $minPrice', '$minPrice');
      parses('declare variable $a external; declare variable $b external; 1', 1);
      parses('xquery version "3.1"; declare variable $doc external; $doc?x', '$doc.x');
    });

    it('should reject defaulted variable declarations by name', () => {
      failsWith('declare variable $x := 5; 1', "unsupported construct 'variable declaration with default value'", 0);
      failsWith('declare variable $x external := 5; 1', "unsupported construct 'variable declaration with default value'", 0);
    });

    it('should reject duplicate and namespaced declarations', () => {
      failsWith('declare variable $x external; declare variable $x external; 1',
        "duplicate variable declaration '$x'", 48);
      failsWith('declare variable $fn:x external; 1', "unsupported construct 'namespaced variable'", 18);
    });

    it('should reject every other prolog declaration by name', () => {
      failsWith('declare function local:f() { 1 }; 1', "unsupported construct 'declare function'", 0);
      failsWith('declare namespace foo = "bar"; 1', "unsupported construct 'declare namespace'", 0);
      failsWith('declare default element namespace "u"; 1', "unsupported construct 'declare default'", 0);
      failsWith('declare option foo:bar "baz"; 1', "unsupported construct 'declare option'", 0);
      failsWith('declare boundary-space preserve; 1', "unsupported construct 'declare boundary-space'", 0);
      failsWith('import module namespace m = "u"; 1', "unsupported construct 'import module'", 0);
      failsWith('import schema namespace s = "u"; 1', "unsupported construct 'import schema'", 0);
      failsWith('module namespace m = "u"; 1', "unsupported construct 'library module'", 0);
    });
  });

  describe('literals', () => {
    it('should parse string literals with both quotes and doubled-quote escapes', () => {
      parses('"hello"', 'hello');
      parses("'hello'", 'hello');
      parses("'it''s'", "it's");
      parses('"he said ""hi"""', 'he said "hi"');
      parses("''", '');
    });

    it('should $$-escape literal strings starting with $', () => {
      parses('"$price"', '$$price');
      parses('"$$x"', '$$$x');
      parses("'$'", '$$');
    });

    it('should parse the XQuery number grammar into JSON numbers', () => {
      parses('7', 7);
      parses('007', 7); // leading zeros are legal in XQuery
      parses('.5', 0.5);
      parses('1.', 1);
      parses('1.5e2', 150);
      parses('.5e-1', 0.05);
      parses('1.E3', 1000);
    });

    it('should fold unary minus into number literals', () => {
      parses('-5', -5);
      parses('--5', 5);
      parses('-+5', -5);
      parses('- $x', { '$neg': '$x' });
      parses('- -$x', { '$neg': { '$neg': '$x' } });
      parses('+"a"', 'a'); // unary plus is a no-op in this mapping
    });

    it('should map true()/false() to the boolean literals', () => {
      parses('true()', true);
      parses('false()', false);
      parses('fn:true()', true);
    });

    it('should reject numeric literals without a following delimiter', () => {
      failsWith('10div 3', 'numeric literal must be followed by a delimiter', 2);
      failsWith('1.5.3', 'numeric literal must be followed by a delimiter', 3);
    });

    it('should reject non-finite number literals by name', () => {
      failsWith('1e400', "unsupported construct 'non-finite number literal'", 0);
    });

    it('should reject character references in string literals by name', () => {
      failsWith('"a&amp;b"', "unsupported construct 'character reference'", 2);
    });
  });

  describe('sequences', () => {
    it('should map the comma and parentheses onto $seq', () => {
      parses('()', { '$seq': [] });
      parses('(1)', 1);
      parses('(1, 2, 3)', { '$seq': [1, 2, 3] });
      parses('1, 2', { '$seq': [1, 2] });
      parses('((1,2),3)', { '$seq': [{ '$seq': [1, 2] }, 3] });
    });

    it('should allow a FLWOR inside a top-level sequence', () => {
      parses('for $x in (1,2) return $x,3',
        { '$seq': [{ '$for': { x: { '$seq': [1, 2] } }, '$return': '$x' }, 3] });
    });
  });

  describe('operators', () => {
    it('should map or/and variadically with precedence', () => {
      parses('$a and $b or $c', { '$or': [{ '$and': ['$a', '$b'] }, '$c'] });
      parses('$a or $b or $c', { '$or': ['$a', '$b', '$c'] });
      parses('$a and $b and $c', { '$and': ['$a', '$b', '$c'] });
    });

    it('should map general comparisons', () => {
      parses('1 = 2', { '$eq': [1, 2] });
      parses('1 != 2', { '$ne': [1, 2] });
      parses('1 < 2', { '$lt': [1, 2] });
      parses('1 <= 2', { '$le': [1, 2] });
      parses('1 > 2', { '$gt': [1, 2] });
      parses('1 >= 2', { '$ge': [1, 2] });
    });

    it('should map value comparisons onto the same operators', () => {
      parses('1 eq 2', { '$eq': [1, 2] });
      parses('1 ne 2', { '$ne': [1, 2] });
      parses('$a lt $b', { '$lt': ['$a', '$b'] });
      parses('$a le $b', { '$le': ['$a', '$b'] });
      parses('$a gt $b', { '$gt': ['$a', '$b'] });
      parses('$a ge $b', { '$ge': ['$a', '$b'] });
    });

    it('should map || onto variadic $concat', () => {
      parses('"a" || "b"', { '$concat': ['a', 'b'] });
      parses('"a" || "b" || "c"', { '$concat': ['a', 'b', 'c'] });
    });

    it('should map to onto $range below additive precedence', () => {
      parses('1 to 5', { '$range': [1, 5] });
      parses('2 + 3 to 10', { '$range': [{ '$add': [2, 3] }, 10] });
      parses('(1 to 3) = 3', { '$eq': [{ '$range': [1, 3] }, 3] });
    });

    it('should map arithmetic with XQuery precedence and associativity', () => {
      parses('1 + 2 * 3', { '$add': [1, { '$mul': [2, 3] }] });
      parses('1 - 2 - 3', { '$sub': [{ '$sub': [1, 2] }, 3] });
      parses('7 div 2', { '$div': [7, 2] });
      parses('7 idiv 2', { '$idiv': [7, 2] });
      parses('7 mod 2', { '$mod': [7, 2] });
      parses('-$x + 1', { '$add': [{ '$neg': '$x' }, 1] });
    });

    it('should parse the if expression and fold else ()', () => {
      parses('if ($x) then "y" else "n"', { '$if': ['$x', 'y', 'n'] });
      parses('if ($x) then "y" else ()', { '$if': ['$x', 'y'] });
      parses('if (1,2) then 3 else 4', { '$if': [{ '$seq': [1, 2] }, 3, 4] });
      parses('if ($a) then 1 else if ($b) then 2 else 3',
        { '$if': ['$a', 1, { '$if': ['$b', 2, 3] }] });
    });
  });

  describe('lookups and path folding', () => {
    it('should fold variable-rooted lookup chains into path strings', () => {
      parses('$b', '$b');
      parses('$ x', '$x'); // '$' is a delimiting terminal
      parses('$b?price', '$b.price');
      parses('$doc?store?book?*', '$doc.store.book[*]');
      parses('$a?*?b', '$a[*].b');
    });

    it('should subtract one from numeric lookups (1-based to 0-based)', () => {
      parses('$b?1', '$b[0]');
      parses('$b?price?1', '$b.price[0]');
      parses('$x ? 2', '$x[1]');
      parses('$doc?store?book?3?title', '$doc.store.book[2].title');
    });

    it('should bracket-quote names outside the dot shorthand', () => {
      parses('$b?odd-name', "$b['odd-name']");
      parses('$x?a.b', "$x['a.b']");
      parses('$x?prénom', "$x['prénom']");
    });

    it('should map lookups on non-variable bases onto $get', () => {
      parses('head($xs)?name', { '$get': [{ '$head': '$xs' }, 'name'] });
      parses('head($xs)?2', { '$get': [{ '$head': '$xs' }, 1] });
      parses('map{"a":1}?a', { '$get': [{ a: 1 }, 'a'] });
      parses('[10,20]?1?x', { '$get': [{ '$get': [[10, 20], 0] }, 'x'] });
    });

    it('should reject the lookup forms outside the subset by name', () => {
      failsWith('$x?0', 'unsupported lookup index 0', 3);
      failsWith('$x?(1)', "unsupported construct 'parenthesized lookup key'", 3);
      failsWith('head($xs)?*', "unsupported construct 'wildcard lookup on a non-variable expression'", 9);
      failsWith('?name', "unsupported construct 'unary lookup'", 0);
      failsWith('$x?1.5', 'expected an integer lookup key', 3);
    });

    it('should reject unsupported variable lexemes by name', () => {
      failsWith('$foo-bar', "unsupported variable name 'foo-bar'", 1);
      failsWith('$a.b', "unsupported variable name 'a.b'", 1);
      failsWith('$ns:x', "unsupported construct 'namespaced variable'", 1);
    });
  });

  describe('function calls', () => {
    it('should map the aggregate and sequence-test functions', () => {
      parses('count($xs)', { '$count': '$xs' });
      parses('fn:count($xs)', { '$count': '$xs' });
      parses('sum($xs)', { '$sum': '$xs' });
      parses('avg($xs)', { '$avg': '$xs' });
      parses('min($xs)', { '$min': '$xs' });
      parses('max($xs)', { '$max': '$xs' });
      parses('exists($x)', { '$exists': '$x' });
      parses('empty($x)', { '$empty': '$x' });
    });

    it('should map the string functions', () => {
      parses('concat("a","b","c")', { '$concat': ['a', 'b', 'c'] });
      parses('string-join($xs)', { '$string-join': ['$xs'] });
      parses('string-join($xs, ", ")', { '$string-join': ['$xs', ', '] });
      parses('contains("ab", "a")', { '$contains': ['ab', 'a'] });
      parses('starts-with("ab", "a")', { '$starts-with': ['ab', 'a'] });
      parses('ends-with("ab", "b")', { '$ends-with': ['ab', 'b'] });
      parses('upper-case("a")', { '$upper': 'a' });
      parses('lower-case("A")', { '$lower': 'A' });
      parses('string-length("abc")', { '$string-length': 'abc' });
      parses('normalize-space(" a  b ")', { '$normalize-space': ' a  b ' });
      parses('replace("abc","b","x")', { '$replace': ['abc', 'b', 'x'] });
    });

    it('should map fn:matches onto $search (substring semantics)', () => {
      parses('matches("abc", "b")', { '$search': ['abc', 'b'] });
      parses('fn:matches($s, $p)', { '$search': ['$s', '$p'] });
    });

    it('should adjust the 1-based substring/subsequence starts', () => {
      parses('substring("hello", 2)', { '$substring': ['hello', 1] });
      parses('substring("hello", 2, 3)', { '$substring': ['hello', 1, 3] });
      parses('substring($s, $i)', { '$substring': ['$s', { '$sub': ['$i', 1] }] });
      parses('substring($s, $i, $n)', { '$substring': ['$s', { '$sub': ['$i', 1] }, '$n'] });
      parses('subsequence($xs, 2)', { '$subsequence': ['$xs', 1] });
      parses('subsequence($xs, 2, 2)', { '$subsequence': ['$xs', 1, 2] });
    });

    it('should map map:get unadjusted and array:get 1-based to 0-based', () => {
      parses('map:get($m, "k")', { '$get': ['$m', 'k'] });
      parses('map:get($m, 1)', { '$get': ['$m', 1] });
      parses('array:get($a, 1)', { '$get': ['$a', 0] });
      parses('array:get($a, $i)', { '$get': ['$a', { '$sub': ['$i', 1] }] });
    });

    it('should map the remaining sequence and cast functions', () => {
      parses('distinct-values($xs)', { '$distinct': '$xs' });
      parses('reverse($xs)', { '$reverse': '$xs' });
      parses('head($xs)', { '$head': '$xs' });
      parses('tail($xs)', { '$tail': '$xs' });
      parses('index-of($xs, 3)', { '$index-of': ['$xs', 3] });
      parses('not($x)', { '$not': '$x' });
      parses('boolean($x)', { '$boolean': '$x' });
      parses('string($x)', { '$string': '$x' });
      parses('number($x)', { '$number': '$x' });
    });

    it('should reject unknown functions with the greppable message', () => {
      failsWith('unknown-fn(1)', "unsupported function 'unknown-fn'", 0);
      failsWith('fn:xyz(1)', "unsupported function 'fn:xyz'", 0);
      failsWith('xs:date("2020-01-01")', "unsupported function 'xs:date'", 0);
      failsWith('math:pi()', "unsupported function 'math:pi'", 0);
      failsWith('map:put($m, "k", 1)', "unsupported function 'map:put'", 0);
    });

    it('should reject unsupported arities as name#arity', () => {
      failsWith('sum($x, 0)', "unsupported function 'sum#2'", 0);
      failsWith('string()', "unsupported function 'string#0'", 0);
      failsWith('concat("a")', "unsupported function 'concat#1'", 0);
      failsWith('matches($s, $p, "i")', "unsupported function 'matches#3'", 0);
      failsWith('fn:replace($s, $p, $r, "i")', "unsupported function 'fn:replace#4'", 0);
      failsWith('true(1)', "unsupported function 'true#1'", 0);
    });
  });

  describe('constructors', () => {
    it('should emit a plain map constructor for literal non-$ keys', () => {
      parses('map {}', {});
      parses('map { "a": 1, "b": $x }', { a: 1, b: '$x' });
      parses("map { 'k': 1 + 2 }", { k: { '$add': [1, 2] } });
    });

    it('should switch to $map for computed or $-leading literal keys', () => {
      parses('map { "$for": 1 }', { '$map': [['$$for', 1]] });
      parses('map { $k: 1, "b": 2 }', { '$map': [['$k', 1], ['b', 2]] });
      parses('map { concat("a","b"): 1 }', { '$map': [[{ '$concat': ['a', 'b'] }, 1]] });
    });

    it('should keep __proto__ an ordinary member everywhere', () => {
      const viaMap = parses('map { "__proto__": 1 }', JSON.parse('{"__proto__": 1}'));
      assert.strictEqual(Object.hasOwn(viaMap, '__proto__'), true);
      assert.strictEqual(Object.getPrototypeOf(viaMap), Object.prototype);
      const viaFor = parseXQuery('for $__proto__ in (1,2) return $__proto__');
      assert.strictEqual(Object.hasOwn(viaFor.$for, '__proto__'), true);
    });

    it('should reject statically non-string and duplicate map keys', () => {
      failsWith('map { 1: "a" }', "unsupported construct 'non-string map key'", 6);
      failsWith('map { true(): 1 }', "unsupported construct 'non-string map key'", 6);
      failsWith('map { "a": 1, "a": 2 }', "duplicate map key 'a'", 14);
      failsWith('map { "$x": 1, "$x": 2 }', "duplicate map key '$x'", 15);
    });

    it('should emit array constructors for both constructor forms', () => {
      parses('[]', []);
      parses('[1, 2]', [1, 2]);
      parses('[[1,2],[3]]', [[1, 2], [3]]);
      parses('array {}', []);
      parses('array { 1, 2 }', [1, 2]);
      // the enclosed sequence flattens - same behavior in both languages
      parses('array { (1, 2), 3 }', [{ '$seq': [1, 2] }, 3]);
    });
  });

  describe('FLWOR', () => {
    it('should emit a single phrase for clauses in fixed order', () => {
      parses('for $x in (1,2) return $x * 2',
        { '$for': { x: { '$seq': [1, 2] } }, '$return': { '$mul': ['$x', 2] } });
      parses('let $x := 1 return $x',
        { '$let': { x: 1 }, '$return': '$x' });
      parses('for $x in $xs?* let $y := $x?p where $y gt 1 return $y',
        { '$for': { x: '$xs[*]' }, '$let': { y: '$x.p' }, '$where': { '$gt': ['$y', 1] }, '$return': '$y' });
    });

    it('should merge comma bindings and consecutive same-kind clauses', () => {
      const expected = { '$for': { x: 1, y: 2 }, '$return': ['$x', '$y'] };
      parses('for $x in 1, $y in 2 return [$x, $y]', expected);
      parses('for $x in 1 for $y in 2 return [$x, $y]', expected);
      parses('let $a := 1 let $b := 2 return [$a, $b]',
        { '$let': { a: 1, b: 2 }, '$return': ['$a', '$b'] });
    });

    it('should map the positional at binding (0-based, D6)', () => {
      parses('for $x at $i in $xs?* return $i',
        { '$for': { x: { '$in': '$xs[*]', '$at': 'i' } }, '$return': '$i' });
    });

    it('should map count clauses (0-based, D6)', () => {
      parses('for $x in (1,2,3) count $c return $c',
        { '$for': { x: { '$seq': [1, 2, 3] } }, '$count': 'c', '$return': '$c' });
      parses('let $x := (1,2,3) count $c return $c',
        { '$let': { x: { '$seq': [1, 2, 3] } }, '$count': 'c', '$return': '$c' });
    });

    it('should map group by with fresh grouping variables', () => {
      parses('for $b in $books?* group by $g := $b?category return $g',
        { '$for': { b: '$books[*]' }, '$groupby': { g: '$b.category' }, '$return': '$g' });
      parses('for $b in $bs?* group by $g := $b?c, $h := $b?d return [$g, $h]',
        { '$for': { b: '$bs[*]' }, '$groupby': { g: '$b.c', h: '$b.d' }, '$return': ['$g', '$h'] });
    });

    it('should map order by specs with minimal explicit forms', () => {
      parses('for $b in $bs?* order by $b?p return $b',
        { '$for': { b: '$bs[*]' }, '$orderby': '$b.p', '$return': '$b' });
      parses('for $b in $bs?* stable order by $b?p ascending return $b',
        { '$for': { b: '$bs[*]' }, '$orderby': '$b.p', '$return': '$b' });
      parses('for $b in $bs?* order by $b?p descending empty greatest, $b?t return $b',
        { '$for': { b: '$bs[*]' },
          '$orderby': [{ '$key': '$b.p', '$dir': 'desc', '$empty': 'greatest' }, '$b.t'],
          '$return': '$b' });
      parses('for $b in $bs?* order by $b?p empty greatest return $b',
        { '$for': { b: '$bs[*]' }, '$orderby': { '$key': '$b.p', '$empty': 'greatest' }, '$return': '$b' });
      // an array-constructor key always takes the explicit form
      parses('for $x in (1,2) order by [1] return $x',
        { '$for': { x: { '$seq': [1, 2] } }, '$orderby': { '$key': [1] }, '$return': '$x' });
    });

    it('should nest phrases for out-of-order per-tuple clauses', () => {
      parses('let $x := 1 for $y in $x to 3 return $y',
        { '$let': { x: 1 },
          '$return': { '$for': { y: { '$range': ['$x', 3] } }, '$return': '$y' } });
      parses('for $x in (1,2) where $x = 1 for $y in (3,4) return $y',
        { '$for': { x: { '$seq': [1, 2] } },
          '$where': { '$eq': ['$x', 1] },
          '$return': { '$for': { y: { '$seq': [3, 4] } }, '$return': '$y' } });
    });

    it('should nest a bare where remainder as $if', () => {
      parses('for $x in (1,2) where $x = 1 where $x = 2 return $x',
        { '$for': { x: { '$seq': [1, 2] } },
          '$where': { '$eq': ['$x', 1] },
          '$return': { '$if': [{ '$eq': ['$x', 2] }, '$x'] } });
      // where after order by: sort first, then filter per tuple
      parses('for $x in $xs?* order by $x where $x gt 1 return $x',
        { '$for': { x: '$xs[*]' }, '$orderby': '$x',
          '$return': { '$if': [{ '$gt': ['$x', 1] }, '$x'] } });
      // where after group by: the HAVING pattern
      parses('for $x in $xs?* group by $k := $x?c where count($x) gt 1 return $k',
        { '$for': { x: '$xs[*]' }, '$groupby': { k: '$x.c' },
          '$return': { '$if': [{ '$gt': [{ '$count': '$x' }, 1] }, '$k'] } });
      // count then where: number all tuples, then filter per tuple
      parses('for $x in (1,2) count $c where $c = 0 return $x',
        { '$for': { x: { '$seq': [1, 2] } }, '$count': 'c',
          '$return': { '$if': [{ '$eq': ['$c', 0] }, '$x'] } });
    });

    it('should nest on name reuse (XQuery shadowing)', () => {
      parses('for $x in (1,2) for $x in (3,4) return $x',
        { '$for': { x: { '$seq': [1, 2] } },
          '$return': { '$for': { x: { '$seq': [3, 4] } }, '$return': '$x' } });
      parses('for $x in (1,2) let $x := $x + 1 return $x',
        { '$for': { x: { '$seq': [1, 2] } },
          '$return': { '$let': { x: { '$add': ['$x', 1] } }, '$return': '$x' } });
    });

    it('should reject whole-stream clauses that cannot nest', () => {
      const src1 = 'for $x in $y order by $x group by $k := $x return $k';
      failsWith(src1, "unsupported clause order: 'group by' after 'order by'", src1.indexOf('group'));
      const src2 = 'for $x in $y order by $x for $z in $w order by $z return $z';
      failsWith(src2, "unsupported clause order: 'order by' after 'for'", src2.indexOf('order', 25));
      const src3 = 'for $x in $y count $c count $d return $c';
      failsWith(src3, "unsupported clause order: 'count' after 'count'", src3.indexOf('count', 19));
      const src4 = 'for $x in (1,2) order by $x count $c where true() order by $x return $x';
      failsWith(src4, "unsupported clause order: 'order by' after 'where'", src4.indexOf('order', 30));
    });

    it('should reject grouping-variable rebinding and bare group by', () => {
      const src = 'for $x in $y group by $x := $x?k return $x';
      failsWith(src, "unsupported construct 'group by' rebinding variable '$x'", src.indexOf('$x', 20));
      failsWith('for $x in $y group by $k return $k', "unsupported construct 'group by' binding without ':='", 22);
      failsWith('for $x in $y group by $k := $x?a, $k := $x?b return $k', "duplicate variable '$k'", 34);
    });

    it('should reject the FLWOR constructs outside the subset by name', () => {
      failsWith('for sliding window $w in $x return $w', "unsupported construct 'window clause'", 0);
      failsWith('for $x allowing empty in $y return $x', "unsupported construct 'allowing empty'", 7);
      failsWith('for $x as xs:integer in $y return $x', "unsupported construct 'type declaration'", 7);
      failsWith('let $x as xs:integer := 1 return $x', "unsupported construct 'type declaration'", 7);
      failsWith('for $b in $bs?* order by $b?p collation "u" return $b', "unsupported construct 'collation'", 30);
      failsWith('for $x at $x in $y return $x', "duplicate variable '$x'", 11);
      failsWith('for $x in (1) count $x return $x', "unsupported construct 'count' rebinding variable '$x'", 14);
    });
  });

  describe('quantifiers', () => {
    it('should map some/every with merged bindings', () => {
      parses('some $x in (1,2) satisfies $x gt 1',
        { '$some': { x: { '$seq': [1, 2] } }, '$satisfies': { '$gt': ['$x', 1] } });
      parses('every $x in $xs?*, $y in $x?list?* satisfies $y gt 0',
        { '$every': { x: '$xs[*]', y: '$x.list[*]' }, '$satisfies': { '$gt': ['$y', 0] } });
    });

    it('should nest quantifiers on name reuse', () => {
      parses('some $x in (1,2), $x in (3,4) satisfies $x gt 3',
        { '$some': { x: { '$seq': [1, 2] } },
          '$satisfies': { '$some': { x: { '$seq': [3, 4] } }, '$satisfies': { '$gt': ['$x', 3] } } });
    });

    it('should reject type declarations in quantifier bindings', () => {
      failsWith('some $x as xs:integer in (1) satisfies $x', "unsupported construct 'type declaration'", 8);
    });
  });

  describe('unsupported constructs', () => {
    it('should reject the type operators by name', () => {
      failsWith('1 instance of xs:integer', "unsupported construct 'instance of'", 2);
      failsWith('$x treat as item()', "unsupported construct 'treat as'", 3);
      failsWith('$x castable as xs:int', "unsupported construct 'castable as'", 3);
      failsWith('$x cast as xs:int', "unsupported construct 'cast as'", 3);
    });

    it('should reject the set operators by name', () => {
      failsWith('$a union $b', "unsupported construct 'union expression'", 3);
      failsWith('$a | $b', "unsupported construct 'union expression'", 3);
      failsWith('$a intersect $b', "unsupported construct 'intersect expression'", 3);
      failsWith('$a except $b', "unsupported construct 'except expression'", 3);
    });

    it('should reject node comparisons by name', () => {
      failsWith('$a is $b', "unsupported construct 'node comparison'", 3);
      failsWith('$a << $b', "unsupported construct 'node comparison'", 3);
      failsWith('$a >> $b', "unsupported construct 'node comparison'", 3);
    });

    it('should reject arrow, simple map, and function items by name', () => {
      failsWith('$x => upper-case()', "unsupported construct 'arrow expression'", 3);
      failsWith('$x ! name', "unsupported construct 'simple map operator'", 3);
      failsWith('$f(1)', "unsupported construct 'dynamic function call'", 2);
      failsWith('fn:count#1', "unsupported construct 'named function reference'", 0);
      failsWith('function ($x) { $x }', "unsupported construct 'inline function expression'", 0);
      failsWith('substring(?, 1)', "unsupported construct 'argument placeholder'", 10);
    });

    it('should reject predicates and path expressions by name', () => {
      failsWith('$books[1]', "unsupported construct 'predicate'", 6);
      failsWith('/store/book', "unsupported construct 'path expression'", 0);
      failsWith('//book', "unsupported construct 'path expression'", 0);
      failsWith('book', "unsupported construct 'path expression'", 0);
      failsWith('book/title', "unsupported construct 'path expression'", 0);
      failsWith('$b/title', "unsupported construct 'path expression'", 2);
      failsWith('@attr', "unsupported construct 'path expression'", 0);
      failsWith('*', "unsupported construct 'path expression'", 0);
      failsWith('..', "unsupported construct 'path expression'", 0);
      failsWith('child::book', "unsupported construct 'path expression'", 0);
    });

    it('should reject the context item by name', () => {
      failsWith('.', "unsupported construct 'context item expression'", 0);
      failsWith('not(.)', "unsupported construct 'context item expression'", 4);
    });

    it('should reject constructors and block expressions by name', () => {
      failsWith('<a/>', "unsupported construct 'node constructor'", 0);
      failsWith('element {} {}', "unsupported construct 'computed node constructor'", 0);
      failsWith('text { "x" }', "unsupported construct 'computed node constructor'", 0);
      failsWith('ordered { 1 }', "unsupported construct 'ordered expression'", 0);
      failsWith('unordered { 1 }', "unsupported construct 'unordered expression'", 0);
      failsWith('validate { $x }', "unsupported construct 'validate expression'", 0);
      failsWith('try { 1 } catch * { 2 }', "unsupported construct 'try/catch expression'", 0);
      failsWith('switch ($x) case 1 return "a" default return "b"', "unsupported construct 'switch expression'", 0);
      failsWith('typeswitch ($x) case xs:integer return 1 default return 2', "unsupported construct 'typeswitch expression'", 0);
      failsWith('(# ext #) 1', "unsupported construct 'pragma'", 0);
      failsWith('for tumbling window $w in $x return $w', "unsupported construct 'window clause'", 0);
    });
  });

  describe('plain syntax errors', () => {
    it('should reject empty and malformed queries with positions', () => {
      failsWith('', 'empty query', 0);
      failsWith('   ', 'empty query', 0);
      failsWith('(: only a comment :)', 'empty query', 0);
      failsWith('(1, 2', "expected ')'", 5);
      failsWith('"abc', 'unterminated string literal', 0);
      failsWith('(: unterminated', 'unterminated comment', 0);
      failsWith('1 2', 'unexpected token', 2);
      failsWith('1 = 2 = 3', 'unexpected token', 6);
      failsWith('if ($x) then 1', "expected 'else'", 14);
      failsWith('let $x = 1 return $x', "expected ':='", 7);
      failsWith('for $x in (1) return $x,', 'expected an expression', 24);
    });

    it('should reject keywords in expression position', () => {
      failsWith('1 + for $x in (1) return $x', "unexpected keyword 'for'", 4);
      failsWith('group by $x', "unexpected keyword 'group'", 0);
    });

    it('should reject non-string input', () => {
      failsWith(42, 'query must be a string');
    });
  });
});
