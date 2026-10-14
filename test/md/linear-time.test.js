//@ts-check
/**
 * The "linear in input" half of the Markdown performance contract, held
 * for hostile input. Every shape below used to cost time quadratic in its
 * length — each start rescanned the rest of the text, or each closer
 * walked back over every delimiter before it — so quadrupling the input
 * multiplied the parse by sixteen. Each must now grow at most eightfold
 * (under 2.9x per doubling): linear work grows about fourfold, a little
 * more once the larger input outgrows a cache, and quadrupling rather
 * than doubling keeps that margin wide on a loaded host.
 *
 * The guards after the ratios pin the exact output of valid inputs of the
 * same shapes: making a scan cheaper must not change what it finds.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, mdToVnode, parseHtmlFragment, toHtml } from '@jarenjs/md';
import { growthRatio } from '../lib/growth.js';

/** @param {string} s @param {number} n */
const R = (s, n) => s.repeat(n);
/** @param {string} s */
const parse = (s) => parseMarkdown(s);
/** @param {string} s */
const html = (s) => toHtml(parseMarkdown(s, { frontmatter: false }), { html: 'raw' });

/** @type {[string, (n: number) => string, number, (input: string) => unknown][]} */
const SHAPES = [
  ['bare www. runs whose domain never validates', (n) => R('www.a_', n), 2000, parse],
  ['unclosed link destinations', (n) => R('[a](b', n), 2000, parse],
  ['unclosed comments after a stray end tag', (n) => '</' + R('<!--', n), 2000, parse],
  ['unclosed processing instructions', (n) => 'a' + R('<?', n) + 'x>', 2000, parse],
  ['unclosed declarations', (n) => 'a' + R('<!A', n), 2000, parse],
  ['unclosed CDATA sections', (n) => 'a' + R('<![CDATA[', n), 4000, parse],
  ['closers of the other emphasis marker', (n) => R('*a_ ', n), 4000, parse],
  ['brackets and closers that never meet', (n) => R('[ a_', n), 2000, parse],
  ['emphasis closers with no opener at all', (n) => R('a_ ', n), 2000, parse],
  ['closers the rule of three refuses', (n) => 'a**b' + R('c* ', n), 4000, parse],
  ['alternating markers that pair one by one', (n) => R('*_', n) + 'a', 2000, parse],
  ['trailing parentheses after a bare link', (n) => 'www.a.b' + R(')', n), 2000, parse],
  ['links after unclosed brackets', (n) => R('[', n) + R('[a](b)', n), 2000, parse],
  ['brackets nested around a word', (n) => R('[', n) + 'a' + R(']', n), 2000, parse],
  ['list markers nested before a word', (n) => R('- ', n) + 'a', 2000, parse],
  ['a frontmatter flow sequence over many lines', (n) => '---\nx: [\n' + R('a,\n', n) + ']\n---\n', 4000, parse],
  ['a frontmatter flow sequence over many commented lines', (n) => '---\nx: [\n' + R('a, # c\n', n) + ']\n---\n', 4000, parse],
  ['blanks inside a line after a frontmatter opener', (n) => '---\n' + R(' ', n) + 'x\n', 4000, parse],
  ['blanks inside a line after a leading brace', (n) => '{\n' + R(' ', n) + 'x\n', 4000, parse],
  ['an HTML fragment of unterminated tags', (n) => '<div>' + R('<a ', n), 2000,
    (s) => parseHtmlFragment(s)],
  ['an HTML fragment whose `>` sit in quoted values', (n) => R('<a b=">"', n), 1000,
    (s) => parseHtmlFragment(s)],
  ['an HTML fragment of tags sharing one long attribute name', (n) => '<a' + R('<a', n) + '="' + R('x', n), 2000,
    (s) => parseHtmlFragment(s)],
  ['an HTML fragment of end tags matching nothing open', (n) => R('<b>', n) + R('</i>', n), 2000,
    (s) => parseHtmlFragment(s)],
  ['an HTML block of unterminated tags under html: vnode', (n) => '<div>\n' + R('<a ', n), 2000,
    (s) => mdToVnode(parseMarkdown(s), { html: 'vnode', keyed: false })],
  ['inline end tags matching nothing open under html: vnode', (n) => 'x' + R('<b>', n) + R('</i>', n), 2000,
    (s) => mdToVnode(parseMarkdown(s), { html: 'vnode', keyed: false })],
];

describe('md — parse time grows linearly on hostile input', function () {
  for (const [what, make, n, run] of SHAPES) {
    // eight times the input: linear is about 8x, quadratic about 64x; the
    // wide step keeps the ratio readable on a host the gate loads in parallel
    it(`${what}: eight times the input at most multiplies the time by twenty-four`, function () {
      const ratio = growthRatio(run, make(n), make(8 * n), { limit: 24 });
      assert.ok(ratio < 24, `eight times ${what} multiplied the time by ${ratio.toFixed(2)}`);
    });
  }
});

describe('md — the cheaper scans find what they always found', function () {
  it('bare www. links, with underscores, parentheses and nested starts', function () {
    assert.equal(html('www.a_www.example.com'),
      '<p><a href="http://www.a_www.example.com">www.a_www.example.com</a></p>');
    assert.equal(html('www.a_b.c_d.e www.x.y_z'), '<p>www.a_b.c_d.e www.x.y_z</p>');
    assert.equal(html('www.a_b.example.com and _www.example.org_'),
      '<p><a href="http://www.a_b.example.com">www.a_b.example.com</a> and '
      + '<em><a href="http://www.example.org">www.example.org</a></em></p>');
    assert.equal(html('www.example.com/a_(b)_c))'),
      '<p><a href="http://www.example.com/a_(b)_c">www.example.com/a_(b)_c</a>))</p>');
    assert.equal(html('www.a.b)))))'), '<p><a href="http://www.a.b">www.a.b</a>)))))</p>');
    assert.equal(html('www.a.b((x)))'), '<p><a href="http://www.a.b((x))">www.a.b((x))</a>)</p>');
    assert.equal(html('foo@a_b.example and www.a_b.example'),
      '<p><a href="mailto:foo@a_b.example">foo@a_b.example</a> and www.a_b.example</p>');
    assert.equal(html('http://a_http://example.com'),
      '<p>http://a_<a href="http://example.com">http://example.com</a></p>');
    assert.equal(html('www.é.com www.-.x'),
      '<p><a href="http://www.%C3%A9.com">www.é.com</a> <a href="http://www.-.x">www.-.x</a></p>');
  });

  it('bare attribute values after an unterminated tag, which later tags read through tabled stops', function () {
    // the first tag never ends, so the tags after it read where a name,
    // a value or a quote ends from tables built in one backward pass
    assert.deepEqual(parseHtmlFragment('<p a="1 <q class=s title=u>x</q>'),
      ['<p a="1 ', ['q', { class: 's', title: 'u' }, 'x']]);
    assert.deepEqual(parseHtmlFragment('<q class=s title=u>x</q>'), [['q', { class: 's', title: 'u' }, 'x']]);
  });

  it('inline comments, processing instructions, declarations and CDATA', function () {
    assert.equal(html('a <!-- c --> b <!--> <!---> <?pi?> <? x ?> <?> <!DOCTYPE x> <![CDATA[ y ]]> <!-x> <!--x'),
      '<p>a <!-- c --> b <!--> <!---> <?pi?> <? x ?> &lt;?&gt; <!DOCTYPE x> <![CDATA[ y ]]> '
      + '&lt;!-x&gt; &lt;!--x</p>');
    assert.equal(html('a <!-- one --> b <!-- two'), '<p>a <!-- one --> b &lt;!-- two</p>');
  });

  it('emphasis pairing, rule of three and leftover delimiters', function () {
    assert.equal(html('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
    assert.equal(html('**a*'), '<p>*<em>a</em></p>');
    assert.equal(html('a*b**c*'), '<p>a<em>b**c</em></p>');
    assert.equal(html('*_*_a_*_*'), '<p><em>_</em><em>a</em><em>_</em></p>');
    assert.equal(html('***a***'), '<p><em><strong>a</strong></em></p>');
    assert.equal(html('*a_ *b_ c*'), '<p>*a_ <em>b_ c</em></p>');
  });

  it('a link destination nests parentheses 32 deep, as commonmark.js and cmark allow', function () {
    const deep = (k) => R('(', k) + 'b' + R(')', k);
    assert.equal(html(`[a](${deep(32)})`), `<p><a href="${deep(32)}">a</a></p>`);
    assert.equal(html(`[x]: ${deep(32)}\n\n[x]`), `<p><a href="${deep(32)}">x</a></p>`);
  });
});

describe('md — a link destination nesting a 33rd parenthesis is not a link', function () {
  it('neither inline nor in a reference definition', function () {
    const deep = (k) => R('(', k) + 'b' + R(')', k);
    assert.equal(html(`[a](${deep(33)})`), `<p>[a](${deep(33)})</p>`);
    assert.equal(html(`[x]: ${deep(33)}\n\n[x]`), `<p>[x]: ${deep(33)}</p><p>[x]</p>`);
  });
});
