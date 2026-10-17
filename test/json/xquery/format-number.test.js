import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery, parseXQuery } from '@jarenjs/json/xquery';
import { JsonQueryCompileError } from '@jarenjs/json/query';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

describe('XQuery front-end fn:format-number', () => {
  it('should emit $format-number for a picture without a multiplier', () => {
    assert.deepStrictEqual(validated('format-number($v, "#,##0.00")'), { '$format-number': ['$v', '#,##0.00'] });
    assert.deepStrictEqual(values('format-number(1234.5, "#,##0.00")'), ['1,234.50']);
    assert.deepStrictEqual(values('format-number(-0.5, "0.0")'), ['-0.5']);
    assert.deepStrictEqual(values('format-number(12, "000")'), ['012']);
  });

  it('should format the empty sequence and NaN as the NaN symbol, an infinity with the picture', () => {
    assert.deepStrictEqual(values('format-number((), "0.0")'), ['NaN']);
    assert.deepStrictEqual(values('format-number(0 div 0, "0.0")'), ['NaN']);
    assert.deepStrictEqual(values('format-number(-1 div 0, "#.0x")'), ['-Infinityx']);
  });

  it('should pass a named decimal format, trimming a literal name of its white space', () => {
    assert.deepStrictEqual(validated('format-number($v, "0.0", " nl ")'), { '$format-number': ['$v', '0.0', 'nl'] });
    assert.deepStrictEqual(validated('format-number($v, "0.0", $f)'), { '$format-number': ['$v', '0.0', '$f'] });
    assert.deepStrictEqual(validated('format-number($v, "0.0", "$f")'), { '$format-number': ['$v', '0.0', '$$f'] });
    const nl = { decimalSeparator: ',', groupingSeparator: '.' };
    const query = compileXQuery('format-number(1234.5, "#.##0,00", "nl")', { decimalFormats: { nl } });
    assert.strictEqual(query(null), '1.234,50');
  });

  it('should multiply a percent or per-mille picture as a double, and put the sign back', () => {
    assert.deepStrictEqual(validated('format-number($v, "0.0%")'), {
      '$replace': [{ '$format-number': [{ '$mul': ['$v', 100] }, '0.0\uffff'] }, '\uffff', '%'],
    });
    assert.deepStrictEqual(values('format-number(0.4857, "###.###%")'), ['48.57%']);
    assert.deepStrictEqual(values('format-number(0.4857, "###.###\u2030")'), ['485.7\u2030']);
    assert.deepStrictEqual(values('format-number(0.14, "01%")'), ['14%']);
    assert.deepStrictEqual(values('format-number(-0.25, "0%;(0%)")'), ['(25%)']);
  });

  it('should give the double product F&O gives: rounded, and infinite past the double range', () => {
    // F&O multiplies the double: 1.10203040506070809 * 1000 is
    // 1102.030405060708, where scaling its decimal digits gives ...082
    assert.deepStrictEqual(values('format-number(1.102030405060708090, "0.00000000000000000\u2030")'),
      ['1102.03040506070800000\u2030']);
    assert.deepStrictEqual(values('format-number(1e308, "0%")'), ['Infinity%']);
    assert.deepStrictEqual(values('format-number(-1e308, "0%")'), ['-Infinity%']);
    assert.deepStrictEqual(values('format-number(-0.0e0, "0%")'), ['-0%']);
    assert.deepStrictEqual(values('format-number((), "0%")'), ['NaN']);
    assert.deepStrictEqual(values('format-number(0 div 0, "0%")'), ['NaN']);
  });

  it('should leave a picture F&O refuses to the engine, which refuses it as the query compiles', () => {
    for (const picture of ['9.9999e999%', '0%%', '0%\u2030']) {
      const doc = parseXQuery(`format-number(1, "${picture}")`);
      assert.deepStrictEqual(doc, { '$format-number': [1, picture] });
      assert.throws(() => compileXQuery(`format-number(1, "${picture}")`), (e) => {
        assert.ok(e instanceof JsonQueryCompileError, e.message);
        assert.strictEqual(e.code, 'JQ0003');
        return true;
      });
    }
  });

  it('should refuse a picture whose sub-pictures multiply by different signs', () => {
    failsWith('format-number($v, "0%;0\u2030")', "unsupported construct 'format-number picture with a percent and a per-mille sub-picture'", 0);
  });

  it('should keep the multiplier with the engine for a computed picture or a named format', () => {
    assert.deepStrictEqual(validated('format-number($v, $p)'), { '$format-number': ['$v', '$p'] });
    assert.deepStrictEqual(validated('format-number($v, "0%", "f")'), { '$format-number': ['$v', '0%', 'f'] });
  });

  it('should refuse a value that is not a number and the arities F&O does not have', () => {
    failsAtRun('format-number("1", "0")');
    failsAtRun('format-number("1", "0%")');
    failsWith('format-number(1)', "unsupported function 'format-number#1'", 0);
    failsWith('fn:format-number(1, "0", "a", "b")', "unsupported function 'fn:format-number#4'", 0);
  });
});
