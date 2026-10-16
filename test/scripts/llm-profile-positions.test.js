//@ts-check
// The LLM-profile relaxation rewrites schema positions only. A member NAMED
// like a relaxed keyword (`format`, `oneOf`) is a member, and `enum`,
// `const` and `default` values are data: none of them is removed, renamed or
// given a description. Before, a properties map lost its `format` member,
// renamed `oneOf` to `anyOf`, and gained a `description` member whose
// "schema" was a string.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLlmProfile } from '../../scripts/lib/schema-profiles.js';

describe('deriveLlmProfile reads schema positions only', () => {
  it('keeps members named like a relaxed keyword, and data as written', () => {
    const profile = /** @type {any} */ (deriveLlmProfile({
      $id: 'https://x.test/s', title: 'S', type: 'object',
      properties: { format: { type: 'string', format: 'date' }, oneOf: { type: 'integer' } },
      enum: [{ format: 'kept' }], default: { propertyNames: 1 },
    }));
    assert.deepEqual(profile.properties, {
      format: { type: 'string', description: "(LLM profile: the 'date' format assertion is relaxed here; the canonical schema enforces it)" },
      oneOf: { type: 'integer' },
    });
    assert.deepEqual(profile.enum, [{ format: 'kept' }]);
    assert.deepEqual(profile.default, { propertyNames: 1 });
  });
});
