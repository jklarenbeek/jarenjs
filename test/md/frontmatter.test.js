//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseFrontmatter,
  parseYamlSubset,
  parseTomlSubset,
  parseMarkdown,
  MdFrontmatterError,
} from '@jarenjs/md';

describe('parseFrontmatter: detection', function () {
  it('detects YAML between --- fences', function () {
    const fm = parseFrontmatter('---\ntitle: Hi\n---\nbody');
    assert.equal(fm.lang, 'yaml');
    assert.deepEqual(fm.data, { title: 'Hi' });
    assert.equal(fm.body, 'body');
  });

  it('accepts ... as the YAML closer', function () {
    const fm = parseFrontmatter('---\na: 1\n...\nbody');
    assert.deepEqual(fm.data, { a: 1 });
  });

  it('detects ---json blocks', function () {
    const fm = parseFrontmatter('---json\n{ "a": [1, 2] }\n---\nbody');
    assert.equal(fm.lang, 'json');
    assert.deepEqual(fm.data, { a: [1, 2] });
  });

  it('detects a leading JSON object closed by a bare }', function () {
    const fm = parseFrontmatter('{\n  "title": "Hi"\n}\nbody');
    assert.equal(fm.lang, 'json');
    assert.deepEqual(fm.data, { title: 'Hi' });
    assert.equal(fm.body, 'body');
  });

  it('detects +++ TOML blocks with the built-in subset', function () {
    const fm = parseFrontmatter('+++\ntitle = "Hi"\nn = 3\n+++\nbody');
    assert.equal(fm.lang, 'toml');
    assert.deepEqual(fm.data, { title: 'Hi', n: 3 });
  });

  it('uses an injected TOML parser when provided', function () {
    let called = '';
    const fm = parseFrontmatter('+++\nx = 1\n+++\n', {
      toml: (text) => { called = text; return { injected: true }; },
    });
    assert.deepEqual(fm.data, { injected: true });
    assert.equal(called, 'x = 1\n');
  });

  it('treats an unclosed opener as ordinary Markdown', function () {
    assert.equal(parseFrontmatter('---\nno closer').lang, null);
    assert.equal(parseFrontmatter('{ "not": "closed"').lang, null);
    assert.equal(parseFrontmatter('{ inline } text').lang, null);
    // `---` + text is a setext heading candidate, not frontmatter.
    const doc = parseMarkdown('---\nno closer');
    assert.equal(doc.frontmatter, null);
  });

  it('throws MdFrontmatterError on malformed content in a closed fence', function () {
    assert.throws(() => parseFrontmatter('---json\n{ bad\n---\n'), MdFrontmatterError);
    assert.throws(() => parseFrontmatter('---\n[not: a map\n---\n'), MdFrontmatterError);
  });
});

describe('parseYamlSubset', function () {
  it('parses scalars', function () {
    assert.deepEqual(parseYamlSubset('a: null\nb: ~\nc:\n'), { a: null, b: null, c: null });
    assert.deepEqual(parseYamlSubset('t: true\nf: False\n'), { t: true, f: false });
    assert.deepEqual(parseYamlSubset('i: 42\nn: -3.5\ne: 1e3\n'), { i: 42, n: -3.5, e: 1000 });
    assert.deepEqual(parseYamlSubset('s: plain text\n'), { s: 'plain text' });
    // Outside the subset: strings, not YAML 1.1 specials.
    assert.deepEqual(parseYamlSubset('y: yes\nd: 2024-01-01\n'),
      { y: 'yes', d: '2024-01-01' });
  });

  it('parses quoted strings with escapes', function () {
    assert.deepEqual(parseYamlSubset('a: "x\\n\\"y\\""\nb: \'it\'\'s\'\n'),
      { a: 'x\n"y"', b: "it's" });
  });

  it('parses nested maps and sequences by indentation', function () {
    assert.deepEqual(parseYamlSubset('a:\n  b:\n    c: 1\n  d: 2\n'),
      { a: { b: { c: 1 }, d: 2 } });
    assert.deepEqual(parseYamlSubset('list:\n  - 1\n  - 2\n'), { list: [1, 2] });
    // A sequence at the same indent as its key.
    assert.deepEqual(parseYamlSubset('list:\n- 1\n- 2\n'), { list: [1, 2] });
  });

  it('parses sequence items that are maps', function () {
    assert.deepEqual(parseYamlSubset('items:\n  - name: a\n    n: 1\n  - name: b\n'),
      { items: [{ name: 'a', n: 1 }, { name: 'b' }] });
  });

  it('parses flow collections, multi-line included', function () {
    assert.deepEqual(parseYamlSubset('tags: [a, b, "c d"]\n'), { tags: ['a', 'b', 'c d'] });
    assert.deepEqual(parseYamlSubset('map: {x: 1, y: [2, 3]}\n'), { map: { x: 1, y: [2, 3] } });
    assert.deepEqual(parseYamlSubset('tags: [\n  a,\n  b,\n]\n'), { tags: ['a', 'b'] });
  });

  it('parses block scalars with chomping', function () {
    assert.deepEqual(parseYamlSubset('a: |\n  line1\n  line2\n'), { a: 'line1\nline2\n' });
    assert.deepEqual(parseYamlSubset('a: |-\n  line1\n  line2\n'), { a: 'line1\nline2' });
    assert.deepEqual(parseYamlSubset('a: >-\n  fold\n  ed\n'), { a: 'fold ed' });
  });

  it('strips comments outside quotes', function () {
    assert.deepEqual(parseYamlSubset('# top\na: 1 # tail\nb: "no # comment"\n'),
      { a: 1, b: 'no # comment' });
  });

  it('does not fall into the __proto__ trap', function () {
    const out = parseYamlSubset('__proto__:\n  polluted: 1\n');
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(out.__proto__, { polluted: 1 });
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
  });
});

describe('parseTomlSubset', function () {
  it('parses keys, tables and arrays of tables', function () {
    assert.deepEqual(
      parseTomlSubset('top = 1\n[a.b]\nx = "s"\n[[items]]\nn = 1\n[[items]]\nn = 2\n'),
      { top: 1, a: { b: { x: 's' } }, items: [{ n: 1 }, { n: 2 }] });
  });

  it('parses value types and comments', function () {
    assert.deepEqual(
      parseTomlSubset('i = 1_000\nh = 0xff\nf = -2.5\nb = true # tail\narr = [1, "x", [2]]\ninline = { a = 1, b = "y" }\ndate = 2024-01-01\n'),
      {
        i: 1000, h: 255, f: -2.5, b: true,
        arr: [1, 'x', [2]], inline: { a: 1, b: 'y' },
        date: '2024-01-01',
      });
  });

  it('parses multi-line arrays', function () {
    assert.deepEqual(parseTomlSubset('arr = [\n  1,\n  2,\n]\n'), { arr: [1, 2] });
  });
});

describe('frontmatter on the document', function () {
  it('lands on doc.frontmatter with the lang recorded', function () {
    const doc = parseMarkdown('---\ntitle: T\n---\n# Body');
    assert.deepEqual(doc.frontmatter, { title: 'T' });
    assert.equal(doc.meta.frontmatterLang, 'yaml');
    assert.equal(doc.ast[0].type, 'heading');
  });

  it('can be disabled', function () {
    const doc = parseMarkdown('---\ntitle: T\n---\n', { frontmatter: false });
    assert.equal(doc.frontmatter, null);
    // `---` break, then `title: T` + `---` as a setext heading.
    assert.deepEqual(doc.ast.map((n) => n.type), ['thematicBreak', 'heading']);
  });
});
