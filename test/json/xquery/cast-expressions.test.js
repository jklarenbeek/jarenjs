import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseXQuery, compileXQuery } from '@jarenjs/json/xquery';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

// [type, lowest value, highest value]; null is no bound. The bounds of
// xs:long and xs:unsignedLong are checked on the double: -2^63 is exact,
// and the highest doubles below 2^63 and 2^64 are the highest held.
const DERIVED = [
  ['long', -(2 ** 63), 2 ** 63 - 1024],
  ['int', -2147483648, 2147483647],
  ['short', -32768, 32767],
  ['byte', -128, 127],
  ['unsignedLong', 0, 2 ** 64 - 2048],
  ['unsignedInt', 0, 4294967295],
  ['unsignedShort', 0, 65535],
  ['unsignedByte', 0, 255],
  ['nonNegativeInteger', 0, null],
  ['positiveInteger', 1, null],
  ['nonPositiveInteger', null, 0],
  ['negativeInteger', null, -1],
];

// the next double past `n` going outwards: n ± 1 below 2^53, the next
// representable double beyond it
const beyond = (n, sign) => {
  let step = 1;
  while (n + sign * step === n)
    step *= 2;
  return n + sign * step;
};

describe('XQuery front-end derived integer types', () => {
  it('should take every value of the range and refuse the first value past each bound', () => {
    for (const [type, low, high] of DERIVED) {
      for (const bound of [low, high]) {
        if (bound === null)
          continue;
        assert.deepStrictEqual(values(`xs:${type}($v)`, { v: bound }), [bound], `${type} ${bound}`);
        assert.deepStrictEqual(values(`xs:${type}($v)`, { v: String(BigInt(bound)) }), [bound], `${type} "${bound}"`);
      }
      if (low !== null)
        failsAtRun(`xs:${type}($v)`, { v: beyond(low, -1) });
      if (high !== null)
        failsAtRun(`xs:${type}($v)`, { v: beyond(high, 1) });
    }
  });

  it('should fold a literal in range and fail one outside it when the cast runs', () => {
    assert.deepStrictEqual(validated('xs:byte("127")'), 127);
    assert.deepStrictEqual(validated('xs:byte(" -0128 ")'), -128);
    assert.deepStrictEqual(validated('xs:byte(-128.9)'), -128);
    assert.deepStrictEqual(validated('xs:unsignedInt("-0")'), 0);
    assert.deepStrictEqual(validated('xs:positiveInteger(true())'), 1);
    assert.deepStrictEqual(validated('xs:byte("128")'), { '$number': 'xs:byte: 128' });
    assert.deepStrictEqual(validated('xs:byte(300)'), { '$number': 'xs:byte: 300' });
    assert.deepStrictEqual(validated('xs:positiveInteger("0")'), { '$number': 'xs:positiveInteger: 0' });
    assert.deepStrictEqual(validated('xs:negativeInteger(false())'), { '$number': 'xs:negativeInteger: false' });
    assert.deepStrictEqual(validated('xs:short("1.5")'), { '$number': 'xs:short: 1.5' });
    assert.deepStrictEqual(values('if (false()) then xs:byte(300) else 1'), [1]);
    failsAtRun('xs:byte(300)');
  });

  it('should read the operand as xs:integer does before checking the range', () => {
    const asByte = (v) => values('xs:byte($v)', { v });
    assert.deepStrictEqual(asByte(' +007 '), [7]);
    assert.deepStrictEqual(asByte(127.9), [127]);
    assert.deepStrictEqual(asByte(-128.9), [-128]);
    assert.deepStrictEqual(asByte(true), [1]);
    assert.deepStrictEqual(values('xs:byte(())'), []);
    for (const bad of ['128', '-129', '1.5', '1e2', 'x', 128.5, NaN, Infinity, null, [1], { a: 1 }])
      failsAtRun('xs:byte($v)', { v: bad });
    failsAtRun('xs:byte((1, 2))');
  });

  it('should name the type and the operand in the error', () => {
    assert.throws(() => compileXQuery('xs:byte($v)')(null, { v: '128' }), /xs:byte: 128/);
    assert.throws(() => compileXQuery('xs:unsignedShort($v)')(null, { v: -1 }), /xs:unsignedShort: -1/);
  });

  it('should read a value past 2^53 as its double before checking the range (D1)', () => {
    // 2^63 - 1 rounds to 2^63, outside xs:long; -2^63 - 1 rounds to -2^63, inside
    failsAtRun('xs:long($v)', { v: '9223372036854775807' });
    assert.deepStrictEqual(values('xs:long($v)', { v: '-9223372036854775809' }), [-(2 ** 63)]);
    failsAtRun('xs:unsignedLong($v)', { v: '18446744073709551615' });
  });

  it('should not capture, or be captured by, the names a user chose', () => {
    assert.deepStrictEqual(values('let $xs_int := "5" return xs:short($xs_int)'), [5]);
    assert.deepStrictEqual(values('for $xs_arg in (1, 300) return 200 castable as xs:unsignedByte'), [true, true]);
    assert.deepStrictEqual(values('let $xs_int := 300 return $xs_int castable as xs:byte'), [false]);
  });
});

// true when `run` returns, false when it raises
function succeeds(run) {
  try {
    run();
    return true;
  }
  catch {
    return false;
  }
}

describe('XQuery front-end cast as and castable as', () => {
  it('should emit the constructor for cast as T? and raise on the empty sequence for cast as T', () => {
    assert.deepStrictEqual(validated('$v cast as xs:double?'), validated('xs:double($v)'));
    assert.deepStrictEqual(validated('$v cast as xs:string?'), { '$string': '$v' });
    assert.deepStrictEqual(validated('"12" cast as xs:integer'), 12);
    assert.deepStrictEqual(values('$v cast as xs:integer', { v: ' 5 ' }), [5]);
    assert.deepStrictEqual(values('() cast as xs:integer?'), []);
    for (const type of ['string', 'boolean', 'integer', 'decimal', 'double', 'float', 'int'])
      failsAtRun(`() cast as xs:${type}`);
    assert.throws(() => compileXQuery('() cast as xs:int')(null, {}), /xs:int: the empty sequence/);
  });

  it('should fold castable as over a literal to the answer', () => {
    assert.strictEqual(validated('"12" castable as xs:integer'), true);
    assert.strictEqual(validated('"1.5" castable as xs:integer'), false);
    assert.strictEqual(validated('" INF " castable as xs:double'), true);
    assert.strictEqual(validated('300 castable as xs:byte'), false);
    assert.strictEqual(validated('"yes" castable as xs:boolean'), false);
  });

  it('should answer castable as by the cast: true exactly when the cast gives a value', () => {
    const types = ['string', 'boolean', 'integer', 'decimal', 'double', 'float', ...DERIVED.map(([type]) => type)];
    const operands = ['', ' 12 ', '-0', '+5', '1.5', '.5', '5.', '1e3', 'INF', '-INF', 'NaN', 'true', '0', ' false ', 'x',
      '1' + '0'.repeat(400), '128', '-129', '9223372036854775807', 0, -0, 1, -1, 127.5, 300, 1e21, NaN, Infinity, -Infinity,
      true, false, null, [1], {}];
    let compared = 0;
    for (const type of types) {
      for (const occurrence of ['', '?']) {
        const castable = compileXQuery(`$v castable as xs:${type}${occurrence}`);
        const cast = compileXQuery(`$v cast as xs:${type}${occurrence}`);
        for (const v of operands) {
          assert.strictEqual(castable(null, { v }), succeeds(() => cast(null, { v })),
            `${JSON.stringify(v)} castable as xs:${type}${occurrence}`);
          compared++;
        }
        for (const text of ['()', '(1, 2)', '("1", "2")']) {
          const casts = succeeds(() => compileXQuery(`${text} cast as xs:${type}${occurrence}`)(null, {}));
          assert.deepStrictEqual(values(`${text} castable as xs:${type}${occurrence}`), [casts],
            `${text} castable as xs:${type}${occurrence}`);
          compared++;
        }
      }
    }
    assert.strictEqual(compared, types.length * 2 * (operands.length + 3));
  });

  it('should give no integer or decimal for a text past the double range, and say so to castable as', () => {
    const huge = '1' + '0'.repeat(400);
    failsAtRun('xs:integer($v)', { v: huge });
    failsAtRun('$v cast as xs:decimal', { v: '-' + huge });
    assert.deepStrictEqual(values('$v castable as xs:integer, $v castable as xs:decimal', { v: huge }), [false, false]);
    assert.deepStrictEqual(values('xs:double($v), $v castable as xs:double', { v: huge }), [Infinity, true]);
  });

  it('should answer the empty sequence by the occurrence indicator, and never raise', () => {
    assert.deepStrictEqual(values('() castable as xs:integer, () castable as xs:integer?'), [false, true]);
    assert.deepStrictEqual(values('(1, 2) castable as xs:integer?, [1] castable as xs:string'), [false, false]);
    assert.deepStrictEqual(values('$v castable as xs:int', { v: { a: 1 } }), [false]);
    assert.deepStrictEqual(values('for $s in ("1", "x", "2.5") return $s castable as xs:integer'), [true, false, false]);
  });

  it('should bind as the grammar says: unary inside, arithmetic and logic outside', () => {
    assert.deepStrictEqual(values('- 1 cast as xs:string'), ['-1']);
    assert.deepStrictEqual(values('1 + "2" cast as xs:integer'), [3]);
    assert.deepStrictEqual(values('2 * "3" cast as xs:integer * 2'), [12]);
    assert.deepStrictEqual(values('"1" cast as xs:integer castable as xs:string'), [true]);
    assert.deepStrictEqual(values('"5" castable as xs:byte and "500" castable as xs:byte'), [false]);
    assert.deepStrictEqual(values('() cast as xs:integer (: a comment :) ?'), []);
  });

  it('should refuse a second cast and a missing as as syntax errors', () => {
    failsWith('1 cast as xs:integer cast as xs:string', "unexpected 'cast' after a cast or castable expression", 21);
    failsWith('1 castable as xs:integer castable as xs:boolean', "unexpected 'castable' after a cast or castable expression", 25);
    failsWith('1 castable as xs:integer cast as xs:string', "unexpected 'cast' after a cast or castable expression", 25);
    failsWith('"1" cast xs:integer', "expected 'as'", 9);
  });

  it('should refuse a type outside the mapped ones by name', () => {
    failsWith('"1" cast as xs:date', "unsupported construct 'cast as xs:date'", 12);
    failsWith('"1" castable as xs:anyAtomicType', "unsupported construct 'castable as xs:anyAtomicType'", 16);
    failsWith('"1" cast as integer', "unsupported construct 'cast as integer'", 12);
    failsWith('"1" cast as fn:string', "unsupported construct 'cast as fn:string'", 12);
    failsWith('"1" cast as Q{http://www.w3.org/2001/XMLSchema}integer', "unsupported construct 'URI-qualified name'", 12);
    assert.throws(() => parseXQuery('1 instance of xs:integer'), /unsupported construct 'instance of'/);
  });
});
