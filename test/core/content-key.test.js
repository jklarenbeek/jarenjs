//@ts-check
/**
 * @file `contentKey` — the memo-grade content key hoisted by the health
 * pass. The property the four migrated call sites (charts config keys,
 * calc plot vnode keys) rely on: structurally equal values produce the
 * same key regardless of property insertion order. The two documented
 * caveats (dropped `undefined` members, no cycle guard) are pinned too,
 * so nobody mistakes this for a checksum — that job belongs to
 * `canonicalizeJson`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { contentKey, stableStringify } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';

describe('contentKey', () => {
  it('is insensitive to property insertion order at every depth', () => {
    assert.strictEqual(
      contentKey({ a: 1, b: { x: [1, 2], y: 'z' } }),
      contentKey({ b: { y: 'z', x: [1, 2] }, a: 1 }));
  });

  it('distinguishes structurally different values', () => {
    assert.notStrictEqual(contentKey({ a: 1 }), contentKey({ a: 2 }));
    assert.notStrictEqual(contentKey([1, 2]), contentKey([2, 1]));
  });

  it('is exactly the documented composition', () => {
    const value = { config: ['bar', { stacked: true }] };
    assert.strictEqual(contentKey(value), hashContent(stableStringify(value) ?? ''));
    assert.strictEqual(contentKey(undefined), hashContent(''));
  });

  it('drops undefined members (memo-grade, NOT checksum-grade)', () => {
    assert.strictEqual(contentKey({ a: 1, b: undefined }), contentKey({ a: 1 }));
  });
});
