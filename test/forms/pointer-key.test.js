import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapePointerKey } from '@jarenjs/forms';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';

describe('escapePointerKey', () => {
  it('escapes a member name as one JSON Pointer segment, as the pointer package does', () => {
    assert.equal(escapePointerKey('a/b~c'), 'a~1b~0c');
    assert.equal(escapePointerKey('~/'), '~0~1');
    assert.equal(escapePointerKey(''), '');
    for (const key of ['plain', 'a/b', '~1', '__proto__'])
      assert.equal(escapePointerKey(key), encodeJSONPointerSegment(key));
  });
});
