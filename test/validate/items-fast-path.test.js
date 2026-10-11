import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// The default (first-failure) validator compiles a one-keyword item schema
// to a bare predicate. That shortcut must give the verdict the full
// compilation gives, so the same schema answers the same in both modes.

const MODES = [
  ['first-failure', {}],
  ['collecting', { collectErrors: true, skipErrors: false }],
];

function verdict(options, schema, data) {
  const result = new JarenValidator(options).compile(schema)(data);
  return typeof result === 'object' ? result.valid : result;
}

describe('one-keyword item schemas', function () {
  for (const [label, options] of MODES) {
    it(`type given as an array is enforced (${label})`, function () {
      assert.strictEqual(verdict(options, { items: { type: ['string'] } }, [true]), false);
      assert.strictEqual(verdict(options, { items: { type: ['string'] } }, ['a']), true);
      assert.strictEqual(verdict(options, { items: { type: ['string', 'number'] } }, [true]), false);
      assert.strictEqual(verdict(options, { items: { type: ['string', 'number'] } }, ['a', 1]), true);
      assert.strictEqual(verdict(options, { prefixItems: [{ type: ['integer'] }] }, [1.5]), false);
      assert.strictEqual(verdict(options, { items: { type: ['null'] } }, [0]), false);
    });

    it(`required counts own members only (${label})`, function () {
      assert.strictEqual(verdict(options, { items: { required: ['toString'] } }, [{}]), false);
      assert.strictEqual(verdict(options, { items: { required: ['constructor'] } }, [{}]), false);
      assert.strictEqual(verdict(options, { prefixItems: [{ required: ['valueOf'] }] }, [{}]), false);
      assert.strictEqual(verdict(options, { items: { required: ['toString'] } }, [JSON.parse('{"toString":1}')]), true);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [{ a: 1 }, 1, []]), true);
      assert.strictEqual(verdict(options, { items: { required: ['a'] } }, [{ b: 1 }]), false);
    });

    it(`required given as a $data reference is honored (${label})`, function () {
      const schema = { properties: { list: { items: { required: { $data: '2/names' } } } } };
      assert.strictEqual(verdict(options, schema, { names: ['a'], list: [{}] }), false);
      assert.strictEqual(verdict(options, schema, { names: ['a'], list: [{ a: 1 }] }), true);
    });
  }
});
