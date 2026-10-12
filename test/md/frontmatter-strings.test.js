//@ts-check
/**
 * Quoted strings in frontmatter mean what their escapes say. `\U0001F600`
 * and `\x41` are valid YAML (and TOML names the first) and read back as the
 * letters after the backslash; a `\u` with too few or wrong digits read as
 * whatever digits parsed, or as NUL. In the TOML subset a string followed by
 * more text dropped the rest (`a = "x" y` was `x`), and a one-line
 * `"""ml"""` — valid TOML — read as the empty string with the text gone.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown } from '@jarenjs/md';

/** @param {string} yaml @returns {any} */
const yaml = (yaml) => parseMarkdown(`---\n${yaml}\n---\n`).frontmatter;
/** @param {string} toml @returns {any} */
const toml = (toml) => parseMarkdown(`+++\n${toml}\n+++\n`).frontmatter;

describe('frontmatter strings — escapes', function () {
  it('reads \\x, \\u and \\U as the character their digits name', () => {
    assert.deepEqual(yaml('k: "\\x41\\u00e9\\U0001F600"'), { k: 'Aé😀' });
    assert.deepEqual(yaml('k: "\\ud83d\\ude00"'), { k: '😀' });
    assert.deepEqual(toml('k = "\\U0001F600\\u00e9"'), { k: '😀é' });
  });

  it('refuses an escape without its digits, or past the last character', () => {
    for (const bad of ['"\\u12"', '"\\u12g4"', '"\\xZZ"', '"\\U0001F60"', '"\\U00110000"']) {
      assert.throws(() => yaml(`k: ${bad}`), { name: 'MdFrontmatterError' }, bad);
    }
    assert.throws(() => yaml('k: "\\U00110000"'), { message: /is not a character/ });
    assert.throws(() => yaml('k: "\\u12"'), { message: /needs 4 hexadecimal digits/ });
  });

  it('keeps the escapes it already read', () => {
    assert.deepEqual(yaml('k: "a\\nb\\t\\"c\\\\ \\u0000"'), { k: 'a\nb\t"c\\ \0' });
  });
});

describe('TOML subset — a string is the whole value', function () {
  it('refuses text after a quoted string, and a triple-quoted string', () => {
    assert.throws(() => toml('a = "x" y'), { message: /trailing content after a quoted string/ });
    assert.throws(() => toml("a = 'x' y"), { message: /trailing content after a quoted string/ });
    assert.throws(() => toml('a = """ml"""'), { message: /multi-line strings are not supported/ });
    assert.throws(() => toml("a = '''ml'''"), { message: /multi-line strings are not supported/ });
  });

  it('still reads a string followed by a comment, and the empty strings', () => {
    assert.deepEqual(toml('a = "x" # c\nb = ""\nc = \'\' # c\nd = \'lit\''), { a: 'x', b: '', c: '', d: 'lit' });
  });
});

describe('frontmatter strings — the refusal of a malformed escape names the line and the escape', function () {
  it('names both for a Windows path in double quotes', () => {
    assert.throws(() => yaml('a: 1\nk: "C:\\Users\\me"'), (/** @type {any} */ e) =>
      e.name === 'MdFrontmatterError' && /'\\U' needs 8 hexadecimal digits \(line 2\)/.test(e.message));
  });
});
