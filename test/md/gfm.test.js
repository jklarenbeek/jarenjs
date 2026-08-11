//@ts-check
/**
 * @file The GFM extensions: footnotes and literal autolinks (the two
 * MD_04 added), and the corpus that scores all five.
 *
 * The unit tests here are written from the GFM specification's own
 * prose. The last suite is the oracle: the extension sections of the
 * spec, run through both emitters, with the count pinned per section —
 * so a feature this package claims either matches the reference
 * implementation or says by how much it does not.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, toHtml, toMarkdown, mdToVnode, walkAst } from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

import { extractExamples, normalizeHtml } from '../../benchmark/lib/commonmark.js';

/** @param {string} src @param {any} [options] */
const html = (src, options) => toHtml(parseMarkdown(src, { frontmatter: false }), options);

/** Every link in a document, in order. @param {string} src */
function linksOf(src) {
  const out = [];
  walkAst(parseMarkdown(src, { frontmatter: false }).ast, (node) => {
    if (node.type === 'link') {
      out.push({ url: node.url, text: node.children.map((c) => c.value ?? '').join(''), auto: node.auto === true });
    }
  });
  return out;
}

// ------------------------------------------------------------------
// Autolink literals
// ------------------------------------------------------------------

describe('GFM autolink literals — recognition', function () {
  it('links a bare www. host and inserts the scheme', function () {
    assert.deepEqual(linksOf('www.commonmark.org\n'),
      [{ url: 'http://www.commonmark.org', text: 'www.commonmark.org', auto: true }]);
    assert.equal(html('Visit www.commonmark.org/help for more.\n'),
      '<p>Visit <a href="http://www.commonmark.org/help">www.commonmark.org/help</a> for more.</p>');
  });

  it('links the three schemes, and only those', function () {
    for (const scheme of ['http://', 'https://', 'ftp://']) {
      assert.deepEqual(linksOf(scheme + 'x.test/p\n'),
        [{ url: scheme + 'x.test/p', text: scheme + 'x.test/p', auto: true }]);
    }
    // a scheme GFM does not extend stays text; `<gopher://x.test/>` is
    // still an ordinary autolink, which is a different rule
    assert.deepEqual(linksOf('gopher://x.test/p\n'), []);
    // and a written-out `mailto:` is not an email autolink either: the
    // address does not begin at a boundary, the `:` is in the way
    assert.deepEqual(linksOf('mailto:a@b.test\n'), []);
    assert.equal(linksOf('<mailto:a@b.test>\n')[0].url, 'mailto:a@b.test');
  });

  it('requires a valid domain: a period, and no underscore in the last two segments', function () {
    assert.deepEqual(linksOf('www.example\n'), []);
    assert.deepEqual(linksOf('http://localhost/p\n'), []);
    assert.deepEqual(linksOf('www.a_b.test\n'), []);
    assert.deepEqual(linksOf('www.a.b_c.test\n'), []);
    // the underscore rule reaches only the last two segments
    assert.equal(linksOf('www.a_b.c.test\n').length, 1);
  });

  it('only begins at a boundary: text start, whitespace, or one of *_~(', function () {
    for (const before of ['', ' ', '*', '_', '~', '(']) {
      assert.equal(linksOf(before + 'www.a.test\n').length, 1, `after ${JSON.stringify(before)}`);
    }
    for (const before of ['a', '/', '.', '-', '=', '"']) {
      assert.equal(linksOf(before + 'www.a.test\n').length, 0, `after ${JSON.stringify(before)}`);
    }
  });

  it('matches case-sensitively, as the reference implementation does', function () {
    assert.deepEqual(linksOf('WWW.EXAMPLE.COM and HTTP://X.TEST/p\n'), []);
  });

  it('is terminated by `<`', function () {
    assert.equal(html('www.commonmark.org/he<lp\n'),
      '<p><a href="http://www.commonmark.org/he">www.commonmark.org/he</a>&lt;lp</p>');
  });
});

describe('GFM autolink literals — extended path validation', function () {
  it('excludes trailing punctuation, one class at a time', function () {
    for (const mark of ['?', '!', '.', ',', ':', '*', '_', '~']) {
      const links = linksOf(`www.a.test/p${mark}\n`);
      assert.equal(links.length, 1, `for ${mark}`);
      assert.equal(links[0].text, 'www.a.test/p', `for ${mark}`);
    }
    // …but keeps them in the interior
    assert.equal(linksOf('www.a.test/p.q,r:s\n')[0].text, 'www.a.test/p.q,r:s');
    // and strips a run of them
    assert.equal(linksOf('www.a.test/p?!.\n')[0].text, 'www.a.test/p');
  });

  it('excludes a trailing `)` only while the parentheses are unbalanced', function () {
    const cases = [
      ['www.google.com/search?q=Markup+(business)', 'www.google.com/search?q=Markup+(business)', ''],
      ['www.google.com/search?q=Markup+(business)))', 'www.google.com/search?q=Markup+(business)', '))'],
      ['(www.google.com/search?q=Markup+(business))', 'www.google.com/search?q=Markup+(business)', ')'],
      ['(www.google.com/search?q=Markup+(business)', 'www.google.com/search?q=Markup+(business)', ''],
      // the rule fires only on a trailing `)`, so interior imbalance stays
      ['www.google.com/search?q=(business))+ok', 'www.google.com/search?q=(business))+ok', ''],
    ];
    for (const [src, text, tail] of cases) {
      const links = linksOf(src + '\n');
      assert.equal(links.length, 1, `for ${src}`);
      assert.equal(links[0].text, text, `for ${src}`);
      assert.equal(html(src + '\n').endsWith('</a>' + tail + '</p>'), true, `tail for ${src}`);
    }
  });

  it('excludes an entity-shaped tail whole, and a bare `;` not at all', function () {
    // `&hl;` is not an entity, so it survived the inline phase as text
    // and the autolink hands it back — all four characters of it
    assert.equal(html('www.google.com/search?q=commonmark&hl;\n'),
      '<p><a href="http://www.google.com/search?q=commonmark">www.google.com/search?q=commonmark</a>&amp;hl;</p>');
    assert.equal(linksOf('www.google.com/search?q=commonmark&hl=en\n')[0].text,
      'www.google.com/search?q=commonmark&hl=en');
    // a semicolon with no `&` in front of it is ordinary URL punctuation
    assert.equal(linksOf('www.a.test/p;\n')[0].text, 'www.a.test/p;');
  });
});

describe('GFM autolink literals — email addresses', function () {
  it('links an address and adds the mailto: scheme', function () {
    assert.deepEqual(linksOf('foo@bar.baz\n'),
      [{ url: 'mailto:foo@bar.baz', text: 'foo@bar.baz', auto: true }]);
  });

  it('allows `+` before the `@` but not after', function () {
    const links = linksOf("hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.\n");
    assert.deepEqual(links, [
      { url: 'mailto:hello+xyz@mail.example', text: 'hello+xyz@mail.example', auto: true },
    ]);
  });

  it('drops a trailing period, and rejects a trailing `-` or `_` outright', function () {
    assert.equal(linksOf('a.b-c_d@a.b\n')[0].text, 'a.b-c_d@a.b');
    assert.equal(linksOf('a.b-c_d@a.b.\n')[0].text, 'a.b-c_d@a.b');
    // not shortened to `a.b-c_d@a.b` — the whole address fails
    assert.deepEqual(linksOf('a.b-c_d@a.b-\n'), []);
    assert.deepEqual(linksOf('a.b-c_d@a.b_\n'), []);
  });

  it('allows an underscore inside the domain, unlike the www grammar', function () {
    // the two grammars genuinely differ: the email rule says only that
    // the LAST character may not be `_`
    assert.equal(linksOf('foo@a_b.test\n').length, 1);
    assert.equal(linksOf('www.a_b.test\n').length, 0);
  });

  it('finds the local part by walking back to a boundary', function () {
    assert.equal(linksOf('mail (foo@bar.test) now\n')[0].text, 'foo@bar.test');
    assert.deepEqual(linksOf('a/foo@bar.test\n'), []);
    assert.deepEqual(linksOf('@bar.test\n'), []);
  });
});

describe('GFM autolink literals — where they are not looked for', function () {
  it('never nests inside a link', function () {
    assert.equal(html('[www.a.test](/u)\n'), '<p><a href="/u">www.a.test</a></p>');
    assert.equal(html('[see www.a.test here](/u)\n'), '<p><a href="/u">see www.a.test here</a></p>');
  });

  it('leaves code spans and code blocks alone', function () {
    assert.equal(html('`www.a.test`\n'), '<p><code>www.a.test</code></p>');
    assert.equal(html('    www.a.test\n'), '<pre><code>www.a.test\n</code></pre>');
    assert.equal(html('```\nwww.a.test\n```\n'), '<pre><code>www.a.test\n</code></pre>');
  });

  it('reaches every other inline context', function () {
    assert.equal(linksOf('*www.a.test*\n').length, 1);
    assert.equal(linksOf('# head www.a.test\n').length, 1);
    assert.equal(linksOf('> quote www.a.test\n').length, 1);
    assert.equal(linksOf('| c |\n| - |\n| www.a.test |\n').length, 1);
  });
});

// ------------------------------------------------------------------
// Footnotes
// ------------------------------------------------------------------

/** The rendered footnotes section, or '' when there is none. */
function section(src, options) {
  const out = html(src, options);
  const at = out.indexOf('<section class="footnotes"');
  return at === -1 ? '' : out.slice(at);
}

describe('GFM footnotes — parsing', function () {
  it('makes a definition a block that collects, not a paragraph', function () {
    const ast = parseMarkdown('A[^1]\n\n[^1]: The source.\n', { frontmatter: false }).ast;
    assert.equal(ast.length, 2);
    assert.equal(ast[1].type, 'footnoteDefinition');
    assert.equal(ast[1].identifier, '1');
    assert.equal(ast[1].label, '1');
    assert.deepEqual(ast[1].children.map((c) => c.type), ['paragraph']);
    assert.equal(ast[0].children[1].type, 'footnoteReference');
  });

  it('takes indented blocks and lazy continuation, like a list item', function () {
    const ast = parseMarkdown([
      'A[^long]',
      '',
      "[^long]: Here's one with multiple blocks.",
      '',
      '    Subsequent paragraphs are indented to show that they',
      'belong to the previous footnote.',
      '',
      'Back to the document.',
      '',
    ].join('\n'), { frontmatter: false }).ast;
    const def = ast[1];
    assert.equal(def.type, 'footnoteDefinition');
    assert.equal(def.children.length, 2);
    assert.equal(def.children[1].children.map((c) => c.value ?? '\n').join(''),
      'Subsequent paragraphs are indented to show that they\nbelong to the previous footnote.');
    assert.equal(ast[2].type, 'paragraph');
  });

  it('may open with content on the next line, but not after a blank one', function () {
    // the reference implementation lets a blank line continue a
    // definition only once the definition HAS something in it, which is
    // the rule a list item follows too
    const attached = parseMarkdown('A[^1]\n\n[^1]:\n    still mine\n', { frontmatter: false }).ast;
    assert.equal(attached[1].children.length, 1);
    const detached = parseMarkdown('A[^1]\n\n[^1]:\n\n    not mine\n', { frontmatter: false }).ast;
    assert.deepEqual(detached.map((n) => n.type), ['paragraph', 'footnoteDefinition', 'code']);
    assert.equal(detached[1].children.length, 0);
  });

  it('interrupts a paragraph — it is a block, not a leading definition', function () {
    const ast = parseMarkdown('text[^1]\n[^1]: note\n', { frontmatter: false }).ast;
    assert.deepEqual(ast.map((n) => n.type), ['paragraph', 'footnoteDefinition']);
  });

  it('wins over the link reference definition that swallowed it before', function () {
    // `[^1]: url` used to define a link reference named `^1`, which made
    // the whole line disappear; with GFM on it is a footnote
    const on = parseMarkdown('[^1]: single-word\n\ntext\n', { frontmatter: false }).ast;
    assert.deepEqual(on.map((n) => n.type), ['footnoteDefinition', 'paragraph']);
    const off = parseMarkdown('[^1]: single-word\n\ntext\n', { gfm: false, frontmatter: false }).ast;
    assert.deepEqual(off.map((n) => n.type), ['paragraph']);
  });

  it('reads one label grammar on both sides: no whitespace, no brackets', function () {
    for (const label of ['[^my note]', '[^]', '[^a[b]']) {
      const src = `x ${label}\n\n${label}: note\n`;
      const ast = parseMarkdown(src, { frontmatter: false }).ast;
      assert.equal(ast.some((n) => n.type === 'footnoteDefinition'), false,
        `${label} is not a definition`);
      assert.equal(html(src).includes('<sup>'), false, `${label} is not a reference`);
    }
  });

  it('normalizes the identifier the way link labels are normalized', function () {
    const ast = parseMarkdown('A[^FOO]\n\n[^foo]: matched\n', { frontmatter: false }).ast;
    assert.equal(ast[0].children[1].type, 'footnoteReference');
    assert.equal(ast[0].children[1].identifier, 'foo');
    assert.equal(ast[0].children[1].label, 'FOO');
  });

  it('is collected from anywhere in the document, blockquotes included', function () {
    assert.match(section('A[^1]\n\n> [^1]: inside a quote\n'), /inside a quote/);
  });
});

describe('GFM footnotes — rendering', function () {
  it('numbers by first REFERENCE, not by definition order', function () {
    const out = html('B[^b] then A[^a]\n\n[^a]: alpha\n\n[^b]: bravo\n');
    assert.match(out, /B<sup><a href="#user-content-fn-1"/);
    assert.match(out, /A<sup><a href="#user-content-fn-2"/);
    assert.match(section('B[^b] then A[^a]\n\n[^a]: alpha\n\n[^b]: bravo\n'),
      /<li id="user-content-fn-1"><p>bravo/);
  });

  it('renders nothing at all for an uncited definition', function () {
    assert.equal(html('Body.\n\n[^ghost]: never cited\n'), '<p>Body.</p>');
  });

  it('keeps an undefined reference as literal text', function () {
    assert.equal(html('A claim.[^nope] stays.\n'), '<p>A claim.[^nope] stays.</p>');
  });

  it('gives every citation its own landing place and back-reference', function () {
    const out = html('A[^1] B[^1]\n\n[^1]: cited twice\n');
    assert.match(out, /id="user-content-fnref-1"/);
    assert.match(out, /id="user-content-fnref-1-2"/);
    const notes = section('A[^1] B[^1]\n\n[^1]: cited twice\n');
    assert.match(notes, /href="#user-content-fnref-1"/);
    assert.match(notes, /href="#user-content-fnref-1-2"/);
    assert.equal((notes.match(/footnote-backref/g) ?? []).length, 2);
  });

  it('follows slugPrefix when a host sets one, and defaults to GitHub\'s', function () {
    assert.match(html('A[^1]\n\n[^1]: n\n'), /#user-content-fn-1/);
    assert.match(html('A[^1]\n\n[^1]: n\n', { slugPrefix: 'doc-' }), /#doc-fn-1/);
    assert.match(html('A[^1]\n\n[^1]: n\n', { slugPrefix: '' }), /href="#fn-1"/);
  });

  it('puts the back-reference inside the closing paragraph, or in one of its own', function () {
    assert.match(section('A[^1]\n\n[^1]: prose\n'), /<p>prose <a class="footnote-backref"/);
    assert.match(section('A[^1]\n\n[^1]: intro\n\n    ```\n    code\n    ```\n'),
      /<\/code><\/pre><p> <a class="footnote-backref"/);
  });

  it('lands after the last block and inside the fragment', function () {
    const out = html('One.\n\nTwo[^1]\n\n[^1]: n\n');
    assert.equal(out.startsWith('<p>One.</p>'), true);
    assert.equal(out.endsWith('</ol></section>'), true);
    // with a wrapper it is inside it, for the same reason
    assert.equal(html('A[^1]\n\n[^1]: n\n', { wrap: 'main' }).endsWith('</section></main>'), true);
  });

  it('terminates on a cycle, and numbers what the cycle reaches', function () {
    const out = html('Start[^a]\n\n[^a]: see [^b]\n\n[^b]: see [^a]\n');
    assert.equal((out.match(/<li id=/g) ?? []).length, 2);
    assert.match(out, /<li id="user-content-fn-1"><p>see <sup><a href="#user-content-fn-2"/);
    // a footnote citing ITSELF is the same shape, and also terminates
    const self = html('S[^s]\n\n[^s]: see [^s]\n');
    assert.equal((self.match(/<li id=/g) ?? []).length, 1);
  });

  it('names the section for a reader who cannot see it', function () {
    assert.match(html('A[^1]\n\n[^1]: n\n'), /<section class="footnotes" aria-label="Footnotes">/);
    assert.match(html('A[^1]\n\n[^1]: n\n', { footnotesLabel: 'Voetnoten' }), /aria-label="Voetnoten"/);
  });

  it('keeps the vnode memo on a document that HAS footnotes', function () {
    // Numbering is a whole-document property, so it is part of the memo
    // identity — but the collection is memoized on the AST array, which
    // is what keeps re-rendering ONE document reference-stable.
    const doc = parseMarkdown('A[^1]\n\n[^1]: n\n', { frontmatter: false });
    const first = mdToVnode(doc);
    const again = mdToVnode(doc);
    assert.equal(first[2][0], again[2][0], 'the same block emits the same vnode');
    // a document with no footnotes is untouched by any of this
    const plain = parseMarkdown('# H\n', { frontmatter: false });
    assert.equal(mdToVnode(plain)[2][0], mdToVnode(plain)[2][0]);
  });

  it('renders a hand-built reference with no definition as its own text', function () {
    // the parser cannot make this node, but a transform can
    const ast = [{ type: 'paragraph', children: [{ type: 'footnoteReference', identifier: 'x', label: 'x' }] }];
    assert.equal(toHtml(ast), '<p>[^x]</p>');
    assert.equal(renderToString(mdToVnode(ast)), '<article class="md"><p>[^x]</p></article>');
  });
});

// ------------------------------------------------------------------
// The gate
// ------------------------------------------------------------------

describe('the gfm flag gates every one of these behaviours', function () {
  // The whole document, through every surface, with GFM off. These
  // strings are what the package emitted BEFORE footnotes and autolink
  // literals existed — captured at HEAD and pasted here, which is the
  // only way a "nothing changed" claim can be checked by a test.
  const SRC = 'Visit www.example.com.[^1] Mail a@b.test.\n\n[^1]: See http://x.test/p.\n';

  it('emits exactly what it emitted before the features existed', function () {
    const doc = parseMarkdown(SRC, { gfm: false, frontmatter: false });
    assert.equal(toHtml(doc),
      '<p>Visit www.example.com.[^1] Mail a@b.test.</p><p>[^1]: See http://x.test/p.</p>');
    assert.equal(toMarkdown(doc),
      'Visit www.example.com.\\[^1\\] Mail a@b.test.\n\n\\[^1\\]: See http://x.test/p.\n');
    assert.equal(renderToString(mdToVnode(doc)),
      '<article class="md"><p>Visit www.example.com.[^1] Mail a@b.test.</p>'
      + '<p>[^1]: See http://x.test/p.</p></article>');
  });

  it('produces no new node type with gfm off', function () {
    const types = new Set();
    walkAst(parseMarkdown(SRC, { gfm: false, frontmatter: false }).ast, (node) => {
      types.add(node.type);
      if (node.type === 'link' && node.auto === true) types.add('link:auto');
    });
    assert.equal(types.has('footnoteDefinition'), false);
    assert.equal(types.has('footnoteReference'), false);
    assert.equal(types.has('link:auto'), false);
  });

  it('and produces all of them with gfm on', function () {
    const types = new Set();
    walkAst(parseMarkdown(SRC, { frontmatter: false }).ast, (node) => {
      types.add(node.type);
      if (node.type === 'link' && node.auto === true) types.add('link:auto');
    });
    assert.equal(types.has('footnoteDefinition'), true);
    assert.equal(types.has('footnoteReference'), true);
    assert.equal(types.has('link:auto'), true);
  });
});

// ------------------------------------------------------------------
// The oracle
// ------------------------------------------------------------------

const GFM_SPEC = fileURLToPath(new URL('../../benchmark/gfm-spec/test/spec.txt', import.meta.url));

/**
 * The extension sections of the GFM specification, and what this package
 * scores on each. A number below the total is a stated boundary, spelled
 * out in the package README — never a number left to drift.
 */
const EXTENSION_SCORES = [
  ['Tables (extension)', 7, 8],
  ['Task list items (extension)', 2, 2],
  ['Strikethrough (extension)', 2, 2],
  ['Autolinks (extension)', 11, 11],
  ['Disallowed Raw HTML (extension)', 0, 1],
];

const WRAP_OPEN = '<article class="md">';
const EMITTERS = [
  ['toHtml', (src) => toHtml(parseMarkdown(src, { frontmatter: false }), { html: 'raw' })],
  ['mdToVnode', (src) => renderToString(mdToVnode(parseMarkdown(src, { frontmatter: false }), { html: 'vnode' }))
    .slice(WRAP_OPEN.length, -'</article>'.length)],
];

describe('the GFM specification corpus', function () {
  it('scores every extension section, on both emitters', function (t) {
    if (!existsSync(GFM_SPEC)) {
      t.skip("run 'git submodule update --init benchmark/gfm-spec' to enable the GFM corpus");
      return;
    }
    const examples = extractExamples(readFileSync(GFM_SPEC, 'utf8'));
    for (const [name, render] of EMITTERS) {
      for (const [heading, expected, total] of EXTENSION_SCORES) {
        const list = examples.filter((e) => e.section === heading);
        assert.equal(list.length, total, `${heading} holds ${total} examples`);
        let pass = 0;
        const failures = [];
        for (const example of list) {
          let ok = false;
          try {
            ok = normalizeHtml(String(render(example.markdown))) === normalizeHtml(example.html);
          }
          catch { ok = false; }
          if (ok) pass++;
          else failures.push(example.number);
        }
        assert.equal(pass, expected,
          `${name} on ${heading}: ${pass}/${total}, failing ${failures.join(', ')}`);
      }
    }
  });

  it('the two emitters agree on every extension example a vnode can hold', function (t) {
    if (!existsSync(GFM_SPEC)) {
      t.skip("run 'git submodule update --init benchmark/gfm-spec' to enable the GFM corpus");
      return;
    }
    const sections = new Set(EXTENSION_SCORES.map(([heading]) => heading));
    const examples = extractExamples(readFileSync(GFM_SPEC, 'utf8'))
      .filter((e) => sections.has(e.section));
    let compared = 0;
    for (const example of examples) {
      const doc = parseMarkdown(example.markdown, { frontmatter: false });
      let raw = false;
      walkAst(doc.ast, (node) => { if (node.type === 'html') raw = true; });
      if (raw) continue;
      compared++;
      assert.equal(toHtml(doc),
        renderToString(mdToVnode(doc)).slice(WRAP_OPEN.length, -'</article>'.length),
        `emitters differ for GFM example ${example.number}`);
    }
    assert.equal(compared > 15, true, `compared ${compared} examples`);
  });
});
