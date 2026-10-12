//@ts-check
/**
 * A tab inside code stays a tab. Block structure measures indentation on
 * lines whose tabs are expanded to 4-column stops, and the same expanded
 * line used to be what a code block held: a Makefile recipe or a Go
 * source line came out of a fenced block indented with spaces, and the
 * first four CommonMark tab examples rendered `foo baz     bim` for
 * `foo→baz→→bim`. A tab consumed by the indentation (or by a container
 * marker) is spent; one past it is the content's own. A tab that straddles
 * the boundary is spent in part, and the columns past it read as spaces.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createIncrementalParser, parseMarkdown, toHtml, toMarkdown } from '@jarenjs/md';

/** @param {string} source @returns {any[]} */
const ast = (source) => parseMarkdown(source).ast;

describe('code keeps its tabs', function () {
  it('keeps the tab of a fenced code line', () => {
    assert.equal(ast('```make\nall:\n\tgcc -o x\n```')[0].value, 'all:\n\tgcc -o x\n');
    assert.equal(ast('```\n\t\ta\n  \t b\n```')[0].value, '\t\ta\n  \t b\n');
  });

  it('spends the tab that indents indented code and keeps the tabs after it', () => {
    assert.equal(ast('\tfoo\tbaz\t\tbim')[0].value, 'foo\tbaz\t\tbim\n');
    assert.equal(ast('  \tfoo\tbaz\t\tbim')[0].value, 'foo\tbaz\t\tbim\n');
    assert.equal(ast('    a\ta\n    ὐ\ta')[0].value, 'a\ta\nὐ\ta\n');
    assert.equal(toHtml(parseMarkdown('\tfoo\tbaz\t\tbim')), '<pre><code>foo\tbaz\t\tbim\n</code></pre>');
  });

  it('reads the columns of a tab that a container marker spent in part as spaces', () => {
    assert.equal(ast('> ```\n>\tx\n> ```')[0].children[0].value, '  x\n');
    assert.equal(ast('- a\n\n\t\tcode\tx')[0].children[0].children[1].value, '  code\tx\n');
  });

  it('keeps the tab of a fenced line inside a list item', () => {
    assert.equal(ast('- ```\n  a\tb\n  ```')[0].children[0].children[0].value, 'a\tb\n');
  });

  it('keeps the tab of a line of a raw HTML block', () => {
    assert.deepEqual(ast('<pre>\n\tx\n</pre>'), [{ type: 'html', value: '<pre>\n\tx\n</pre>' }]);
    assert.deepEqual(ast('<div>\ta\n</div>'), [{ type: 'html', value: '<div>\ta\n</div>' }]);
  });

  it('gives the incremental parser the same code in any chunking', () => {
    const source = '```make\nall:\n\tgcc\n```\n\n\tfoo\tbar\n';
    const whole = parseMarkdown(source).ast;
    for (let cut = 1; cut < source.length; cut++) {
      const parser = createIncrementalParser();
      parser.feed(source.slice(0, cut));
      parser.feed(source.slice(cut));
      assert.deepEqual(parser.end().ast, whole, `cut at ${cut}`);
    }
  });

  it('prints code with tabs so it reads back the same', () => {
    for (const source of ['```make\nall:\n\tgcc\n```', '\tfoo\tbaz', '- ```\n  a\tb\n  ```', '> ```\n>\tx\n> ```']) {
      const doc = parseMarkdown(source);
      assert.deepEqual(parseMarkdown(toMarkdown(doc)).ast, doc.ast, source);
    }
    assert.equal(toMarkdown(parseMarkdown('```make\nall:\n\tgcc\n```')), '```make\nall:\n\tgcc\n```\n');
  });

  it('still measures indentation on the expanded line', () => {
    assert.equal(ast('\t- a')[0].type, 'code');
    assert.equal(ast('-\ta\n\tb')[0].type, 'list');
    assert.equal(ast('#\tTitle')[0].type, 'heading');
  });
});

describe('indented code keeps the whitespace of a blank line past its indent', function () {
  it('keeps the two spaces of a six-space line between two chunks', () => {
    assert.equal(ast('    chunk1\n      \n      chunk2\n')[0].value, 'chunk1\n  \n  chunk2\n');
  });

  it('still drops blank lines at the end of the block, whitespace-only ones included', () => {
    assert.equal(ast('    a\n      \n    \n')[0].value, 'a\n');
  });
});
