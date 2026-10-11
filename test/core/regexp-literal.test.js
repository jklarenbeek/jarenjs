//@ts-check
/**
 * @file `createRegExp` reads `/source/flags` only when a closing slash is
 * followed by flag letters; every other string, a leading slash included, is
 * the pattern itself. A path pattern such as `/users/[0-9]+` used to throw
 * "Invalid flags", and `v`-mode literals could not be spelled at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRegExp, isStringRegExp } from '@jarenjs/core/string';

describe('createRegExp — slash-led patterns', () => {
  it('reads a pattern that starts with a slash but has no flag tail as a pattern', () => {
    const pattern = createRegExp('/users/[0-9]+');
    assert.ok(pattern);
    assert.strictEqual(pattern.source, '\\/users\\/[0-9]+');
    assert.strictEqual(pattern.flags, 'u');
    assert.strictEqual(pattern.test('x/users/12'), true);
    assert.strictEqual(pattern.test('users/12'), false);
  });

  it('reads a bare unclosed slash pattern as a pattern', () => {
    const pattern = createRegExp('/pattern');
    assert.ok(pattern);
    assert.strictEqual(pattern.test('a/pattern'), true);
    assert.strictEqual(pattern.test('pattern'), false);
    assert.strictEqual(isStringRegExp('/pattern'), true);
  });

  it('still reads /source/flags as a literal', () => {
    assert.strictEqual(createRegExp('/abc/').test('abc'), true);
    assert.strictEqual(createRegExp('/abc/gi').flags, 'giu');
  });

  it('keeps a v-mode literal in v mode instead of adding u', () => {
    const pattern = createRegExp('/[\\p{L}--[a-z]]/v');
    assert.ok(pattern);
    assert.strictEqual(pattern.flags, 'v');
    assert.strictEqual(pattern.test('A'), true);
    assert.strictEqual(pattern.test('a'), false);
  });

  it('still refuses flags the engine refuses', () => {
    assert.throws(() => createRegExp('/a/gg'), SyntaxError);
  });
});
