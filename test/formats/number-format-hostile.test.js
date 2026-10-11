import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { numberFormats } from '@jarenjs/formats';

// A number format reads its value through `Number()`, which calls the
// value's own toString/valueOf. Parsed JSON can carry a member of that name
// that is not a function; the format then answers "not a number" like it
// does for any other object, instead of throwing out of the validator.

describe('number formats and members named like object methods', function () {
  for (const [label, options] of [['first-failure', {}], ['collecting', { collectErrors: true, skipErrors: false }]]) {
    it(`answer false for such an instance (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      const int32 = validator.compile({ format: 'int32' });
      const verdict = (data) => { const r = int32(data); return typeof r === 'object' ? r.valid : r; };
      for (const text of ['{"toString":true}', '{"valueOf":1}', '{"toString":"x","valueOf":null}']) {
        assert.strictEqual(verdict(JSON.parse(text)), false, text);
      }
      assert.strictEqual(verdict({}), false);
      assert.strictEqual(verdict('64'), true);
      assert.strictEqual(verdict(64), true);
    });

    it(`stay usable under not and nested properties (${label})`, function () {
      const validator = new JarenValidator(options).addFormats(numberFormats);
      const negated = validator.compile({ not: { format: 'int32' } });
      const nested = validator.compile({ properties: { a: { format: 'float64' } } });
      const verdict = (fn, data) => { const r = fn(data); return typeof r === 'object' ? r.valid : r; };
      assert.strictEqual(verdict(negated, JSON.parse('{"toString":true}')), true);
      assert.strictEqual(verdict(nested, JSON.parse('{"a":{"toString":true}}')), false);
    });
  }
});
