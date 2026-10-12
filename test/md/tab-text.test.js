//@ts-check
/**
 * A tab inside paragraph, heading and table text is the character the
 * author wrote. Code and HTML blocks already kept theirs; the text of
 * every other block was read from the tab-expanded line, so `a<TAB>b`
 * came out as `a   b`, and a tab before a line end counted toward a
 * hard break.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toHtml, toMarkdown } from '@jarenjs/md';

/**
 * The text values of the first inline run found under a node.
 * @param {any} node @returns {string[]}
 */
function texts(node) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {any} */ n) => {
    if (n.type === 'text') out.push(n.value);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

/** @param {string} source @returns {string[]} */
const textsOf = (source) => texts({ children: parseMarkdown(source).ast });

describe('parseMarkdown — a tab inside text stays a tab', function () {
  it('keeps it in a paragraph, at any column', () => {
    assert.deepEqual(textsOf('a\tb'), ['a\tb']);
    assert.deepEqual(textsOf('foo\tbaz\t\tbim'), ['foo\tbaz\t\tbim']);
    assert.deepEqual(textsOf('ab\tc'), ['ab\tc']);
  });

  it('keeps it in a heading, a setext heading and a table cell', () => {
    assert.deepEqual(textsOf('# a\tb'), ['a\tb']);
    assert.deepEqual(textsOf('# a\tb\t#'), ['a\tb']);
    assert.deepEqual(textsOf('a\tb\n==='), ['a\tb']);
    assert.deepEqual(textsOf('| a\tb |\n|---|\n| c\td |'), ['a\tb', 'c\td']);
  });

  it('keeps it behind a list marker, a quote marker and a lazy continuation', () => {
    assert.deepEqual(textsOf('- a\tb'), ['a\tb']);
    assert.deepEqual(textsOf('> a\tb'), ['a\tb']);
    assert.deepEqual(textsOf('>\ta\tb'), ['a\tb']);
    assert.deepEqual(textsOf('> a\nb\tc'), ['a', 'b\tc']);
    assert.deepEqual(textsOf('a\n\tb\tc'), ['a', 'b\tc']);
    assert.deepEqual(textsOf('- a\n\tb\tc'), ['a', 'b\tc']);
  });

  it('keeps it inside emphasis, a link and a code span', () => {
    assert.deepEqual(textsOf('*a\tb*'), ['a\tb']);
    assert.deepEqual(textsOf('[a\tb](u)'), ['a\tb']);
    assert.deepEqual(parseMarkdown('`a\tb`').ast[0].children[0].value, 'a\tb');
  });

  it('does not count a tab before a line end as a hard break', () => {
    assert.deepEqual(parseMarkdown('a\t\nb').ast[0].children, [
      { type: 'text', value: 'a\t' }, { type: 'softBreak' }, { type: 'text', value: 'b' },
    ]);
    assert.equal(parseMarkdown('a  \nb').ast[0].children[1].type, 'break');
  });

  it('renders the tab the spec shows, without collapsing whitespace', () => {
    assert.equal(
      toHtml(parseMarkdown('\\\t\\A\\a\\ \\3\\φ\\«')),
      '<p>\\\t\\A\\a\\ \\3\\φ\\«</p>',
    );
  });

  it('prints the text back to the same tab', () => {
    for (const source of ['a\tb', '# a\tb', '| a\tb |\n|---|\n| c\td |', '- a\n\tb\tc']) {
      const doc = parseMarkdown(source);
      assert.deepEqual(parseMarkdown(toMarkdown(doc)).ast, doc.ast, JSON.stringify(source));
    }
  });
});
