//@ts-check
/**
 * The printer's output reads back as the document it came from. Emphasis
 * and strong that sit beside or inside each other used to print their
 * delimiters into one run; a list item made of markers alone printed a
 * thematic break; raw HTML that began a continuation line opened an HTML
 * block; a link destination or title holding a backslash, a character
 * reference or a tab printed as it stood and read back decoded; and a
 * paragraph could end where an empty list marker followed it by two
 * spaces. The parser side: a blank line inside a list item holds no code.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, toMarkdown } from '@jarenjs/md';

/**
 * Print, re-parse, and require the same AST and a stable canonical text.
 * @param {string} source @returns {string} the canonical text
 */
function canonical(source) {
  const doc = parseMarkdown(source);
  const text = toMarkdown(doc);
  const again = parseMarkdown(text);
  assert.deepEqual(again.ast, doc.ast, `AST drift for ${JSON.stringify(source)} printed ${JSON.stringify(text)}`);
  assert.equal(toMarkdown(again), text);
  return text;
}

/**
 * Print a hand-built block list and require it to read back unchanged.
 * @param {any[]} ast @returns {string}
 */
function roundTrip(ast) {
  const text = toMarkdown(ast);
  assert.deepEqual(parseMarkdown(text).ast, ast, `AST drift for ${JSON.stringify(text)}`);
  return text;
}

const t = (/** @type {string} */ value) => ({ type: 'text', value });
const p = (/** @type {any[]} */ ...children) => ({ type: 'paragraph', children });
const item = (/** @type {any[]} */ ...children) => ({ type: 'listItem', checked: null, children });
const bullets = (/** @type {any[]} */ ...items) => ({ type: 'list', ordered: false, start: null, tight: true, children: items });

describe('toMarkdown — delimiter runs that would merge are spelled apart', function () {
  it('spells emphasis beside emphasis, strong or a link with the other delimiter', () => {
    assert.equal(canonical('*a*_b_'), '*a*_b_\n');
    assert.equal(canonical('__foo__*[l](/u)*'), '**foo**_[l](/u)_\n');
    assert.equal(canonical('***foo*_foo_'), '\\*\\**foo*_foo_\n');
    assert.equal(canonical('*!*_**_'), '*!*_\\*\\*_\n');
  });

  it('spells emphasis inside emphasis with text between the two the other way', () => {
    assert.equal(canonical('_[*(*!_'), '*\\[_(_!*\n');
    assert.equal(canonical('__bar_*a_b*'), '\\_*bar*_a\\_b_\n');
  });

  it('tries every spelling of a few nested delimiters when the alternating ones fail', () => {
    assert.equal(canonical('__***.***__'), '__***.***__\n');
    assert.equal(canonical('__1***bar***__'), '__1***bar***__\n');
  });

  it('spells strong inside strong with its own delimiter, and leaves a spelling that reads back alone', () => {
    assert.equal(canonical('__**foo**foo__'), '__**foo**foo__\n');
    assert.equal(canonical('**bar**__***__'), '**bar**__\\*\\*\\*__\n');
    assert.equal(canonical('**a *b* c**'), '**a *b* c**\n');
    assert.equal(canonical('_*a*_'), '_*a*_\n');
  });
});

describe('toMarkdown — a list item of markers alone is not a thematic break', function () {
  it('flips the marker of a list that opens an item', () => {
    assert.equal(canonical('* + *'), '- * - \n');
    assert.equal(canonical('- - a'), '- - a\n');
  });

  it('prints a rule inside the second of two adjacent lists apart from its marker', () => {
    const text = roundTrip([bullets(item(p(t('a')))), bullets(item({ type: 'thematicBreak' }))]);
    assert.equal(text, '- a\n\n* ___\n');
  });
});

describe('toMarkdown — raw HTML never opens a block from the middle of a paragraph', function () {
  it('indents a continuation line that starts with a block-opening tag', () => {
    const html = { type: 'html', value: '<!-- c -->' };
    const text = roundTrip([p(t('a'), { type: 'break' }, html, t(' tail'))]);
    assert.equal(text, 'a\\\n    <!-- c --> tail\n');
    assert.equal(roundTrip([p(t('a'), { type: 'softBreak' }, { type: 'html', value: '<div>' }, t('x'))]), 'a\n    <div>x\n');
  });

  it('leaves a tag that cannot interrupt a paragraph where it stands', () => {
    assert.equal(roundTrip([p(t('a'), { type: 'softBreak' }, { type: 'html', value: '<b>' }, t('x'))]), 'a\n<b>x\n');
  });
});

describe('toMarkdown — a destination and a title are escaped the way they are read', function () {
  it('escapes a backslash before punctuation or at the end, and a reference-shaped ampersand', () => {
    assert.equal(canonical('[a](/u\\\\)'), '[a](/u\\\\)\n');
    assert.equal(canonical('[a](&amp;amp;)'), '[a](\\&amp;)\n');
    assert.equal(canonical('[a](/x "q\\\\&amp;amp;")'), '[a](/x "q\\\\\\&amp;")\n');
  });

  it('wraps a destination that starts with an angle bracket', () => {
    assert.equal(canonical('![a](<\\<b>)'), '![a](<\\<b>)\n');
  });

  it('prints a tab or a newline inside a destination, a title or text as a reference', () => {
    const link = (/** @type {string} */ url, /** @type {string|null} */ title) =>
      p({ type: 'link', url, title, children: [t('a')] });
    assert.equal(roundTrip([link('a\tb', 'x\ny')]), '[a](a&#9;b "x&#10;y")\n');
    assert.equal(roundTrip([p(t('a\tb'))]), 'a&#9;b\n');
    assert.equal(canonical('a&#9;b'), 'a&#9;b\n');
  });
});

describe('toMarkdown — an info string and a fence do not run together', function () {
  it('puts a space between a tilde fence and an info string that starts with a tilde', () => {
    assert.equal(canonical('~~~ ~~```[^1]:\nx\n~~~'), '~~~ ~~```[^1]:\nx\n~~~\n');
  });
});

describe('parseMarkdown — blank lines in lists', function () {
  it('does not read a line of spaces after an empty-looking marker as an item that interrupts a paragraph', () => {
    for (const marker of ['*', '1.', '2.  ', '+ \t', '*  ']) {
      const doc = parseMarkdown(`a\n${marker}`);
      assert.equal(doc.ast.length, 1, JSON.stringify(marker));
      assert.equal(doc.ast[0].type, 'paragraph', JSON.stringify(marker));
    }
    assert.deepEqual(parseMarkdown('a\n*  ').ast, parseMarkdown('a\n*').ast);
    assert.equal(canonical('a\n*  '), 'a\n\\*\n');
  });

  it('keeps no whitespace for a blank line inside a code block of a list item', () => {
    const doc = parseMarkdown('- ```\n  a\n    \n  b\n  ```\n');
    assert.equal(doc.ast[0].children[0].children[0].value, 'a\n\nb\n');
    assert.equal(canonical('- ```\n  a\n    \n  b\n  ```\n'), '- ```\n  a\n\n  b\n  ```\n');
  });

  it('keeps the whitespace of a blank line inside a code block of a blockquote', () => {
    assert.equal(parseMarkdown('> ```\n>   \n> ```\n').ast[0].children[0].value, '  \n');
  });
});

describe('toMarkdown — a run no spelling reads back as costs a few parses, not hundreds', function () {
  /** @param {string} unit @returns {number} best of three, in ms, for 200 paragraphs of four units */
  function printing(unit) {
    const paragraph = Array.from({ length: 4 }, () => unit + ' ' + 'plain '.repeat(40)).join(' ');
    const doc = parseMarkdown(Array.from({ length: 200 }, () => paragraph).join('\n\n'));
    let low = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      toMarkdown(doc);
      low = Math.min(low, performance.now() - started);
    }
    return low;
  }

  it('prints eight delimiter nodes that never read back within a small multiple of the cost of ones that do', () => {
    const stubborn = Math.max(printing('**.***1****1'), 0.5);
    const easy = Math.max(printing('**a *b* c**'), 0.5);
    // the read-back check parses each run once; trying every spelling of eight
    // nodes would parse it 260 times, and that is what the ratio refuses
    assert.ok(stubborn / easy < 30, `stubborn ${stubborn.toFixed(1)} ms, easy ${easy.toFixed(1)} ms`);
  });
});
