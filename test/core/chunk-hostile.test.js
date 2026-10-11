//@ts-check
/**
 * @file `chunkText` refuses the options that used to hang it or return a
 * piece with a NaN end: an empty separator never advanced the cursor, and a
 * NaN size or overlap made every offset NaN.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { chunkText } from '@jarenjs/core/chunk';

describe('chunkText — hostile options', () => {
  it('refuses an empty separator instead of looping (run under a deadline)', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { chunkText } from '@jarenjs/core/chunk';"
      + "try { chunkText('abc', { strategy: 'separator', separator: '' }); console.log('returned'); }"
      + "catch (e) { console.log(e.constructor.name + ': ' + e.message); }"],
    { encoding: 'utf8', timeout: 5000, cwd: process.cwd() });
    assert.strictEqual(result.status, 0, `did not finish: ${result.signal}`);
    assert.strictEqual(result.stdout.trim(), 'TypeError: chunkText separator is a non-empty string');
  });

  it('refuses a non-string separator', () => {
    assert.throws(() => chunkText('abc', { strategy: 'separator', separator: 5 }), TypeError);
  });

  it('refuses a NaN size or overlap', () => {
    assert.throws(() => chunkText('abcdef', { size: NaN }), /size is a number/);
    assert.throws(() => chunkText('abcdef', { size: 'wide' }), TypeError);
    assert.throws(() => chunkText('abcdef', { size: 3, overlap: NaN }), /overlap is a number/);
  });

  it('keeps the documented strategies exact', () => {
    assert.deepStrictEqual(chunkText('abcdef', { size: 4 }).map((p) => p.text), ['abcd', 'ef']);
    assert.deepStrictEqual(chunkText('a\n\nb\n\nc', { strategy: 'separator', size: 3 }).map((p) => p.text),
      ['a\n\n', 'b\n\n', 'c']);
    assert.deepStrictEqual(chunkText(''), []);
    assert.strictEqual(chunkText('abc', { size: Infinity }).length, 1);
  });
});
