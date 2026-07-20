//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePointer } from '@jarenjs/forms';
import { JSONPointerSyntaxError } from '@jarenjs/json/pointer';

describe('forms parsePointer', function () {
  it('splits an RFC 6901 pointer into decoded segments', function () {
    assert.deepEqual(parsePointer('/a/b'), ['a', 'b']);
    assert.deepEqual(parsePointer('/a~1b/c~0d'), ['a/b', 'c~d']); // ~1 -> '/', ~0 -> '~'
  });

  it('treats the empty and nullish pointer as the document root', function () {
    assert.deepEqual(parsePointer(''), []);
    assert.deepEqual(parsePointer(/** @type {any} */ (null)), []);
  });

  it('rejects a pointer that violates the grammar', function () {
    assert.throws(() => parsePointer('nope'), JSONPointerSyntaxError);
  });
});
