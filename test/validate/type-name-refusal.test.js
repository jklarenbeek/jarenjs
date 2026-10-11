import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A schema naming a type the validator does not know is refused at compile
// time, and the message names the offending type and the list it sat in.

describe('unknown type names', function () {
  const message = (schema) => {
    try {
      new JarenValidator().compile(schema);
    }
    catch (e) {
      return e.message;
    }
    return null;
  };

  it('names a single unknown type', function () {
    assert.strictEqual(message({ type: 'strin' }), "The explicit schema type 'strin' is unknown.");
  });

  it('names the unknown member of a type list and the whole list', function () {
    assert.strictEqual(message({ type: ['string', 'foo'] }), "The explicit schema type 'foo' of [string, foo] is unknown.");
    assert.strictEqual(message({ type: ['foo', 'bar'] }), "The explicit schema type 'foo' of [foo, bar] is unknown.");
  });

  it('accepts the known types', function () {
    assert.strictEqual(message({ type: ['string', 'null'] }), null);
  });
});
