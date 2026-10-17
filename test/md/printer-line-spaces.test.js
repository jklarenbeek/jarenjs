//@ts-check
/**
 * @file White space at the start of a printed line, and at either edge of a
 * table cell or an ATX heading, is dropped by the reader: a paragraph line's
 * one to three leading spaces, a continuation line's after a soft or hard
 * break, and a cell's or a heading's leading or trailing space or tab.
 * `toMarkdown` prints the outermost one as a character reference, so the
 * text reads back as it was, and `onLossy` hears of no loss. White space
 * at the end of a printed line is dropped too, and two spaces before a soft
 * break read back as a hard break: a text that ends a line (before a soft
 * break, or last in a paragraph or a setext heading line) prints its last
 * space as a reference. Raw HTML and code spans print as they are. A line
 * break where a block prints one line (a table cell, an ATX heading) is
 * named to `onLossy`, and a fence's info string prints the white space its
 * reader would trim or split on as a reference.
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
    ['# &#32;a', '# &#32;a\n'],
    ['# a&#32;', '# a&#32;\n'],
    ['### &#9;a&#32;&#32;', '### &#9;a &#32;\n'],
    ['&#32;a\n===', '# &#32;a\n'],
    ['# &#32;*a*', '# &#32;*a*\n'],
    ['# a&#32;#', '# a \\#\n'],
    ['a\n&#32;b\n===', 'a\n&#32;b\n===\n'],
    ['*a\n&#32;b*', '*a\n&#32;b*\n'],
    ['*x* a\n&#32;b', '*x* a\n&#32;b\n'],
    ['> a\n> &#32;b', '> a\n> &#32;b\n'],
  ]) {
    it(JSON.stringify(source), () => {
      const tree = parseMarkdown(source);
      /** @type {unknown[]} */
      const reports = [];
      const out = toMarkdown(tree, { onLossy: (report) => reports.push(report) });
      assert.equal(out, printed);
      assert.deepEqual(parseMarkdown(out).ast, tree.ast);
      assert.deepEqual(reports, []);
    });
  }

  it('leaves a line of raw HTML or a code span as it printed', () => {
    for (const source of ['a <span\n  class="x">b</span>', 'a `co\n de` b']) {
      const tree = parseMarkdown(source);
      assert.deepEqual(texts(parseMarkdown(toMarkdown(tree))), texts(tree), source);
    }
  });
});

describe('white space at the end of a printed line reads back', () => {
  /** @param {any} node @returns {boolean} */
  const holdsBreak = (node) => node !== null && typeof node === 'object'
    && (node.type === 'break' || Object.values(node).some(holdsBreak));

  for (const [source, printed] of [
    ['a\nb&#32;\n===', 'a\nb&#32;\n===\n'],
    ['a&#32;', 'a&#32;\n'],
    ['a&#32;\nb', 'a&#32;\nb\n'],
    ['a&#32;&#32;\nb', 'a &#32;\nb\n'],
    ['a&#32;&#32;&#32;\nb', 'a  &#32;\nb\n'],
    ['a&#32;&#32;', 'a &#32;\n'],
    ['a&#32;&#32;&#32;', 'a  &#32;\n'],
    ['a&#9;\nb', 'a&#9;\nb\n'],
    ['a&#9;', 'a&#9;\n'],
    ['a&#32;&#9;\nb', 'a &#9;\nb\n'],
    ['a&#9;&#32;\nb', 'a&#9;&#32;\nb\n'],
    ['a&#9;&#32;', 'a&#9;&#32;\n'],
    ['&#32;&#32;', '&#32;&#32;\n'],
    ['a\n&#32;&#32;\nb', 'a\n&#32;&#32;\nb\n'],
    ['a&#32;\nb\n===', 'a&#32;\nb\n===\n'],
    ['a\nb&#32;&#32;\n---', 'a\nb &#32;\n---\n'],
    ['a\nb&#9;\n===', 'a\nb&#9;\n===\n'],
    ['*a&#32;*\nb', '*a&#32;*\nb\n'],
    ['**a&#32;**', '**a&#32;**\n'],
    ['~~a&#32;~~\nb', '~~a&#32;~~\nb\n'],
    ['*a&#32;\nb*', '*a&#32;\nb*\n'],
    ['**a *b&#32;&#32;\nc* d**', '**a *b &#32;\nc* d**\n'],
    ['[a&#32;\nb](u)', '[a&#32;\nb](u)\n'],
    ['[a&#32;](u)\nb', '[a ](u)\nb\n'],
    ['> a&#32;', '> a&#32;\n'],
    ['- a&#32;\n- b', '- a&#32;\n- b\n'],
    ['| h |\n|-|\n| a&#32;&#32; |', '| h |\n| --- |\n| a &#32; |\n'],
    ['a <b>&#32;\nc', 'a <b>&#32;\nc\n'],
    ['__****_*__1*__b_ 1__*&#32;\nb', '__\\*\\**_\\__\\_\\_1*__b_ 1__\\*&#32;\nb\n'],
  ]) {
    it(JSON.stringify(source), () => {
      const tree = parseMarkdown(source);
      /** @type {unknown[]} */
      const reports = [];
      const out = toMarkdown(tree, { onLossy: (report) => reports.push(report) });
      assert.equal(out, printed);
      assert.deepEqual(parseMarkdown(out).ast, tree.ast);
      assert.equal(toMarkdown(tree), printed);
      assert.equal(holdsBreak(parseMarkdown(out).ast), false);
      assert.deepEqual(reports, []);
    });
  }

  it('prints a hard break, raw HTML and a code span that end a line as they are', () => {
    for (const [source, printed] of [
      ['a  \nb', 'a\\\nb\n'],
      ['a&#32;  \\\nb', 'a   \\\nb\n'],
      ['a <b> \nc', 'a <b>\nc\n'],
      ['`a `\nb', '`a `\nb\n'],
      ['a `b `', 'a `b `\n'],
    ]) {
      const tree = parseMarkdown(source);
      const out = toMarkdown(tree);
      assert.equal(out, printed, source);
      assert.deepEqual(parseMarkdown(out).ast, tree.ast, source);
    }
    const html = [{ type: 'paragraph', children: [
      { type: 'text', value: 'a ' }, { type: 'html', value: '<b> ' }, { type: 'softBreak' }, { type: 'text', value: 'c' },
    ] }];
    assert.equal(toMarkdown(html), 'a <b> \nc\n');
  });

  it('leaves a table cell, which prints a soft break as a space, to guard its own edges', () => {
    const row = (/** @type {any[]} */ ...children) => ({ type: 'tableRow', children: [{ type: 'tableCell', children }] });
    const table = [{ type: 'table', align: [null], children: [
      row({ type: 'text', value: 'h' }),
      row({ type: 'text', value: 'a ' }, { type: 'softBreak' }, { type: 'text', value: 'b ' }),
    ] }];
    /** @type {any[]} */
    const reports = [];
    assert.equal(toMarkdown(table, { onLossy: (report) => reports.push(report) }), '| h |\n| --- |\n| a  b&#32; |\n');
    assert.deepEqual(reports.map((report) => [report.code, report.path]), [['unread', [0, 1, 0, 0]]]);
  });
});

describe('a line break where a block prints one line is named', () => {
  const t = (/** @type {string} */ value) => ({ type: 'text', value });
  const soft = { type: 'softBreak' };
  /** @param {any[]} ast */
  const lossy = (ast) => {
    /** @type {any[]} */
    const reports = [];
    const text = toMarkdown(ast, { onLossy: (report) => reports.push(report) });
    return { text, reports: reports.map((report) => [report.code, report.path]) };
  };

  it('names a soft or hard break in an ATX heading, with or without a space before it', () => {
    for (const [children, printed, path] of [
      [[t('a '), soft, t('b')], '### a&#32;\nb\n', [0, 1]],
      [[t('a'), soft, t('b')], '### a\nb\n', [0, 1]],
      [[t('a'), { type: 'break' }, t('b')], '### a\\\nb\n', [0, 1]],
      [[{ type: 'emphasis', children: [t('a'), soft, t('b')] }], '### *a\nb*\n', [0, 0, 1]],
      [[t('a '), { type: 'inlineCode', value: 'b\nc' }], '### a `b\nc`\n', [0, 1]],
    ]) {
      const { text, reports } = lossy([{ type: 'heading', depth: 3, children }]);
      assert.equal(text, printed);
      assert.deepEqual(reports, [['unread', path]]);
    }
  });

  it('names a soft break in a table cell, which prints as a space', () => {
    const table = [{ type: 'table', align: [null], children: [
      { type: 'tableRow', children: [{ type: 'tableCell', children: [t('h')] }] },
      { type: 'tableRow', children: [{ type: 'tableCell', children: [t('a'), soft, t('b')] }] },
    ] }];
    assert.deepEqual(lossy(table), { text: '| h |\n| --- |\n| a b |\n', reports: [['unread', [0, 1, 0, 1]]] });
    table[0].children[1].children[0].children = [{ type: 'html', value: '<!--a\nb-->' }];
    assert.deepEqual(lossy(table), { text: '| h |\n| --- |\n| <!--a b--> |\n', reports: [['unread', [0, 1, 0]]] });
  });

  it('names a line break that starts or ends a block\'s content, or a soft break right after another line break', () => {
    const hard = { type: 'break' };
    for (const [children, printed, path] of [
      [[soft, t('b')], '\nb\n', [0, 0]],
      [[t('a'), soft], 'a\n\n', [0, 1]],
      [[t('a'), hard], 'a\\\n\n', [0, 1]],
      [[t('a'), soft, soft, t('b')], 'a\n\nb\n', [0, 2]],
      [[t('a'), hard, soft, t('b')], 'a\\\n\nb\n', [0, 2]],
      [[t('a'), { type: 'strong', children: [t('b'), soft, soft, t('c')] }], 'a**b\n\nc**\n', [0, 1, 2]],
    ]) {
      const { text, reports } = lossy([{ type: 'paragraph', children }]);
      assert.equal(text, printed);
      assert.deepEqual(reports, [['line-edge', path]]);
    }
    assert.deepEqual(lossy([{ type: 'heading', depth: 1, children: [t('a'), soft, soft, t('b')] }]).reports, [['line-edge', [0, 2]]]);
    for (const children of [[hard, t('b')], [t('a'), soft, hard, t('b')], [t('a'), hard, hard, t('b')]]) {
      const { text, reports } = lossy([{ type: 'paragraph', children }]);
      assert.deepEqual(parseMarkdown(text).ast, [{ type: 'paragraph', children }]);
      assert.deepEqual(reports, []);
    }
  });

  it('keeps a setext heading, a paragraph and a parsed table or heading unreported', () => {
    for (const source of ['a\nb\n===', 'a\nb', '# a', '| h |\n|-|\n| a<br>b |']) {
      const { reports } = lossy(parseMarkdown(source).ast);
      assert.deepEqual(reports, [], source);
    }
  });
});

describe('a fence info string reads back with its white space', () => {
  for (const [source, printed] of [
    ['~~~a&#32;\nx\n~~~', '```a&#32;\nx\n```\n'],
    ['~~~&#32;a\nx\n~~~', '```&#32;a\nx\n```\n'],
    ['~~~&#32;\nx\n~~~', '```&#32;\nx\n```\n'],
    ['```a&#32;b\nx\n```', '```a&#32;b\nx\n```\n'],
    ['```a&#32;&#32;b c\nx\n```', '```a&#32;&#32;b c\nx\n```\n'],
    ['```a b&#32;\nx\n```', '```a b&#32;\nx\n```\n'],
    ['```a &#32;b\nx\n```', '```a &#32;b\nx\n```\n'],
    ['```a b&#32;&#32;\nx\n```', '```a b &#32;\nx\n```\n'],
    ['```a&#160;\nx\n```', '```a&#160;\nx\n```\n'],
    ['```&#160;a\nx\n```', '```&#160;a\nx\n```\n'],
    ['```a b&#160;\nx\n```', '```a b&#160;\nx\n```\n'],
    ['```&#9;a\nx\n```', '```&#9;a\nx\n```\n'],
    ['```a b  c\nx\n```', '```a b  c\nx\n```\n'],
    ['~~~`a&#32;\nx\n~~~', '~~~`a&#32;\nx\n~~~\n'],
  ]) {
    it(JSON.stringify(source), () => {
      const tree = parseMarkdown(source);
      /** @type {unknown[]} */
      const reports = [];
      const out = toMarkdown(tree, { onLossy: (report) => reports.push(report) });
      assert.equal(out, printed);
      assert.deepEqual(parseMarkdown(out).ast, tree.ast);
      assert.deepEqual(reports, []);
    });
  }

  it('names a code block with an empty language, or a meta and no language', () => {
    for (const [lang, meta, printed] of [['', null, '```\nx\n```\n'], [null, 'm', '```\nx\n```\n'], ['', 'm', '``` m\nx\n```\n']]) {
      /** @type {any[]} */
      const reports = [];
      const out = toMarkdown([{ type: 'paragraph', children: [{ type: 'text', value: 'p' }] }, { type: 'code', lang, meta, value: 'x' }],
        { onLossy: (report) => reports.push(report) });
      assert.equal(out, 'p\n\n' + printed);
      assert.deepEqual(reports.map((report) => [report.code, report.path]), [['unread', [1]]]);
    }
  });
});
