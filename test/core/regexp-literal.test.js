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

describe('isStringRegExp — a string is a pattern source', () => {
  it('answers what a Unicode-mode pattern source compiles to, not the literal', () => {
    // valid sources whose literal reading carries flags the engine refuses
    assert.strictEqual(isStringRegExp('/a/gg'), true);
    assert.strictEqual(isStringRegExp('/a/uv'), true);
    // no valid Unicode-mode source, but a v-mode literal: still the literal
    assert.strictEqual(isStringRegExp('/[\\p{L}--[a-z]]/v'), true);
    // valid neither way
    assert.strictEqual(isStringRegExp('/[\\p{L}--[a-z]]/'), false);
    assert.strictEqual(isStringRegExp('\\a'), false);
  });

  it('a RegExp is a regular expression; other values are not', () => {
    assert.strictEqual(isStringRegExp(/a/v), true);
    assert.strictEqual(isStringRegExp(null), false);
    assert.strictEqual(isStringRegExp(undefined), false);
    assert.strictEqual(isStringRegExp(/** @type {any} */ (5)), false);
  });

  it('leaves createRegExp reading /source/flags as a literal', () => {
    assert.strictEqual(createRegExp('/a/i')?.test('A'), true);
    assert.throws(() => createRegExp('/a/gg'), SyntaxError);
  });
});
