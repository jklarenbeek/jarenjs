import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A schema map with an entry named `constructor` is still a map of
// schemas: the definition is usable, and a missing reference beside it is
// refused when the schema is compiled, as it is beside any other name.

describe('schemas with a member named constructor', function () {
  it('uses a definition named constructor', function () {
    const validate = new JarenValidator().compile({
      $defs: { constructor: { type: 'string' } },
      properties: { a: { $ref: '#/$defs/constructor' } },
    });
    assert.strictEqual(validate({ a: 'x' }), true);
    assert.strictEqual(validate({ a: 1 }), false);
  });

  it('refuses a missing reference at compile time beside a property named constructor', function () {
    for (const name of ['a', 'constructor', 'toString']) {
      assert.throws(
        () => new JarenValidator().compile({ properties: { [name]: true, b: { $ref: '#/$defs/d' } } }),
        /is not a valid schema/,
        name);
    }
  });

  it('does not drop a schema that carries a stray constructor keyword', function () {
    const validate = new JarenValidator().compile({ properties: { a: { constructor: 1, type: 'string' } } });
    assert.strictEqual(validate({ a: 1 }), false);
    assert.strictEqual(validate({ a: 'x' }), true);
  });

  it('validates an instance that has a member named constructor', function () {
    const instance = JSON.parse('{"constructor":1}');
    const validate = new JarenValidator().compile({ type: 'object', properties: { constructor: { type: 'number' } }, required: ['constructor'] });
    assert.strictEqual(validate(instance), true);
    assert.strictEqual(validate(JSON.parse('{"constructor":"x"}')), false);
  });
});
