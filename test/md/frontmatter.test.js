//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

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

  it('rejects unterminated single and double quoted YAML values at their line', function () {
    for (const quote of ['"', "'"]) {
      assert.throws(() => parseYamlSubset(`ok: 1\nx: ${quote}unterminated`),
        (error) => error instanceof MdFrontmatterError
          && error.line === 1 && error.message.includes('unterminated quoted string'));
    }
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

  it('reads a lone dash as an empty entry unless a deeper block follows it', function () {
    assert.deepEqual(parseYamlSubset('-\n-\n-\n'), [null, null, null]);
    assert.deepEqual(parseYamlSubset('-\n- b\n'), [null, 'b']);
    assert.deepEqual(parseYamlSubset('- # empty\n-\n  - a\n-\n  b: 1\n'), [null, ['a'], { b: 1 }]);
    // a sequence at the same indent belongs to a parent KEY, never to a dash
    assert.deepEqual(parseYamlSubset('key:\n-\n- b\n'), { key: [null, 'b'] });
    assert.deepEqual(parseMarkdown('---\n-\n-\n-\n---\nbody').frontmatter, [null, null, null]);
  });

  it('parses flow collections, multi-line included', function () {
    assert.deepEqual(parseYamlSubset('tags: [a, b, "c d"]\n'), { tags: ['a', 'b', 'c d'] });
    assert.deepEqual(parseYamlSubset('map: {x: 1, y: [2, 3]}\n'), { map: { x: 1, y: [2, 3] } });
    assert.deepEqual(parseYamlSubset('tags: [\n  a,\n  b,\n]\n'), { tags: ['a', 'b'] });
  });

  it('keeps colons inside plain flow values while separating map keys', function () {
    // A parser that stops advancing blocks synchronous test timers too.
    const moduleUrl = new URL('../../components/md/src/frontmatter.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { parseYamlSubset } from ${JSON.stringify(moduleUrl)};
      const read = (source) => {
        try { return parseYamlSubset(source); }
        catch (error) { return error.name; }
      };
      console.log(JSON.stringify([
        read('x: [a:b]'), read('x: {url: http://host}'),
        read('x: [a: b]'), read('x: [}]'),
      ]));
    `], { encoding: 'utf8', timeout: 2500 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [
      { x: ['a:b'] }, { x: { url: 'http://host' } },
      'MdFrontmatterError', 'MdFrontmatterError',
    ]);
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

  it('strips comments on every line of a multi-line flow collection, never inside quotes', function () {
    assert.deepEqual(parseYamlSubset('k: [a, # first\n  b]\n'), { k: ['a', 'b'] });
    assert.deepEqual(parseYamlSubset('k: [a,\n  # a whole line\n  b, # tail\n  ] # after\n'), { k: ['a', 'b'] });
    assert.deepEqual(parseYamlSubset('k: {x: 1, # c\n  y: 2}\n'), { k: { x: 1, y: 2 } });
    assert.deepEqual(parseYamlSubset('k: [\n  # only a comment\n]\n'), { k: [] });
    assert.deepEqual(parseYamlSubset('- [a, # c\n   b]\n'), [['a', 'b']]);
    // a quoted `#` is text, also in a quote spanning lines; `a#b` is one plain value
    assert.deepEqual(parseYamlSubset('k: ["a # not", \'it\'\'s # too\', # c\n  b#c]\n'),
      { k: ['a # not', "it's # too", 'b#c'] });
    assert.deepEqual(parseYamlSubset('k: ["multi\n  line # x", b]\n'), { k: ['multi line # x', 'b'] });
  });

  it('reads a dash after a dash as a nested sequence', function () {
    assert.deepEqual(parseYamlSubset('- - a\n'), [['a']]);
    assert.deepEqual(parseYamlSubset('- - a\n  - b\n- c\n'), [['a', 'b'], 'c']);
    assert.deepEqual(parseYamlSubset('- - - a\n- - b\n'), [[['a']], ['b']]);
    assert.deepEqual(parseYamlSubset('-   - a\n    - b\n'), [['a', 'b']]);
    assert.deepEqual(parseYamlSubset('- - k: v\n    j: w\n'), [[{ k: 'v', j: 'w' }]]);
    assert.deepEqual(parseYamlSubset('- - a: b\n'), [[{ a: 'b' }]]);
    assert.deepEqual(parseYamlSubset('- -\n  - b\n'), [[null, 'b']]);
    assert.deepEqual(parseYamlSubset('k:\n- - a\n'), { k: [['a']] });
    assert.throws(() => parseYamlSubset('- - a\n - b\n'), MdFrontmatterError);
  });

  it('reads a block scalar as a sequence item', function () {
    assert.deepEqual(parseYamlSubset('- |\n  text\n'), ['text\n']);
    assert.deepEqual(parseYamlSubset('- >-\n  a\n  b\n- c\n'), ['a b', 'c']);
    assert.deepEqual(parseYamlSubset('- | # note\n  x\n'), ['x\n']);
    assert.deepEqual(parseYamlSubset('k:\n  - >\n    a\n    b\n'), { k: ['a b\n'] });
    assert.deepEqual(parseYamlSubset('- - |\n    x\n'), [['x\n']]);
    assert.deepEqual(parseYamlSubset('- |\n'), ['']);
  });

  it('refuses content after a flow collection, at its line', function () {
    for (const [source, line] of [
      ['k: [a, b] junk\n', 0], ['k: {a: 1} junk\n', 0], ['k: [a], [b]\n', 0], ['- [a] x\n', 0],
      ['ok: 1\nk: [a,\n  b] junk\n', 2],
    ]) {
      assert.throws(() => parseYamlSubset(/** @type {string} */ (source)), (/** @type {any} */ error) => error instanceof MdFrontmatterError
        && error.line === line && error.message.includes('trailing content after a flow collection'), String(source));
    }
    assert.deepEqual(parseYamlSubset('k: [a, b] # fine\n'), { k: ['a', 'b'] });
  });

  it('reads a tab after the colon as separation, not as part of the value', function () {
    assert.deepEqual(parseYamlSubset('k:\tv\nl: \tw\n'), { k: 'v', l: 'w' });
    assert.deepEqual(parseYamlSubset('k:\t[a]\nq:\t"x"\n'), { k: ['a'], q: 'x' });
    assert.deepEqual(parseYamlSubset('- k:\tv\n'), [{ k: 'v' }]);
    assert.deepEqual(parseYamlSubset('k:\t# c\n  x: 1\n'), { k: { x: 1 } });
  });

  it('reads an empty block scalar as the empty string', function () {
    for (const header of ['|', '>', '|-', '>-']) {
      assert.deepEqual(parseYamlSubset(`k: ${header}\n`), { k: '' }, header);
      assert.deepEqual(parseYamlSubset(`k: ${header}\n\n  \nj: 1\n`), { k: '', j: 1 }, header);
    }
  });

  it('folds a > block scalar as YAML does: an empty line is one break, an indented line keeps its breaks', function () {
    assert.deepEqual(parseYamlSubset('k: >\n  a\n\n  b\n'), { k: 'a\nb\n' });
    assert.deepEqual(parseYamlSubset('k: >\n  a\n\n\n  b\n'), { k: 'a\n\nb\n' });
    assert.deepEqual(parseYamlSubset('k: >-\n  a\n\n  b\n'), { k: 'a\nb' });
    assert.deepEqual(parseYamlSubset('k: >\n\n  a\n  b\n'), { k: '\na b\n' });
    assert.deepEqual(parseYamlSubset('k: >\n  a\n  b\n    c\n  d\n'), { k: 'a b\n  c\nd\n' });
    assert.deepEqual(parseYamlSubset('k: >\n  a\n\n    b\n\n  c\n'), { k: 'a\n\n  b\n\nc\n' });
    assert.deepEqual(parseYamlSubset('- >\n   a\n\n   b\n- c\n'), ['a\nb\n', 'c']);
  });

  it('keeps the blanks a blank line holds past the block scalar\'s indentation', function () {
    assert.deepEqual(parseYamlSubset('k: |\n  a\n   \nj: 1\n'), { k: 'a\n \n', j: 1 });
    assert.deepEqual(parseYamlSubset('k: |-\n  a\n   \n'), { k: 'a\n ' });
    assert.deepEqual(parseYamlSubset('k: >\n  a\n\n   \n  b\n'), { k: 'a\n\n \nb\n' });
    assert.deepEqual(parseYamlSubset('k: >\n    x\n  \n    y\n'), { k: 'x\ny\n' });
  });

  it('refuses a block scalar whose leading blank line reaches past its first line', function () {
    for (const [source, line] of [['k: >\n  \n a\n', 1], ['k: |\n    \n\n  a\n', 1], ['- |\n  \n a\n', 1]]) {
      assert.throws(() => parseYamlSubset(/** @type {string} */ (source)), (/** @type {any} */ error) => error instanceof MdFrontmatterError
        && error.line === line && error.message.includes('blank line before the first line of a block scalar'), String(source));
    }
    assert.deepEqual(parseYamlSubset('k: |\n  \n  a\n'), { k: '\na\n' });
  });

  it('refuses a sequence entry where YAML allows none: on its key\'s line, or inside a flow collection', function () {
    for (const source of ['k: - a\n', 'k: -\n', 'k: -  # c\n', '- k: - a\n']) {
      assert.throws(() => parseYamlSubset(source), (/** @type {any} */ error) => error instanceof MdFrontmatterError
        && error.message.includes('a sequence entry cannot start on the line of its key'), source);
    }
    for (const source of ['k: [- a]\n', 'k: {a: - v}\n', 'k: [a,\n  -\n  b]\n']) {
      assert.throws(() => parseYamlSubset(source), (/** @type {any} */ error) => error instanceof MdFrontmatterError
        && error.message.includes('a sequence entry inside a flow collection'), source);
    }
    // a dash that opens no entry is text
    assert.deepEqual(parseYamlSubset('k: [-, -1, -a, a - b, --]\nj: {a: -}\nl: -a\n'),
      { k: ['-', -1, '-a', 'a - b', '--'], j: { a: '-' }, l: '-a' });
  });

  it('ends a block scalar at a line indented less than its first one', function () {
    // a comment there is a comment; anything else is out of place
    assert.deepEqual(parseYamlSubset('k: |\n   a\n  # a comment\nj: 1\n'), { k: 'a\n', j: 1 });
    for (const source of ['k: |\n   a\n  b\n', 'k: |\n  a\n b\nj: 1\n', 'k: >\n   a\n  b\n', '- |\n   a\n  b\n', '- |\n  a\n - b\n']) {
      assert.throws(() => parseYamlSubset(source), MdFrontmatterError, JSON.stringify(source));
    }
  });

  it('refuses content after a quoted scalar, at its line', function () {
    for (const [source, line] of [['k: "a" junk\n', 0], ["ok: 1\nk: 'a' b\n", 1], ['- "a" b\n', 0]]) {
      assert.throws(() => parseYamlSubset(/** @type {string} */ (source)), (/** @type {any} */ error) => error instanceof MdFrontmatterError
        && error.line === line && error.message.includes('trailing content after a quoted string'), String(source));
    }
    // a comment may follow, even with no blank before its `#`
    assert.deepEqual(parseYamlSubset('k: "a" # c\nj: \'b\'  \nl: "c"#d\n'), { k: 'a', j: 'b', l: 'c' });
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

  it('keeps continuation values after comments in multi-line arrays', function () {
    assert.deepEqual(parseTomlSubset('values = [1, # first\n # comment-only line\n 2,\n "# text",\n 3]'),
      { values: [1, 2, '# text', 3] });
  });

  it('rejects unterminated single and double quoted TOML values at their line', function () {
    for (const quote of ['"', "'"]) {
      assert.throws(() => parseTomlSubset(`ok = 1\nx = ${quote}unterminated`),
        (error) => error instanceof MdFrontmatterError
          && error.line === 1 && error.message.includes('unterminated quoted string'));
    }
  });

  it('treats inherited table names as own data in dotted keys and table headers', function () {
    const name = 'jarenFrontmatterOwnKeyProbe';
    const nested = 'jarenFrontmatterNestedProbe';
    const fixtures = [
      [`__proto__.${name} = 7`, false],
      [`[__proto__]\n${name} = 7`, false],
      [`[[__proto__]]\n${name} = 7`, true],
      [`[__proto__.${nested}]\n${name} = 7`, 'nested'],
    ];
    for (const [source, shape] of fixtures) {
      try {
        const out = parseTomlSubset(source);
        assert.ok(Object.hasOwn(out, '__proto__'));
        assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
        const expected = { [name]: 7 };
        assert.deepEqual(out.__proto__, shape === true ? [expected]
          : shape === 'nested' ? { [nested]: expected } : expected);
        assert.strictEqual(Object.hasOwn(Object.prototype, name), false);
        assert.deepEqual(parseTomlSubset(source), out);
      }
      finally {
        delete Object.prototype[name];
        delete Object.prototype[nested];
      }
    }
    assert.deepEqual(parseTomlSubset('[constructor]\nx = 1'), { constructor: { x: 1 } });
  });

  it('preserves sibling dotted keys in inline tables', function () {
    const source = 'point = { x.a = 1, x.b = 2, y.c = 3 }';
    const expected = { point: { x: { a: 1, b: 2 }, y: { c: 3 } } };
    assert.deepEqual(parseTomlSubset(source), expected);
    assert.deepEqual(parseTomlSubset(source), expected);
    assert.throws(() => parseTomlSubset('point = { x = 1, x.a = 2 }'), MdFrontmatterError);
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
