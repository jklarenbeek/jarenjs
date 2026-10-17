//@ts-check
/**
 * @file White space at the start of a printed line, and at either edge of a
 * table cell, is dropped by the reader: a paragraph line's one to three
 * leading spaces, a continuation line's after a soft or hard break, and a
 * cell's leading or trailing space or tab. `toMarkdown` prints the outermost
 * one as a character reference, so the text reads back as it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';

/** Every text value of a tree, in order. @param {any} node @param {string[]} [out] */
const texts = (node, out = []) => {
  if (node && typeof node === 'object') {
    if (node.type === 'text') out.push(node.value);
    for (const value of Object.values(node)) if (value && typeof value === 'object') texts(value, out);
  }
  return out;
};

describe('white space at a printed line edge reads back', () => {
  for (const [source, printed] of [
    ['&#32;a', '&#32;a\n'],
    ['&#32;&#32;&#32;a', '&#32;  a\n'],
    ['a\n&#32;b', 'a\n&#32;b\n'],
    ['x  \\\n&#32;b', 'x  \\\n&#32;b\n'],
    ['&#32;&#32;&#32;&#32;a', '&#32;   a\n'],
    ['&#9;a', '&#9;a\n'],
    ['| h |\n|---|\n| &#32;c |', '| h |\n| --- |\n| &#32;c |\n'],
    ['| h |\n|---|\n| c&#32; |', '| h |\n| --- |\n| c&#32; |\n'],
    ['| h |\n|---|\n| &#9;c&#9; |', '| h |\n| --- |\n| &#9;c&#9; |\n'],
  ]) {
    it(JSON.stringify(source), () => {
      const tree = parseMarkdown(source);
      const out = toMarkdown(tree);
      assert.equal(out, printed);
      assert.deepEqual(texts(parseMarkdown(out)), texts(tree));
    });
  }

  it('leaves a line of raw HTML or a code span as it printed', () => {
    for (const source of ['a <span\n  class="x">b</span>', 'a `co\n de` b']) {
      const tree = parseMarkdown(source);
      assert.deepEqual(texts(parseMarkdown(toMarkdown(tree))), texts(tree), source);
    }
  });
});
