//@ts-check
/**
 * @file A schema's `type` is data: `canonicalNullable` looked it up in a table
 * with a prototype, so `constructor` or `toString` read as a known type (the
 * canonical form came back for it) and, with any sibling keyword, the lookup
 * threw "scoped.has is not a function".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalNullable } from '@jarenjs/core/schema';

describe('canonicalNullable — prototype-named types', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    it(`does not take '${name}' for a type`, () => {
      assert.strictEqual(canonicalNullable({ type: [name, 'null'] }), null);
      assert.strictEqual(canonicalNullable({ type: [name, 'null'], minLength: 1 }), null);
      assert.strictEqual(canonicalNullable({ anyOf: [{ type: name, minLength: 1 }, { type: 'null' }] }), null);
    });
  }

  it('still canonicalizes the real types', () => {
    assert.deepStrictEqual(canonicalNullable({ type: ['string', 'null'], minLength: 1 }),
      { type: ['string', 'null'], minLength: 1 });
    assert.deepStrictEqual(canonicalNullable({ anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] }),
      { minimum: 0, type: ['integer', 'null'] });
  });
});
