import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A schema naming a type the validator does not know is refused at compile
// time, coded, and located at the name: the keyword itself, or the member of
// a type list that is no type name.

describe('unknown type names', function () {
  const refusal = (schema) => {
    try {
      new JarenValidator().compile(schema);
    }
    catch (e) {
      return [e.code, e.docPath];
    }
    return null;
  };

  it('refuses a single unknown type at the keyword', function () {
    assert.deepStrictEqual(refusal({ type: 'strin' }), ['JK0013', '#/type']);
  });

  it('refuses the unknown member of a type list at the member', function () {
    assert.deepStrictEqual(refusal({ type: ['string', 'foo'] }), ['JK0013', '#/type/1']);
    assert.deepStrictEqual(refusal({ type: ['foo', 'bar'] }), ['JK0013', '#/type/0']);
  });

  it('accepts the known types', function () {
    assert.strictEqual(refusal({ type: ['string', 'null'] }), null);
  });
});
