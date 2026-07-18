import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseJosl,
  parseToml,
  JoslSyntaxError,
  LocalDate,
  LocalTime,
  LocalDateTime,
} from '@jarenjs/josl';

function bad(text, options = undefined) {
  throws(() => parseJosl(text, options), JoslSyntaxError);
}

//#region TOML 1.0 backward compatibility

describe('josl: toml strings', () => {
  it('parses basic strings with escapes', () => {
    deepStrictEqual(
      parseJosl('str = "I\'m a string. \\"Quote\\". Tab\\t Uni \\u0041 \\U0001F600"'),
      { str: 'I\'m a string. "Quote". Tab\t Uni A \u{1F600}' });
  });
  it('parses literal strings verbatim', () => {
    deepStrictEqual(
      parseJosl("winpath = 'C:\\Users\\nodejs\\templates'"),
      { winpath: 'C:\\Users\\nodejs\\templates' });
  });
  it('parses multi-line basic strings, trimming the first newline', () => {
    deepStrictEqual(
      parseJosl('str = """\nRoses are red\nViolets are blue"""'),
      { str: 'Roses are red\nViolets are blue' });
  });
  it('parses line-ending backslashes', () => {
    deepStrictEqual(
      parseJosl('str = """\\\n  The quick brown \\\n\n  fox."""'),
      { str: 'The quick brown fox.' });
  });
  it('keeps one or two quotes inside multi-line strings', () => {
    deepStrictEqual(
      parseJosl('str = """Here are two quotation marks: "". Simple enough."""'),
      { str: 'Here are two quotation marks: "". Simple enough.' });
    deepStrictEqual(
      parseJosl('str = """"This," she said, "is just a pointless statement.""""'),
      { str: '"This," she said, "is just a pointless statement."' });
  });
  it('parses multi-line literal strings', () => {
    deepStrictEqual(
      parseJosl("regex2 = '''I [dw]on't need \\d{2} apples'''"),
      { regex2: "I [dw]on't need \\d{2} apples" });
  });
  it('rejects unterminated and control-char strings', () => {
    bad('a = "no end');
    bad('a = "ctrl "');
    bad('a = "bad \\q escape"');
  });
});

describe('josl: toml numbers', () => {
  it('parses integers in all radixes with separators', () => {
    deepStrictEqual(
      parseJosl([
        'int1 = +99', 'int2 = 42', 'int3 = 0', 'int4 = -17',
        'int5 = 1_000', 'hex1 = 0xDEADBEEF', 'oct1 = 0o755', 'bin1 = 0b11010110',
      ].join('\n')),
      {
        int1: 99, int2: 42, int3: 0, int4: -17,
        int5: 1000, hex1: 0xDEADBEEF, oct1: 0o755, bin1: 0b11010110,
      });
  });
  it('parses floats, exponents, inf and nan', () => {
    const r = parseJosl([
      'flt1 = +1.0', 'flt2 = 3.1415', 'flt3 = -0.01', 'flt4 = 5e+22',
      'flt5 = 1e06', 'flt6 = -2E-2', 'flt7 = 6.626e-34', 'flt8 = 224_617.445_991_228',
      'sf1 = inf', 'sf2 = -inf', 'sf3 = nan',
    ].join('\n'));
    strictEqual(r.flt1, 1.0);
    strictEqual(r.flt4, 5e22);
    strictEqual(r.flt8, 224617.445991228);
    strictEqual(r.sf1, Infinity);
    strictEqual(r.sf2, -Infinity);
    ok(Number.isNaN(r.sf3));
  });
  it('rejects malformed numbers', () => {
    bad('a = 01');
    bad('a = 1.');
    bad('a = .5');
    bad('a = 1__0');
    bad('a = 1_');
    bad('a = -0x1');
  });
});

describe('josl: toml datetimes', () => {
  it('parses offset date-times to Date', () => {
    deepStrictEqual(
      parseJosl('odt1 = 1979-05-27T07:32:00Z'),
      { odt1: new Date('1979-05-27T07:32:00Z') });
    deepStrictEqual(
      parseJosl('odt2 = 1979-05-27T00:32:00-07:00'),
      { odt2: new Date('1979-05-27T00:32:00-07:00') });
    deepStrictEqual(
      parseJosl('odt3 = 1979-05-27 07:32:00Z'),
      { odt3: new Date('1979-05-27T07:32:00Z') });
  });
  it('parses local date-times, dates and times to value classes', () => {
    const r = parseJosl([
      'ldt = 1979-05-27T07:32:00.999',
      'ld = 1979-05-27',
      'lt = 07:32:00.500',
    ].join('\n'));
    ok(r.ldt instanceof LocalDateTime);
    strictEqual(r.ldt.toString(), '1979-05-27T07:32:00.999');
    deepStrictEqual(r.ld, new LocalDate(1979, 5, 27));
    ok(r.lt instanceof LocalTime);
    strictEqual(r.lt.toString(), '07:32:00.500');
  });
  it('rejects impossible dates and times', () => {
    bad('a = 2021-02-30');
    bad('a = 1900-02-29');
    bad('a = 10:61:00');
    bad('a = 2021-01-01T25:00:00Z');
  });
  it('accepts leap years and leap seconds', () => {
    deepStrictEqual(parseJosl('a = 2000-02-29'), { a: new LocalDate(2000, 2, 29) });
    ok(parseJosl('a = 23:59:60').a instanceof LocalTime);
  });
});

describe('josl: toml tables', () => {
  it('parses tables, subtables and dotted keys', () => {
    deepStrictEqual(
      parseJosl([
        'title = "example"',
        '',
        '[owner]',
        'name = "Tom"',
        'dob.year = 1979',
        '',
        '[owner.pets]',
        'cat = true',
        '',
        '["quoted key".sub]',
        'x = 1',
      ].join('\n')),
      {
        title: 'example',
        owner: { name: 'Tom', dob: { year: 1979 }, pets: { cat: true } },
        'quoted key': { sub: { x: 1 } },
      });
  });
  it('parses arrays of tables', () => {
    deepStrictEqual(
      parseJosl([
        '[[products]]',
        'name = "Hammer"',
        'sku = 738594937',
        '',
        '[[products]]',
        '',
        '[[products]]',
        'name = "Nail"',
        '',
        '[products.spec]',
        'weight = 0.5',
      ].join('\n')),
      {
        products: [
          { name: 'Hammer', sku: 738594937 },
          {},
          { name: 'Nail', spec: { weight: 0.5 } },
        ],
      });
  });
  it('enforces redefinition rules', () => {
    bad('[a]\nb = 1\n[a]');
    bad('a = 1\na = 2');
    bad('[[a]]\n[a]');
    bad('[a]\n[[a]]');
    bad('fruit.apple.color = "red"\n[fruit.apple]');
    bad('[fruit]\napple.color = "red"\n[fruit.apple]');
    bad('a = { b = 1 }\n[a.c]');
    bad('a = [1]\n[[a]]');
  });
  it('allows opening a super-table after its subtable', () => {
    deepStrictEqual(
      parseJosl('[a.b]\nx = 1\n[a]\ny = 2'),
      { a: { b: { x: 1 }, y: 2 } });
  });
});

describe('josl: toml arrays and inline tables', () => {
  it('parses multi-line arrays with comments and trailing commas', () => {
    deepStrictEqual(
      parseJosl([
        'nested = [ [ 1, 2 ], ["a", "b", "c"] ]',
        'numbers = [ 0.1, 0.2, 1, 2 ]',
        'multi = [',
        '  1, # one',
        '  2, # two',
        ']',
      ].join('\n')),
      {
        nested: [[1, 2], ['a', 'b', 'c']],
        numbers: [0.1, 0.2, 1, 2],
        multi: [1, 2],
      });
  });
  it('parses inline tables with dotted keys', () => {
    deepStrictEqual(
      parseJosl('name = { first = "Tom", last = "P" }\npoint = { x.a = 1, y = 2 }'),
      { name: { first: 'Tom', last: 'P' }, point: { x: { a: 1 }, y: 2 } });
  });
  it('rejects newlines and trailing commas in inline tables', () => {
    bad('a = { x = 1,\n y = 2 }');
    bad('a = { x = 1, }');
    bad('a = { x = 1 y = 2 }');
  });
  it('rejects extending inline tables', () => {
    bad('a = { x = 1 }\n[a]\ny = 2');
  });
});

describe('josl: comments and whitespace', () => {
  it('ignores comments, blank lines and value-adjacent comments', () => {
    deepStrictEqual(
      parseJosl('# top\n\n  key = "value"  # trailing\n\nother = 1# tight'),
      { key: 'value', other: 1 });
  });
  it('rejects garbage after expressions', () => {
    bad('key = 1 2');
    bad('[a] junk');
  });
});

//#endregion

//#region JOSL extensions

describe('josl: extensions', () => {
  it('parses null', () => {
    deepStrictEqual(parseJosl('a = null'), { a: null });
    throws(() => parseToml('a = null'), JoslSyntaxError);
  });
  it('parses bigint literals in every radix', () => {
    deepStrictEqual(
      parseJosl('a = 123n\nb = -42n\nc = 0xffn\nd = 0o17n\ne = 0b11n'),
      { a: 123n, b: -42n, c: 255n, d: 15n, e: 3n });
    throws(() => parseToml('a = 123n'), JoslSyntaxError);
    bad('a = 1.5n');
  });
  it('auto-promotes unsafe integers to bigint', () => {
    deepStrictEqual(parseJosl('a = 9007199254740993'), { a: 9007199254740993n });
    throws(() => parseToml('a = 9007199254740993'), JoslSyntaxError);
  });
  it('parses regexp literals', () => {
    deepStrictEqual(
      parseJosl('re = /ab+c/gi\nslash = /a\\/b/\ncls = /[/]/u'),
      { re: /ab+c/gi, slash: /a\/b/, cls: /[/]/u });
    throws(() => parseToml('re = /ab+c/gi'), JoslSyntaxError);
    bad('re = /unclosed');
    bad('re = /a(/');
  });
  it('parses root arrays via [[]]', () => {
    deepStrictEqual(
      parseJosl([
        '[[]]',
        'name = "one"',
        '[meta]',
        'x = 1',
        '',
        '[[]]',
        'name = "two"',
        '[[tags]]',
        't = "a"',
      ].join('\n')),
      [
        { name: 'one', meta: { x: 1 } },
        { name: 'two', tags: [{ t: 'a' }] },
      ]);
    throws(() => parseToml('[[]]'), JoslSyntaxError);
    bad('a = 1\n[[]]'); // cannot mix root table and root array
  });
  it('guards against prototype pollution', () => {
    const r = parseJosl('[__proto__]\npolluted = true');
    strictEqual({}.polluted, undefined);
    strictEqual(Object.getPrototypeOf(r), Object.prototype);
    deepStrictEqual(r.__proto__, { polluted: true });
  });
});

describe('josl: error quality', () => {
  it('reports line, column and hint', () => {
    try {
      parseJosl('good = 1\nbad = null', { mode: 'toml' });
      ok(false, 'should have thrown');
    }
    catch (e) {
      ok(e instanceof JoslSyntaxError);
      strictEqual(e.line, 2);
      strictEqual(e.column, 7);
      ok(e.hint.includes('TOML has no null'));
    }
  });
  it('reports positions inside multi-line constructs', () => {
    try {
      parseJosl('arr = [\n  1,\n  what,\n]');
      ok(false, 'should have thrown');
    }
    catch (e) {
      strictEqual(e.line, 3);
      strictEqual(e.column, 3);
    }
  });
});

//#endregion
