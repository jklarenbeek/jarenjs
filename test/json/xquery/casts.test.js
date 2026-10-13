import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseXQuery, compileXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

// Every emitted document must validate against both query-format schema
// artifacts before it is compiled and run.
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

function validated(text) {
  const doc = parseXQuery(text);
  for (const [draft, validate] of validators) {
    assert.strictEqual(validate(doc), true,
      `emitted document must validate under ${draft}: ${JSON.stringify(doc)}`);
  }
  return doc;
}

// the result sequence of `text`, run with the externals; the array
// constructor around it makes an empty result [] and a singleton [item]
function values(text, externals = {}) {
  validated(text);
  return compileXQuery(`[${text}]`)(null, externals);
}

// the cast error: the engine's type error, raised when the query runs
function failsAtRun(text, externals = {}) {
  validated(text);
  assert.throws(() => compileXQuery(`[${text}]`)(null, externals), (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2001', e.message);
    return true;
  });
}

function failsWith(src, part, position) {
  assert.throws(() => parseXQuery(src), (e) => {
    assert.ok(e instanceof XQuerySyntaxError, `expected XQuerySyntaxError, got ${e.name}: ${e.message}`);
    assert.ok(e.message.includes(part), `expected message to include ${JSON.stringify(part)}, got: ${e.message}`);
    assert.strictEqual(e.position, position);
    return true;
  });
}

const NEG_ZERO = -0;

describe('XQuery front-end xs: constructors', () => {

  describe('literal operands fold at parse time', () => {
    it('should fold integers: truncated, signed, padded, trimmed', () => {
      assert.deepStrictEqual(validated('xs:integer("12")'), 12);
      assert.deepStrictEqual(validated('xs:integer(" +007 ")'), 7);
      assert.deepStrictEqual(validated('xs:integer("-5")'), -5);
      assert.deepStrictEqual(validated('xs:integer("-0")'), 0);
      assert.deepStrictEqual(validated('xs:integer(2.9)'), 2);
      assert.deepStrictEqual(validated('xs:integer(-2.9)'), -2);
      assert.deepStrictEqual(validated('xs:integer(-0.5)'), 0);
      assert.deepStrictEqual(validated('xs:integer(true())'), 1);
      assert.deepStrictEqual(validated('xs:integer(false())'), 0);
    });

    it('should fold decimals: a bare dot is a digit short, an exponent is not decimal', () => {
      assert.deepStrictEqual(validated('xs:decimal("5.")'), 5);
      assert.deepStrictEqual(validated('xs:decimal(".5")'), 0.5);
      assert.deepStrictEqual(validated('xs:decimal("-.5")'), -0.5);
      assert.deepStrictEqual(validated('xs:decimal("+1.50")'), 1.5);
      assert.deepStrictEqual(validated('xs:decimal("-0.0")'), 0);
      assert.deepStrictEqual(validated('xs:decimal(1.5)'), 1.5);
    });

    it('should fold doubles, the non-finite spellings included', () => {
      assert.deepStrictEqual(validated('xs:double("1e3")'), 1000);
      assert.deepStrictEqual(validated('xs:double(".5e1")'), 5);
      assert.deepStrictEqual(validated('xs:double("5.E3")'), 5000);
      assert.deepStrictEqual(validated('xs:double(" 1.5 ")'), 1.5);
      assert.deepStrictEqual(validated('xs:double("-0")'), NEG_ZERO);
      assert.deepStrictEqual(validated('xs:double("1e999")'), { '$div': [1, 0] });
      assert.deepStrictEqual(validated('xs:double("-1e999")'), { '$div': [-1, 0] });
      assert.deepStrictEqual(validated('xs:double("INF")'), { '$div': [1, 0] });
      assert.deepStrictEqual(validated('xs:double("+INF")'), { '$div': [1, 0] });
      assert.deepStrictEqual(validated('xs:double("-INF")'), { '$div': [-1, 0] });
      assert.deepStrictEqual(validated('xs:double("NaN")'), { '$div': [0, 0] });
      assert.deepStrictEqual(validated('xs:double(7)'), 7);
    });

    it('should treat xs:float as xs:double: the engine has no single precision', () => {
      assert.deepStrictEqual(validated('xs:float("0.1")'), 0.1);
      assert.deepStrictEqual(validated('xs:float("-INF")'), { '$div': [-1, 0] });
      assert.deepStrictEqual(validated('xs:float("-9.9999999E99")'), -9.9999999e99);
      assert.deepStrictEqual(values('xs:float("0.1") = xs:double("0.1")'), [true]);
    });

    it('should fold booleans: true, false, 1 and 0, trimmed', () => {
      assert.deepStrictEqual(validated('xs:boolean("true")'), true);
      assert.deepStrictEqual(validated('xs:boolean(" 1\n")'), true);
      assert.deepStrictEqual(validated('xs:boolean("false")'), false);
      assert.deepStrictEqual(validated('xs:boolean("0")'), false);
      assert.deepStrictEqual(validated('xs:boolean(0)'), false);
      assert.deepStrictEqual(validated('xs:boolean(2.5)'), true);
      assert.deepStrictEqual(validated('xs:boolean(true())'), true);
    });

    it('should emit a literal outside the lexical space as a cast that fails when run', () => {
      assert.deepStrictEqual(validated('xs:integer("1.5")'), { '$number': 'xs:integer: 1.5' });
      assert.deepStrictEqual(validated('xs:decimal("1e3")'), { '$number': 'xs:decimal: 1e3' });
      assert.deepStrictEqual(validated('xs:double("inf")'), { '$number': 'xs:double: inf' });
      assert.deepStrictEqual(validated('xs:float("")'), { '$number': 'xs:float: ' });
      assert.deepStrictEqual(validated('xs:boolean("yes")'), { '$number': 'xs:boolean: yes' });
      // beyond the double range an integer or a decimal has no value at all
      const huge = '1' + '0'.repeat(400);
      assert.deepStrictEqual(validated(`xs:integer("${huge}")`), { '$number': `xs:integer: ${huge}` });
      assert.deepStrictEqual(validated(`xs:decimal("-${huge}")`), { '$number': `xs:decimal: -${huge}` });
    });

    it('should fail a bad literal when the cast runs, never when the query is read', () => {
      assert.deepStrictEqual(values('if (false()) then xs:integer("x") else 1'), [1]);
      failsAtRun('xs:integer("x")');
      failsAtRun('xs:double("1.2.3")');
      failsAtRun('xs:decimal("INF")');
      failsAtRun('xs:integer("1" || "e3")');
    });

    it('should not read a variable-looking literal as a reference', () => {
      assert.deepStrictEqual(validated('xs:integer("$x")'), { '$number': 'xs:integer: $x' });
      failsAtRun('xs:integer("$x")');
    });

    it('should map xs:string onto $string', () => {
      assert.deepStrictEqual(validated('xs:string($x)'), { '$string': '$x' });
      assert.deepStrictEqual(values('xs:string(1.5)'), ['1.5']);
      assert.deepStrictEqual(values('xs:string(true())'), ['true']);
      assert.deepStrictEqual(values('xs:string(())'), []);
    });
  });

  describe('a variable operand is read when the query runs', () => {
    const shape = validated('xs:integer($v)');

    it('should bind the operand once, outside the cast, in one phrase', () => {
      assert.deepStrictEqual(Object.keys(shape), ['$let', '$return']);
      assert.deepStrictEqual(shape.$let, { xs_arg: '$v' });
    });

    const asInteger = (s) => values('xs:integer($s)', { s });
    const asDecimal = (s) => values('xs:decimal($s)', { s });
    const asDouble = (s) => values('xs:double($s)', { s });
    const asBoolean = (s) => values('xs:boolean($s)', { s });

    it('should read integer text: sign, zeros and padding allowed, nothing else', () => {
      assert.deepStrictEqual(asInteger('12'), [12]);
      assert.deepStrictEqual(asInteger(' +007 '), [7]);
      assert.deepStrictEqual(asInteger('-0'), [0]);
      assert.deepStrictEqual(asInteger('00'), [0]);
      assert.deepStrictEqual(asInteger('-12'), [-12]);
      for (const bad of ['1.5', '1e3', '', ' ', 'abc', '+', '-', '1 2', '0x10', '--1', 'NaN', 'INF'])
        failsAtRun('xs:integer($s)', { s: bad });
    });

    it('should read decimal text: a dot, no exponent, no INF', () => {
      assert.deepStrictEqual(asDecimal('5.'), [5]);
      assert.deepStrictEqual(asDecimal('.5'), [0.5]);
      assert.deepStrictEqual(asDecimal('-.5'), [-0.5]);
      assert.deepStrictEqual(asDecimal('+1.50'), [1.5]);
      assert.deepStrictEqual(asDecimal('007'), [7]);
      assert.deepStrictEqual(asDecimal('0.0'), [0]);
      assert.deepStrictEqual(asDecimal('-0.0'), [0]);
      assert.deepStrictEqual(asDecimal(' 2.25 '), [2.25]);
      for (const bad of ['1e3', '.', '', 'INF', 'NaN', '1.2.3', '1,5'])
        failsAtRun('xs:decimal($s)', { s: bad });
    });

    it('should read double text: exponents, bare dots, INF and NaN', () => {
      assert.deepStrictEqual(asDouble('1e3'), [1000]);
      assert.deepStrictEqual(asDouble('.5e1'), [5]);
      assert.deepStrictEqual(asDouble('5.e3'), [5000]);
      assert.deepStrictEqual(asDouble('5.E3'), [5000]);
      assert.deepStrictEqual(asDouble('00.5e-001'), [0.05]);
      assert.deepStrictEqual(asDouble('0e0'), [0]);
      assert.deepStrictEqual(asDouble('-0'), [NEG_ZERO]);
      assert.deepStrictEqual(asDouble('  1.5\t'), [1.5]);
      assert.deepStrictEqual(asDouble('INF'), [Infinity]);
      assert.deepStrictEqual(asDouble('+INF'), [Infinity]);
      assert.deepStrictEqual(asDouble('-INF'), [-Infinity]);
      assert.deepStrictEqual(asDouble('NaN'), [NaN]);
      assert.deepStrictEqual(asDouble('1e999'), [Infinity]);
      for (const bad of ['1e', '1e+', 'inf', 'nan', '+NaN', 'Infinity', '0x10', '1_0', '+-1', '1.2.3', '1 2', '', '.', 'e5'])
        failsAtRun('xs:double($s)', { s: bad });
    });

    it('should read boolean text: true, false, 1 and 0 after trimming, nothing else', () => {
      assert.deepStrictEqual(asBoolean('true'), [true]);
      assert.deepStrictEqual(asBoolean(' 1\n'), [true]);
      assert.deepStrictEqual(asBoolean('false'), [false]);
      assert.deepStrictEqual(asBoolean('\t0 '), [false]);
      for (const bad of ['TRUE', 'True', 'yes', '12', '', '01', 'false true'])
        failsAtRun('xs:boolean($s)', { s: bad });
    });

    it('should convert numbers: integers truncate, decimals refuse the non-finite', () => {
      assert.deepStrictEqual(asInteger(2.9), [2]);
      assert.deepStrictEqual(asInteger(-2.9), [-2]);
      assert.deepStrictEqual(asInteger(-0.5), [0]);
      assert.deepStrictEqual(asInteger(1e21), [1e21]);
      assert.deepStrictEqual(asDecimal(2.9), [2.9]);
      assert.deepStrictEqual(asDecimal(NEG_ZERO), [0]);
      assert.deepStrictEqual(asDouble(2.9), [2.9]);
      assert.deepStrictEqual(asDouble(NEG_ZERO), [NEG_ZERO]);
      assert.deepStrictEqual(asDouble(NaN), [NaN]);
      assert.deepStrictEqual(asDouble(-Infinity), [-Infinity]);
      for (const bad of [NaN, Infinity, -Infinity]) {
        failsAtRun('xs:integer($s)', { s: bad });
        failsAtRun('xs:decimal($s)', { s: bad });
      }
    });

    it('should convert booleans to 1 and 0, and numbers to their truth for xs:boolean', () => {
      for (const [b, n] of [[true, 1], [false, 0]]) {
        assert.deepStrictEqual(asInteger(b), [n]);
        assert.deepStrictEqual(asDecimal(b), [n]);
        assert.deepStrictEqual(asDouble(b), [n]);
        assert.deepStrictEqual(asBoolean(b), [b]);
      }
      assert.deepStrictEqual(asBoolean(0), [false]);
      assert.deepStrictEqual(asBoolean(NEG_ZERO), [false]);
      assert.deepStrictEqual(asBoolean(NaN), [false]);
      assert.deepStrictEqual(asBoolean(1.5), [true]);
      assert.deepStrictEqual(asBoolean(-3), [true]);
    });

    it('should keep the empty sequence empty and refuse what is not atomic', () => {
      for (const cast of ['xs:integer', 'xs:decimal', 'xs:double', 'xs:float', 'xs:boolean', 'xs:string'])
        assert.deepStrictEqual(values(`${cast}(())`), [], cast);
      for (const cast of ['xs:integer', 'xs:decimal', 'xs:double', 'xs:float', 'xs:boolean']) {
        failsAtRun(`${cast}($s)`, { s: null });
        failsAtRun(`${cast}($s)`, { s: [1] });
        failsAtRun(`${cast}($s)`, { s: { a: 1 } });
        failsAtRun(`${cast}((1, 2))`);
      }
    });

    it('should name the cast and the text in the error', () => {
      assert.throws(() => compileXQuery('xs:integer($s)')(null, { s: '1.5' }), /xs:integer: 1\.5/);
      assert.throws(() => compileXQuery('xs:float($s)')(null, { s: 'abc' }), /xs:float: abc/);
      assert.throws(() => compileXQuery('xs:boolean($s)')(null, { s: 'maybe' }), /xs:boolean: maybe/);
    });

    it('should compose: casts of casts and of computed operands', () => {
      assert.deepStrictEqual(values('xs:integer(xs:double("1e3"))'), [1000]);
      assert.deepStrictEqual(values('xs:integer(xs:integer(xs:integer($s)))', { s: ' 3 ' }), [3]);
      assert.deepStrictEqual(values('xs:double(xs:string($s))', { s: 2.5 }), [2.5]);
      assert.deepStrictEqual(values('xs:integer($s) + xs:decimal("0.5")', { s: '12' }), [12.5]);
      assert.deepStrictEqual(values('xs:integer(string-join(("1", "2"), ""))'), [12]);
      assert.deepStrictEqual(values('for $x in ("1", "2.5") return xs:double($x) * 2'), [2, 5]);
      assert.deepStrictEqual(values('xs:boolean(xs:string(true()))'), [true]);
      const deep = 60;
      const text = 'xs:double('.repeat(deep) + '$s' + ')'.repeat(deep);
      assert.deepStrictEqual(values(text, { s: '0.25' }), [0.25]);
    });

    it('should not capture, or be captured by, the names a user chose', () => {
      assert.deepStrictEqual(values('let $xs_arg := " 5 " return xs:integer($xs_arg)'), [5]);
      assert.deepStrictEqual(values('for $xs_text in ("-INF") return xs:double($xs_text)'), [-Infinity]);
      assert.deepStrictEqual(values('let $xs_unsigned := "+4" return xs:decimal($xs_unsigned)'), [4]);
    });
  });

  describe('the other xs: types stay outside the subset', () => {
    it('should refuse a type the JSON model has no value for', () => {
      failsWith('xs:date("2020-01-01")', "unsupported function 'xs:date'", 0);
      failsWith('xs:dateTime($x)', "unsupported function 'xs:dateTime'", 0);
      failsWith('xs:long("1")', "unsupported function 'xs:long'", 0);
      failsWith('xs:untypedAtomic($x)', "unsupported function 'xs:untypedAtomic'", 0);
      failsWith('xs:anyURI("a")', "unsupported function 'xs:anyURI'", 0);
    });

    it('should refuse an arity the constructors do not have', () => {
      failsWith('xs:integer()', "unsupported function 'xs:integer#0'", 0);
      failsWith('xs:double(1, 2)', "unsupported function 'xs:double#2'", 0);
      failsWith('xs:string()', "unsupported function 'xs:string#0'", 0);
    });

    it('should keep the names of the constructors out of the bare and fn: namespaces', () => {
      failsWith('integer("1")', "unsupported function 'integer'", 0);
      failsWith('fn:double("1")', "unsupported function 'fn:double'", 0);
    });

    it('should keep the cast expressions unsupported', () => {
      failsWith('"1" cast as xs:integer', "unsupported construct 'cast as'", 4);
    });
  });
});

describe('XQuery front-end fn:tokenize', () => {
  const tokens = (s, pattern) => values(pattern === undefined ? 'tokenize($s)' : `tokenize($s, ${JSON.stringify(pattern)})`, { s });

  it('should split at a plain-text separator and keep the empty pieces', () => {
    assert.deepStrictEqual(tokens('a,b,,c', ','), ['a', 'b', '', 'c']);
    assert.deepStrictEqual(tokens(',a,', ','), ['', 'a', '']);
    assert.deepStrictEqual(tokens(',', ','), ['', '']);
    assert.deepStrictEqual(tokens(',,', ','), ['', '', '']);
    assert.deepStrictEqual(tokens('abc', ','), ['abc']);
    assert.deepStrictEqual(tokens('a, b, c', ', '), ['a', 'b', 'c']);
    assert.deepStrictEqual(tokens('a<>b-c<>', '<>'), ['a', 'b-c', '']);
    assert.deepStrictEqual(tokens('ab', 'abc'), ['ab']);
  });

  it('should count code points, not UTF-16 units', () => {
    assert.deepStrictEqual(tokens('\u{1F600}x\u{1F600}y', '\u{1F600}'), ['', 'x', 'y']);
    assert.deepStrictEqual(tokens('a\u{1F600}b', '\u{1F600}'), ['a', 'b']);
    assert.deepStrictEqual(tokens('é,é', ','), ['é', 'é']);
  });

  it('should give no tokens for the empty text', () => {
    assert.deepStrictEqual(tokens('', ','), []);
    assert.deepStrictEqual(values('tokenize((), ",")'), []);
    assert.deepStrictEqual(values('count(tokenize("", ","))'), [0]);
  });

  it('should split at runs of white space when there is no pattern', () => {
    assert.deepStrictEqual(tokens('  a  b\tc\n'), ['a', 'b', 'c']);
    assert.deepStrictEqual(tokens('abc'), ['abc']);
    assert.deepStrictEqual(tokens('   '), []);
    assert.deepStrictEqual(tokens(''), []);
    assert.deepStrictEqual(values('tokenize(())'), []);
  });

  it('should take a literal text as well as a variable', () => {
    assert.deepStrictEqual(values('tokenize("a;b", ";")'), ['a', 'b']);
    assert.deepStrictEqual(values('count(tokenize("a;b;c", ";"))'), [3]);
    assert.deepStrictEqual(values('string-join(tokenize("1 2 3"), "+")'), ['1+2+3']);
    assert.deepStrictEqual(values('for $t in tokenize("1,2", ",") return xs:integer($t) * 2'), [2, 4]);
  });

  it('should stay inside the engine sequence guards: the positions are a sequence', () => {
    const query = compileXQuery('tokenize($s, ",")', { limits: { sequenceItems: 20 } });
    assert.deepStrictEqual(query(null, { s: 'a,'.repeat(10) }), ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', '']);
    assert.throws(() => query(null, { s: 'a,'.repeat(20) }), (e) => {
      assert.ok(e instanceof JsonQueryRuntimeError, e.message);
      assert.strictEqual(e.code, 'JQ2009');
      return true;
    });
  });

  it('should refuse a non-string operand as a string parameter', () => {
    failsAtRun('tokenize($s, ",")', { s: 5 });
    failsAtRun('tokenize($s)', { s: true });
  });

  it('should not capture, or be captured by, the names a user chose', () => {
    assert.deepStrictEqual(values('let $tk_text := "a,b" return tokenize($tk_text, ",")'), ['a', 'b']);
    assert.deepStrictEqual(values('let $tk_cuts := "a b" return tokenize($tk_cuts)'), ['a', 'b']);
    assert.deepStrictEqual(values('for $tk_n in ("x,y") return tokenize($tk_n, ",")'), ['x', 'y']);
  });

  it('should refuse a pattern the document cannot split at', () => {
    const pattern = "unsupported construct 'tokenize pattern other than plain text'";
    failsWith('tokenize($s, "b|c")', pattern, 0);
    failsWith('tokenize($s, "\\s+")', pattern, 0);
    failsWith('tokenize($s, $p)', pattern, 0);
    failsWith('tokenize($s, "")', pattern, 0);
    failsWith('tokenize($s, "a" || "b")', pattern, 0);
    for (const c of ['.', '?', '*', '+', '(', ')', '{', '}', '[', ']', '^', '$', '|', '\\'])
      failsWith(`tokenize($s, "a${c === '\\' ? '\\\\' : c}")`, pattern, 0);
  });

  it('should refuse a separator that overlaps itself: the scan would need its left-to-right matches', () => {
    const overlap = "unsupported construct 'tokenize separator that overlaps itself'";
    failsWith('tokenize($s, "aa")', overlap, 0);
    failsWith('tokenize($s, "abab")', overlap, 0);
    failsWith('tokenize($s, "aba")', overlap, 0);
    failsWith('tokenize($s, "--")', overlap, 0);
    assert.deepStrictEqual(tokens('abcab', 'abc'), ['', 'ab']);
  });

  it('should refuse the flags argument and a missing input', () => {
    failsWith('tokenize($s, ",", "i")', "unsupported function 'tokenize#3'", 0);
    failsWith('tokenize()', "unsupported function 'tokenize#0'", 0);
    failsWith('fn:tokenize()', "unsupported function 'fn:tokenize#0'", 0);
  });
});
