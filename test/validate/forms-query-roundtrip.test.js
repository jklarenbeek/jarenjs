import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { formRulesToQueryAssertions } from '@jarenjs/forms';

// The validate-side round trip of the forms rules synergy: a rule
// authored once as `x-form.assert` (per-keystroke feedback) is copied by
// formRulesToQueryAssertions into a '$query' keyword and enforced by the
// authoritative submit validation. Forms itself never imports the
// validator - this integration is wired caller-side, as here.

describe("forms x-form.assert -> '$query' round trip", () => {

  it('should enforce a copied cross-field assert on submit', () => {
    const schema = {
      type: 'object',
      properties: {
        company: { type: 'string' },
        vatId: {
          type: 'string',
          'x-form': {
            assert: { $or: [{ $eq: ['$.company', ''] }, { $ne: ['$.vatId', ''] }] },
            message: 'VAT id is required for companies',
          },
        },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ company: '', vatId: '' }), true);
    assert.strictEqual(validate({ company: 'ACME', vatId: 'NL123' }), true);
    assert.strictEqual(validate({ company: 'ACME', vatId: '' }), false);
  });

  it('should bind $value and $pointer inside the copied assert', () => {
    const schema = {
      type: 'object',
      properties: {
        nick: { type: 'string', 'x-form': { assert: { $ne: ['$value', 'root'] } } },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ nick: 'joe' }), true);
    assert.strictEqual(validate({ nick: 'root' }), false);
    // absent field: the $let binds the empty sequence; $ne over it is
    // false, so absence fails this assert on submit (keystroke evaluation
    // binds null instead - require the field when that matters).
    assert.strictEqual(validate({}), false);
  });

  it('should quantify a copied item-template assert over the actual elements', () => {
    const schema = {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number', 'x-form': { assert: { $gt: ['$value', 0] } } },
            },
          },
        },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ lines: [{ amount: 5 }, { amount: 3 }] }), true);
    assert.strictEqual(validate({ lines: [{ amount: 5 }, { amount: 0 }] }), false);
    assert.strictEqual(validate({ lines: [] }), true, '$every is vacuously true');
    assert.strictEqual(validate({}), true, 'no array, nothing to assert');
  });

  it('should compose with an existing root $query through allOf', () => {
    const schema = {
      type: 'object',
      $query: '$.approved',
      properties: {
        a: { type: 'number', 'x-form': { assert: { $gt: ['$.a', 0] } } },
      },
    };

    const validate = new JarenValidator().compile(formRulesToQueryAssertions(schema));
    assert.strictEqual(validate({ approved: true, a: 1 }), true);
    assert.strictEqual(validate({ approved: false, a: 1 }), false, 'original $query still asserts');
    assert.strictEqual(validate({ approved: true, a: 0 }), false, 'copied assert asserts');
  });
});
