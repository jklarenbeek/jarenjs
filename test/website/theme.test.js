//@ts-check
/**
 * @file The visitor's theme choice survives a browser that refuses the
 * page its storage: blocked site data throws on access, a full quota
 * throws on write, and either used to take the whole page down at boot.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { readTheme, writeTheme, THEME_KEY } from '../../packages/website/src/lib/theme.js';

const denied = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };

describe('website — the stored theme', () => {
  it('a stored choice wins over the system preference', () => {
    const storage = { getItem: (key) => (key === THEME_KEY ? 'light' : null) };
    assert.strictEqual(readTheme(() => storage, () => true), 'light');
    assert.strictEqual(readTheme(() => ({ getItem: () => 'dark' }), () => false), 'dark');
  });

  it('anything else falls to the system preference', () => {
    for (const stored of [null, '', 'sepia', 'DARK']) {
      assert.strictEqual(readTheme(() => ({ getItem: () => stored }), () => true), 'dark', String(stored));
      assert.strictEqual(readTheme(() => ({ getItem: () => stored }), () => false), 'light', String(stored));
    }
  });

  it('storage that refuses to be reached or read falls to the system preference', () => {
    assert.strictEqual(readTheme(denied, () => true), 'dark');
    assert.strictEqual(readTheme(() => ({ getItem: denied }), () => false), 'light');
  });

  it('a choice is written under its key; a refused write is silent', () => {
    /** @type {Array<[string, string]>} */
    const written = [];
    writeTheme(() => ({ setItem: (key, value) => { written.push([key, value]); } }), 'dark');
    assert.deepStrictEqual(written, [['jaren-theme', 'dark']]);
    assert.doesNotThrow(() => writeTheme(denied, 'dark'));
    assert.doesNotThrow(() => writeTheme(() => ({ setItem: denied }), 'light'));
  });
});
