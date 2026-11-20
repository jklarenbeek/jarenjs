import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { numberFormats } from '@jarenjs/formats';

// A number format judges numbers, and takes every value of another type as
// every format takes the values its type does not cover. It used to read
// its value through `Number()`, so an object, an array or text that
// converted to no number was refused (`'abc'`, `{}`, `[1, 2]`) and one that
// converted to a number in range was taken (`''`, `true`, `[5]`, `'12'`);
// and `Number()` calls the value's own toString/valueOf, which parsed JSON
// can carry as a member that is not a function. Nothing is converted now, so
// such an instance is the object it is: no number, and taken.

describe('number formats and values that are no number', function () {
  for (const [label, options] of [['first-failure', {}], ['collecting', { collectErrors: true, skipErrors: false }]]) {
    const verdict = (fn, data) => { const r = fn(data); return typeof r === 'object' ? r.valid : r; };

    it(`take an instance whose members are named like object methods (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      const int32 = validator.compile({ format: 'int32' });
      for (const text of ['{"toString":true}', '{"valueOf":1}', '{"toString":"x","valueOf":null}']) {
        assert.strictEqual(verdict(int32, JSON.parse(text)), true, text);
      }
    });

    it(`take every value of another type, whatever it would convert to (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      for (const format of Object.keys(numberFormats)) {
        const validate = validator.compile({ format });
        for (const value of ['abc', '', ' ', '12', '64', '300', '1.5', '1e999', true, false, null, {}, { a: 1 }, [], [5], [300], [1, 2]]) {
          assert.strictEqual(verdict(validate, value), true, `${format} on ${JSON.stringify(value)}`);
        }
        assert.strictEqual(verdict(validate, 64), true, `${format} on 64`);
        assert.strictEqual(verdict(validate, NaN), false, `${format} on NaN`);
      }
      const int8 = validator.compile({ format: 'int8' });
      assert.strictEqual(verdict(int8, 300), false);
      assert.strictEqual(verdict(int8, 1.5), false);
      assert.strictEqual(verdict(validator.compile({ type: 'string', format: 'int8' }), '300'), true);
      assert.strictEqual(verdict(validator.compile({ type: 'number', format: 'int8' }), '12'), false, 'the type refuses the string, not the format');
    });

    it(`stay usable under not and nested properties (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      const negated = validator.compile({ not: { format: 'int32' } });
      const nested = validator.compile({ properties: { a: { format: 'float64' } } });
      assert.strictEqual(verdict(negated, JSON.parse('{"toString":true}')), false);
      assert.strictEqual(verdict(negated, 2 ** 31), true);
      assert.strictEqual(verdict(nested, JSON.parse('{"a":{"toString":true}}')), true);
      assert.strictEqual(verdict(nested, { a: Infinity }), false);
    });

    it(`judge a bigint by an integer format's own range, exactly, and take one under a floating point format (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      /** @type {[string, bigint, boolean][]} */
      const table = [
        ['int8', 127n, true], ['int8', 128n, false], ['int8', -128n, true], ['int8', -129n, false],
        ['uint8', 255n, true], ['uint8', 256n, false], ['uint8', -1n, false],
        ['int16', 32767n, true], ['int16', 32768n, false], ['uint16', 65535n, true], ['uint16', 65536n, false],
        ['int32', 2n ** 31n - 1n, true], ['int32', 2n ** 31n, false], ['int32', -(2n ** 31n), true], ['int32', 2n ** 60n, false],
        ['uint32', 2n ** 32n - 1n, true], ['uint32', 2n ** 32n, false], ['uint32', -1n, false],
        // past 2^53 a number cannot tell these apart: a bigint is never judged as the number it converts to
        ['int64', 2n ** 60n, true], ['int64', 2n ** 63n - 1n, true], ['int64', 2n ** 63n, false], ['int64', -(2n ** 63n), true], ['int64', -(2n ** 63n) - 1n, false],
        ['uint64', 2n ** 64n - 1n, true], ['uint64', 2n ** 64n, false], ['uint64', -1n, false], ['uint64', 0n, true],
        ['float16', 10n ** 30n, true], ['float32', 10n ** 60n, true], ['float', 5n, true], ['float64', 10n ** 400n, true], ['double', -5n, true],
      ];
      for (const [format, value, takes] of table) {
        assert.strictEqual(verdict(validator.compile({ format }), value), takes, `${format} on ${value}n`);
      }
      // a number is an int64 within the safe integers, as before
      const int64 = validator.compile({ format: 'int64' });
      assert.strictEqual(verdict(int64, Number.MAX_SAFE_INTEGER), true);
      assert.strictEqual(verdict(int64, 2 ** 60), false);
    });
  }
});
