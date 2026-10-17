import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery } from '@jarenjs/json/xquery';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

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
      assert.deepStrictEqual(validated('xs:integer("1.5")'), { '$error': ['err:FORG0001', 'xs:integer: 1.5'] });
      assert.deepStrictEqual(validated('xs:decimal("1e3")'), { '$error': ['err:FORG0001', 'xs:decimal: 1e3'] });
      assert.deepStrictEqual(validated('xs:double("inf")'), { '$error': ['err:FORG0001', 'xs:double: inf'] });
      assert.deepStrictEqual(validated('xs:float("")'), { '$error': ['err:FORG0001', 'xs:float: '] });
      assert.deepStrictEqual(validated('xs:boolean("yes")'), { '$error': ['err:FORG0001', 'xs:boolean: yes'] });
      // beyond the double range an integer or a decimal has no value at all
      const huge = '1' + '0'.repeat(400);
      assert.deepStrictEqual(validated(`xs:integer("${huge}")`), { '$error': ['err:FORG0001', `xs:integer: ${huge}`] });
      assert.deepStrictEqual(validated(`xs:decimal("-${huge}")`), { '$error': ['err:FORG0001', `xs:decimal: -${huge}`] });
    });

    it('should fail a bad literal when the cast runs, never when the query is read', () => {
      assert.deepStrictEqual(values('if (false()) then xs:integer("x") else 1'), [1]);
      failsAtRun('xs:integer("x")', {}, 'err:FORG0001');
      failsAtRun('xs:double("1.2.3")', {}, 'err:FORG0001');
      failsAtRun('xs:decimal("INF")', {}, 'err:FORG0001');
      failsAtRun('xs:integer("1" || "e3")', {}, 'err:FORG0001');
    });

    it('should not read a variable-looking literal as a reference', () => {
      assert.deepStrictEqual(validated('xs:integer("$x")'), { '$error': ['err:FORG0001', 'xs:integer: $x'] });
      failsAtRun('xs:integer("$x")', {}, 'err:FORG0001');
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
        failsAtRun('xs:integer($s)', { s: bad }, 'err:FORG0001');
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
        failsAtRun('xs:decimal($s)', { s: bad }, 'err:FORG0001');
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
        failsAtRun('xs:double($s)', { s: bad }, 'err:FORG0001');
    });

    it('should read boolean text: true, false, 1 and 0 after trimming, nothing else', () => {
      assert.deepStrictEqual(asBoolean('true'), [true]);
      assert.deepStrictEqual(asBoolean(' 1\n'), [true]);
      assert.deepStrictEqual(asBoolean('false'), [false]);
      assert.deepStrictEqual(asBoolean('\t0 '), [false]);
      for (const bad of ['TRUE', 'True', 'yes', '12', '', '01', 'false true'])
        failsAtRun('xs:boolean($s)', { s: bad }, 'err:FORG0001');
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
        failsAtRun('xs:integer($s)', { s: bad }, 'err:FOCA0002');
        failsAtRun('xs:decimal($s)', { s: bad }, 'err:FOCA0002');
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
        failsAtRun(`${cast}($s)`, { s: null }, 'err:XPTY0004');
        failsAtRun(`${cast}($s)`, { s: [1] }, 'err:XPTY0004');
        failsAtRun(`${cast}($s)`, { s: { a: 1 } }, 'err:XPTY0004');
        failsAtRun(`${cast}((1, 2))`, {}, 'err:XPTY0004');
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
      failsWith('xs:dayTimeDuration("P1D")', "unsupported function 'xs:dayTimeDuration'", 0);
      failsWith('xs:yearMonthDuration($x)', "unsupported function 'xs:yearMonthDuration'", 0);
      failsWith('xs:duration("P1Y")', "unsupported function 'xs:duration'", 0);
      failsWith('xs:gYear("2020")', "unsupported function 'xs:gYear'", 0);
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

    it('should refuse a cast to one of them by name', () => {
      failsWith('"1" cast as xs:duration', "unsupported construct 'cast as xs:duration'", 12);
      failsWith('"1" castable as xs:gYear?', "unsupported construct 'castable as xs:gYear'", 16);
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

  it('should emit the engine operator, the one-argument call over the normalized text', () => {
    assert.deepStrictEqual(validated('tokenize($s, ",")'), { '$tokenize': ['$s', ','] });
    assert.deepStrictEqual(validated('tokenize($s)'), { '$tokenize': [{ '$normalize-space': '$s' }, ' '] });
  });

  it('should split a text with more pieces than the sequence guards admit: no sequence of positions is built', () => {
    const query = compileXQuery('tokenize($s, ",")', { limits: { sequenceItems: 20 } });
    assert.strictEqual(query(null, { s: 'a,'.repeat(20) }).length, 21);
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

  it('should split at the matches of a regular expression, leftmost first', () => {
    assert.deepStrictEqual(tokens('abracadabra', '(ab)|(a)'), ['', 'r', 'c', 'd', 'r', '']);
    assert.deepStrictEqual(tokens('a1b22c', '[0-9]+'), ['a', 'b', 'c']);
    assert.deepStrictEqual(tokens('1, 15, 24, 50', ',[ ]*'), ['1', '15', '24', '50']);
    assert.deepStrictEqual(tokens('a.b|c', '[.|]'), ['a', 'b', 'c']);
    assert.deepStrictEqual(values('tokenize($s, $p)', { s: 'x-y-z', p: '-' }), ['x', 'y', 'z']);
  });

  it('should split at a separator that overlaps itself, left to right', () => {
    assert.deepStrictEqual(tokens('aaa', 'aa'), ['', 'a']);
    assert.deepStrictEqual(tokens('abababa', 'aba'), ['', 'b', '']);
    assert.deepStrictEqual(tokens('a--b---c', '--'), ['a', 'b', '-c']);
    assert.deepStrictEqual(tokens('abcab', 'abc'), ['', 'ab']);
  });

  it('should refuse a pattern that matches the zero-length string, or is no I-Regexp, when it runs', () => {
    failsAtRun('tokenize($s, "")', { s: 'ab' });
    failsAtRun('tokenize($s, "a*")', { s: 'ab' });
    failsAtRun('tokenize($s, ".?")', { s: 'abba' });
    failsAtRun('tokenize($s, "[")', { s: 'ab' });
    // XSD's multi-character escapes are not I-Regexp (D5)
    failsAtRun('tokenize($s, "\\s+")', { s: 'a b' });
    failsAtRun('tokenize($s, $p)', { s: 'ab', p: 'b*' });
  });

  it('should give the empty text no tokens whatever the pattern, as F&O does', () => {
    assert.deepStrictEqual(values('tokenize("", "[")'), []);
    assert.deepStrictEqual(values('tokenize((), "a*")'), []);
  });

  it('should refuse a pattern that is not one string, the empty sequence included', () => {
    failsAtRun('tokenize("a", ())');
    failsAtRun('tokenize("a", $p)', { p: 1 });
  });

  it('should read the flags as the query is read: none, and q for plain text', () => {
    assert.deepStrictEqual(validated('tokenize($s, ",", "")'), { '$tokenize': ['$s', ','] });
    assert.deepStrictEqual(values('tokenize("a.b.c", ".", "q")'), ['a', 'b', 'c']);
    assert.deepStrictEqual(values('tokenize("a$b^c(d", "$", "q")'), ['a', 'b^c(d']);
    assert.deepStrictEqual(values('tokenize("a$b^c(d", "^", "qq")'), ['a$b', 'c(d']);
    assert.deepStrictEqual(values('tokenize("x\\y[z]", "\\", "q")'), ['x', 'y[z]']);
    assert.deepStrictEqual(validated('tokenize($s, "a|b", "q")'), { '$tokenize': ['$s', 'a\\|b'] });
    assert.deepStrictEqual(values('tokenize("a|b", "a|b", "q")'), ['', '']);
  });

  it('should refuse the flags an I-Regexp cannot honour, and flags or a q pattern computed when the query runs', () => {
    for (const flag of ['i', 's', 'm', 'x'])
      failsWith(`tokenize($s, ",", "q${flag}")`, `unsupported construct 'tokenize flag ${flag}'`, 0);
    failsWith('tokenize($s, ",", $f)', "unsupported construct 'tokenize flags other than a literal'", 0);
    failsWith('tokenize($s, $p, "q")', "unsupported construct 'tokenize flag q with a computed pattern'", 0);
  });

  it('should raise F&O FORX0001 for a flag F&O does not define, when the call runs', () => {
    failsAtRun('tokenize("a", "b", "t")', {}, 'err:FORX0001');
    failsAtRun('tokenize("a", "b", " ")', {}, 'err:FORX0001');
    assert.deepStrictEqual(values('if (false()) then tokenize("a", "b", "t") else 1'), [1]);
  });

  it('should refuse the arities F&O does not have', () => {
    failsWith('tokenize($s, ",", "", ())', "unsupported function 'tokenize#4'", 0);
    failsWith('tokenize()', "unsupported function 'tokenize#0'", 0);
    failsWith('fn:tokenize()', "unsupported function 'fn:tokenize#0'", 0);
  });
});
