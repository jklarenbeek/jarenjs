//@ts-check
/**
 * Bounded nesting: untrusted Markdown of any depth or width parses and
 * renders through all four stages — `parseMarkdown`, `mdToVnode`,
 * `toHtml` and `renderToString` — and never reaches an uncoded
 * `RangeError`. Nesting is bounded at parse time (256 block containers,
 * 256 inline containers, 256 kept raw-HTML elements); a marker past the
 * bound is read as literal text, so the deepest tree the parser can build
 * is one every emitter can walk. No assertion here depends on the host's
 * stack size: the inputs are a megabyte deep.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseMarkdown, mdToVnode, toHtml, toMarkdown, parseHtmlFragment, MdFrontmatterError,
} from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';
import { depthOf } from './scaling.js';

/** @param {string} s @param {number} n */
const R = (s, n) => s.repeat(n);
const MB = 1 << 20;

/**
 * Run one source through every stage; returns the stage outputs.
 * @param {string} source @param {any} [vnodeOptions]
 */
function allStages(source, vnodeOptions = {}) {
  const doc = parseMarkdown(source);
  const vnode = mdToVnode(doc, vnodeOptions);
  return { doc, vnode, ssr: renderToString(vnode), html: toHtml(doc) };
}

/**
 * Follow the first child of each `type` node down from `node`, counting.
 * @param {any} node @param {string} type
 * @returns {{ count: number, inner: any }}
 */
function chain(node, type) {
  let count = 0;
  let inner = node;
  while (inner !== undefined && inner.type === type) {
    count++;
    inner = inner.children[0];
  }
  return { count, inner };
}

describe('md — a megabyte of nesting markers passes every stage', function () {
  /** @type {[string, string][]} */
  const INPUTS = [
    ['list markers before a word', R('- ', MB / 2) + 'a'],
    ['list markers alone (a thematic break)', R('- ', MB / 2)],
    ['block quote markers before a word', R('> ', MB / 2) + 'a'],
    ['block quote markers alone', R('> ', MB / 2)],
    ['emphasis runs around a word', R('*', MB / 2) + 'a' + R('*', MB / 2)],
    ['stars alone', R('*', MB)],
    ['open brackets', R('[', MB)],
    ['brackets around a word', R('[', MB / 4) + 'a' + R(']', MB / 4)],
    ['ordered list markers before a word', R('1. ', MB / 3) + 'a'],
  ];
  for (const [what, source] of INPUTS) {
    it(what, function () {
      const { doc, vnode, ssr, html } = allStages(source);
      assert.ok(depthOf(doc.ast) <= 2 * 256 + 8, `AST depth ${depthOf(doc.ast)}`);
      assert.ok(depthOf(vnode) <= 2 * 256 + 8, `vnode depth ${depthOf(vnode)}`);
      assert.equal(typeof ssr, 'string');
      assert.equal(typeof html, 'string');
    });
  }
});

describe('md — a marker past the bound is literal text', function () {
  it('the 257th block quote', function () {
    const { doc, html } = allStages(R('> ', 300) + 'a');
    const { count, inner } = chain(doc.ast[0], 'blockquote');
    assert.equal(count, 256);
    assert.deepEqual(inner, { type: 'paragraph', children: [{ type: 'text', value: R('> ', 44) + 'a' }] });
    assert.ok(html.endsWith('<p>' + R('&gt; ', 44) + 'a</p>' + R('</blockquote>', 256)));
  });

  it('the 129th list, whose list and item would be containers 257 and 258', function () {
    const { doc } = allStages(R('- ', 300) + 'a');
    let lists = 0;
    let node = doc.ast[0];
    while (node.type === 'list') {
      lists++;
      node = node.children[0].children[0];
    }
    assert.equal(lists, 128);
    assert.deepEqual(node, { type: 'paragraph', children: [{ type: 'text', value: R('- ', 172) + 'a' }] });
  });

  it('strong emphasis past 256 levels', function () {
    const { doc } = allStages(R('*', 600) + 'a' + R('*', 600));
    const children = doc.ast[0].children;
    assert.equal(children.length, 3);
    assert.deepEqual(children[0], { type: 'text', value: R('*', 88) });
    assert.deepEqual(children[2], { type: 'text', value: R('*', 88) });
    const { count, inner } = chain(children[1], 'strong');
    assert.equal(count, 256);
    assert.deepEqual(inner, { type: 'text', value: 'a' });
  });

  it('a link counts one level, so its label nests one level less', function () {
    const { doc } = allStages('[' + R('*', 600) + 'a' + R('*', 600) + '](u)');
    const link = doc.ast[0].children[0];
    assert.equal(link.type, 'link');
    assert.equal(link.url, 'u');
    assert.deepEqual(link.children[0], { type: 'text', value: R('*', 90) });
    assert.equal(chain(link.children[1], 'strong').count, 255);
  });

  it('a literal autolink inside the deepest emphasis stays text', function () {
    const { doc } = allStages(R('*', 512) + 'www.example.com' + R('*', 512));
    const { count, inner } = chain(doc.ast[0].children[0], 'strong');
    assert.equal(count, 256);
    assert.deepEqual(inner, { type: 'text', value: 'www.example.com' });
    // one level shallower, the same text is a link
    const shallow = parseMarkdown(R('*', 510) + 'www.example.com' + R('*', 510));
    assert.equal(chain(shallow.ast[0].children[0], 'strong').inner.type, 'link');
  });
});

describe('md — raw HTML nesting is bounded too', function () {
  it('parseHtmlFragment keeps 256 elements and the text inside the rest', function () {
    const out = parseHtmlFragment(R('<b>', 1000) + 'x');
    assert.equal(out.length, 1);
    let levels = 0;
    /** @type {any} */
    let node = out[0];
    while (Array.isArray(node) && node[0] === 'b') {
      levels++;
      node = node[2];
    }
    assert.equal(levels, 256);
    assert.equal(node, 'x');
  });

  it('an HTML block of a megabyte of open tags renders under html: vnode', function () {
    const { ssr } = allStages('<div>\n' + R('<b>', MB / 3), { html: 'vnode' });
    assert.ok(ssr.startsWith('<article class="md"><div>\n<b><b>'));
  });

  it('a paragraph of a megabyte of inline open tags renders under html: vnode', function () {
    const { vnode, ssr } = allStages('x' + R('<b>', MB / 3), { html: 'vnode' });
    assert.ok(depthOf(vnode) <= 256 + 16, `vnode depth ${depthOf(vnode)}`);
    assert.ok(ssr.startsWith('<article class="md"><p>x<b><b>'));
  });
});

describe('md — width is not depth: long runs render without spreading arguments', function () {
  it('a tight list item holding 600k inline nodes', function () {
    const { ssr } = allStages('- ' + R('`a` ', 300000));
    assert.ok(ssr.startsWith('<article class="md"><ul><li><code>a</code> <code>a</code>'));
  });

  it('a paragraph holding 300k inline tags under html: vnode', function () {
    const { ssr } = allStages('x' + R('<br>', 300000), { html: 'vnode' });
    assert.ok(ssr.startsWith('<article class="md"><p>x<br><br>'));
  });

  it('an unknown element wrapping 600k children, in a fragment and in a block', function () {
    const fragment = parseHtmlFragment('<x>' + R('a<br>', 300000) + '</x>');
    assert.equal(fragment.length, 600000);
    assert.deepEqual(fragment.slice(0, 3), ['a', ['br', {}], 'a']);
    const { ssr } = allStages('<div>\n<x>' + R('a<br>', 300000) + '</x>', { html: 'vnode' });
    assert.ok(ssr.startsWith('<article class="md"><div>\na<br>a<br>'));
  });
});

describe('md — frontmatter collections are bounded', function () {
  it('256 levels parse; a deeper one is a frontmatter error, never a RangeError', function () {
    const doc = parseMarkdown('---\nx: ' + R('[', 256) + R(']', 256) + '\n---\n');
    assert.equal(depthOf(doc.frontmatter), 257);
    for (const depth of [257, 20000, MB / 2]) {
      assert.throws(() => parseMarkdown('---\nx: ' + R('[', depth) + R(']', depth) + '\n---\n'),
        (/** @type {any} */ err) => err instanceof MdFrontmatterError
          && /nest deeper than 256/.test(err.message) && err.line === 0);
      assert.throws(() => parseMarkdown('---\nx: ' + R('{a: ', depth) + R('}', depth) + '\n---\n'),
        (/** @type {any} */ err) => err instanceof MdFrontmatterError && /nest deeper than 256/.test(err.message));
    }
  });

  it('YAML block collections nest at most 256 deep: the 257th is the same refusal at its line', function () {
    /** `-` at indent 0, 1, … n − 1: n sequences, each the lone entry of the one before. */
    const dashes = (/** @type {number} */ n) => '---\n' + Array.from({ length: n }, (_, i) => R(' ', i) + '-').join('\n') + '\n---\n';
    /** `k:` at indent 0, 1, … n − 1: n maps, each the value of the one before. */
    const keys = (/** @type {number} */ n) => '---\n' + Array.from({ length: n }, (_, i) => R(' ', i) + 'k:').join('\n') + '\n---\n';
    for (const n of [255, 256]) {
      assert.deepEqual([depthOf(parseMarkdown(dashes(n)).frontmatter), depthOf(parseMarkdown(keys(n)).frontmatter)], [n, n]);
    }
    for (const source of [dashes(257), keys(257)]) {
      assert.throws(() => parseMarkdown(source), (/** @type {any} */ err) => err instanceof MdFrontmatterError
        && err.message === 'md frontmatter: block collections nest deeper than 256 (line 257)' && err.line === 256);
    }
    /** `- k:` two columns deeper per line: a sequence and a map per line. */
    const items = (/** @type {number} */ n) => '---\n' + Array.from({ length: n }, (_, i) => R('  ', i) + '- k:').join('\n') + '\n---\n';
    for (const source of [dashes(300), keys(300), keys(5000), items(300)]) {
      assert.throws(() => parseMarkdown(source), (/** @type {any} */ err) => err instanceof MdFrontmatterError
        && /block collections nest deeper than 256/.test(err.message));
    }
  });

  it('a dash after a dash opens one more sequence, under the same bound', function () {
    for (const n of [255, 256]) assert.equal(depthOf(parseMarkdown('---\n' + R('- ', n) + 'a\n---\n').frontmatter), n);
    // a megabyte of `- ` on one line is refused at the 257th, not rescanned per level
    for (const n of [257, MB / 2]) {
      assert.throws(() => parseMarkdown('---\n' + R('- ', n) + 'a\n---\n'), (/** @type {any} */ err) => err instanceof MdFrontmatterError
        && err.message === 'md frontmatter: block collections nest deeper than 256 (line 1)' && err.line === 0);
    }
  });

  it('4000 lone dashes are 4000 empty entries of one sequence, not 4000 levels', function () {
    const entries = parseMarkdown('---\n' + R('-\n', 4000) + '---\nbody').frontmatter;
    assert.deepEqual([entries.length, entries.every((/** @type {unknown} */ v) => v === null)], [4000, true]);
  });

  it('the TOML subset bounds its arrays and inline tables the same way', function () {
    assert.equal(depthOf(parseMarkdown('+++\nx = ' + R('[', 256) + R(']', 256) + '\n+++\n').frontmatter), 257);
    for (const depth of [257, 20000]) {
      for (const source of [
        '+++\nx = ' + R('[', depth) + R(']', depth) + '\n+++\n',
        '+++\nx = ' + R('{a = ', depth) + '1' + R('}', depth) + '\n+++\n',
      ]) {
        assert.throws(() => parseMarkdown(source),
          (/** @type {any} */ err) => err instanceof MdFrontmatterError
            && /nest deeper than 256/.test(err.message) && err.line === 0);
      }
    }
  });

  /** `a.a.….a`, `n` segments. @param {number} n */
  const keyPath = (n) => Array(n).fill('a').join('.');
  /** @param {string} text */
  const toml = (text) => '+++\n' + text + '\n+++\n\n# body';
  /** The refusal `source` must raise: `message`, on 0-based `line`. */
  const refusal = (/** @type {string} */ message, /** @type {number} */ line) => (/** @type {any} */ err) =>
    err instanceof MdFrontmatterError && err.message === `md frontmatter: ${message} (line ${line + 1})` && err.line === line;

  it('TOML tables nest at most 256 deep, the root table included, whichever form opens them', function () {
    /** Frontmatter `n` deep through each form: `[[…]]` opens an array and a table on its last segment. */
    const forms = {
      'dotted key': (/** @type {number} */ n) => toml(keyPath(n) + ' = 1'),
      'table header': (/** @type {number} */ n) => toml('[' + keyPath(n - 1) + ']\nx = 1'),
      'array-of-tables header': (/** @type {number} */ n) => toml('[[' + keyPath(n - 2) + ']]\nx = 1'),
    };
    for (const [form, source] of Object.entries(forms)) {
      for (const n of [255, 256]) assert.equal(depthOf(parseMarkdown(source(n)).frontmatter), n, form);
      assert.throws(() => parseMarkdown(source(257)), refusal('tables nest deeper than 256', 0), form);
      assert.throws(() => parseMarkdown(source(20000)), refusal('tables nest deeper than 256', 0), form);
    }
    // the levels a header opened count under the dotted keys that follow it
    assert.equal(depthOf(parseMarkdown(toml('[' + keyPath(200) + ']\n' + keyPath(56) + ' = 1')).frontmatter), 256);
    assert.throws(() => parseMarkdown(toml('[' + keyPath(200) + ']\n' + keyPath(57) + ' = 1')),
      refusal('tables nest deeper than 256', 1));
    // a header that walks through an array of tables counts the array too
    assert.equal(depthOf(parseMarkdown(toml('[[a]]\n[a.' + keyPath(253) + ']')).frontmatter), 256);
    assert.throws(() => parseMarkdown(toml('[[a]]\n[a.' + keyPath(254) + ']')), refusal('tables nest deeper than 256', 1));
  });

  it('dotted keys inside a TOML inline table nest as flow collections', function () {
    for (const n of [255, 256]) {
      assert.equal(depthOf(parseMarkdown(toml('x = {' + keyPath(n) + ' = 1}')).frontmatter), n + 1);
    }
    for (const n of [257, 20000]) {
      assert.throws(() => parseMarkdown(toml('x = {' + keyPath(n) + ' = 1}')), refusal('flow collections nest deeper than 256', 0));
    }
    // a table nested under a dotted key sits below the key's last table
    assert.equal(depthOf(parseMarkdown(toml('x = {' + keyPath(255) + ' = {b = 1}}')).frontmatter), 257);
    assert.throws(() => parseMarkdown(toml('x = {' + keyPath(256) + ' = {b = 1}}')),
      refusal('flow collections nest deeper than 256', 0));
  });

  it('JSON frontmatter nests at most 512 deep, in either form: as deep as a YAML or TOML block reaches', function () {
    const fenced = (/** @type {number} */ n) => '---json\n' + R('[', n) + R(']', n) + '\n---\n\nbody';
    const leading = (/** @type {number} */ n) => '{' + R('"a":{', n - 1) + '"b":1' + R('}', n - 1) + '\n}\n\nbody';
    for (const source of [fenced, leading]) {
      for (const n of [511, 512]) assert.equal(depthOf(parseMarkdown(source(n)).frontmatter), n);
      for (const n of [513, 100000]) {
        assert.throws(() => parseMarkdown(source(n)), refusal('objects and arrays nest deeper than 512', 0));
      }
    }
    // located at the line of the 513th opener
    assert.throws(() => parseMarkdown('---json\n' + R('[\n', 513) + R(']\n', 513) + '---\n'),
      refusal('objects and arrays nest deeper than 512', 512));
  });

  it('a TOML parser passed in is held to the JSON bound', function () {
    /** `n` arrays, each the only item of the one before, built without recursion. @param {number} n */
    const nested = (n) => {
      const root = /** @type {any[]} */ ([]);
      let cur = root;
      for (let i = 1; i < n; i++) cur.push(cur = []);
      return root;
    };
    for (const n of [511, 512]) {
      assert.equal(depthOf(parseMarkdown(toml('x = 1'), { toml: () => ({ x: nested(n - 1) }) }).frontmatter), n);
    }
    for (const n of [513, 100000]) {
      assert.throws(() => parseMarkdown(toml('x = 1'), { toml: () => ({ x: nested(n - 1) }) }),
        refusal("the TOML parser's result nests deeper than 512", 0));
    }
    const cyclic = /** @type {any[]} */ ([]);
    cyclic.push(cyclic);
    assert.throws(() => parseMarkdown(toml('x = 1'), { toml: () => cyclic }),
      refusal("the TOML parser's result nests deeper than 512", 0));
  });

  it('the deepest frontmatter the bounds admit prints, parses back, stringifies and clones', function () {
    // 256 tables holding a flow 256 deep; YAML's 256 maps holding a flow 256 deep
    for (const source of [
      toml('[' + keyPath(255) + ']\nx = ' + R('[', 256) + R(']', 256)),
      '---\n' + Array.from({ length: 256 }, (_, i) => R(' ', i) + 'k:').join('\n') + ' ' + R('[', 256) + R(']', 256) + '\n---\n\n# body',
    ]) {
      const doc = parseMarkdown(source);
      assert.equal(depthOf(doc.frontmatter), 512);
      assert.deepEqual(parseMarkdown(toMarkdown(doc)).frontmatter, doc.frontmatter);
      assert.equal(depthOf(JSON.parse(JSON.stringify(doc.frontmatter))), 512);
      assert.equal(depthOf(structuredClone(doc).frontmatter), 512);
    }
    // the 9 kB dotted key that used to build 4,458 levels
    const repro = toml(keyPath(4458) + ' = 1');
    assert.ok(repro.length > 8900);
    assert.throws(() => parseMarkdown(repro), refusal('tables nest deeper than 256', 0));
  });
});
