//@ts-check
/**
 * @file The directive layer: comment-carried data that a machine derives
 * and a human reads, and `bake`, which writes the derived value back
 * into the source.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseMarkdown, toHtml, mdToVnode, bake,
  scanDirectives, scanSourceDirectives, replaceDirectives, parseMarker,
} from '@jarenjs/md';
import { renderToString } from '@jarenjs/view';

const parse = (src) => parseMarkdown(src, { frontmatter: false });
const keysOf = (result) => result.directives.map((d) => d.key);

/** The documents the benchmark-facts gate rewrites. */
const DOCS = [
  'README.md',
  'docs/ROADMAP.md',
  'components/md/README.md',
  'components/mermaid/README.md',
  'packages/flow/README.md',
  'packages/view/README.md',
  'packages/josl/README.md',
];
const read = (rel) => readFileSync(fileURLToPath(new URL('../../' + rel, import.meta.url)), 'utf8');

describe('the marker grammar', function () {
  it('classifies openers and closers, and nothing else', function () {
    assert.deepEqual(parseMarker('<!--bm:a.b-->'), { ns: 'bm', key: 'a.b', closing: false });
    assert.deepEqual(parseMarker('<!--/bm-->'), { ns: 'bm', key: '', closing: true });
    assert.deepEqual(parseMarker('<!--mdx:$.x[0]-->'), { ns: 'mdx', key: '$.x[0]', closing: false });
    // the payload is opaque to this layer — a query expression is as
    // valid as a fact key, which is what lets two consumers share it
    assert.equal(parseMarker('<!--bm:-->').key, '');
    for (const not of ['<!-- bm:a -->', '<!--BM:a-->', '<!--1x:a-->', '<!--just a comment-->',
      '<!--bm-->', 'bm:a', '<!--bm:a--><!--/bm-->']) {
      assert.equal(parseMarker(not), null, `${not} is not a marker`);
    }
  });
});

describe('scanDirectives', function () {
  it('finds a block directive and the blocks it wraps', function () {
    const doc = parse('intro\n\n<!--bm:t-->\n| a |\n| - |\n| 1 |\n<!--/bm-->\n\nafter\n');
    const { directives, diagnostics } = scanDirectives(doc, { ns: 'bm' });
    assert.deepEqual(diagnostics, []);
    assert.equal(directives.length, 1);
    assert.equal(directives[0].scope, 'block');
    assert.deepEqual(directives[0].path, []);
    assert.deepEqual(directives[0].nodes.map((n) => n.type), ['table']);
  });

  it('finds an inline directive inside a paragraph', function () {
    const { directives } = scanDirectives(parse('Jaren is <!--bm:r-->23.1<!--/bm-->x faster.\n'));
    assert.equal(directives.length, 1);
    assert.equal(directives[0].scope, 'inline');
    assert.deepEqual(directives[0].nodes.map((n) => n.value), ['23.1']);
  });

  it('finds one written inside emphasis, a list item or a table cell', function () {
    // the markers live in the `strong` node's children, not the
    // paragraph's — a walker that only looked one level down missed
    // every directive an author bolded
    assert.deepEqual(keysOf(scanDirectives(parse('A **run of <!--bm:a-->1<!--/bm--> here**.\n'))), ['a']);
    assert.deepEqual(keysOf(scanDirectives(parse('- item <!--bm:b-->2<!--/bm--> tail\n'))), ['b']);
    assert.deepEqual(keysOf(scanDirectives(parse('| h |\n| - |\n| <!--bm:c-->3<!--/bm--> |\n'))), ['c']);
    assert.deepEqual(keysOf(scanDirectives(parse('> quoted <!--bm:d-->4<!--/bm--> text\n'))), ['d']);
  });

  it('returns directives in document order', function () {
    const doc = parse('x <!--bm:one-->1<!--/bm-->\n\n<!--bm:two-->\nblock\n<!--/bm-->\n\ny <!--bm:three-->3<!--/bm-->\n');
    assert.deepEqual(keysOf(scanDirectives(doc, { ns: 'bm' })), ['one', 'two', 'three']);
  });

  it('filters by namespace and leaves the others alone', function () {
    const doc = parse('a <!--bm:x-->1<!--/bm--> and b <!--mdx:$.y-->2<!--/mdx-->\n');
    assert.deepEqual(keysOf(scanDirectives(doc, { ns: 'bm' })), ['x']);
    assert.deepEqual(keysOf(scanDirectives(doc, { ns: 'mdx' })), ['$.y']);
    assert.deepEqual(keysOf(scanDirectives(doc)).sort(), ['$.y', 'x']);
  });

  it('surfaces unpaired markers rather than swallowing them', function () {
    // a stale figure hiding behind a marker nobody matched is the exact
    // failure this layer exists to prevent
    const open = scanDirectives(parse('a <!--bm:x-->1 and no closer\n'), { ns: 'bm' });
    assert.deepEqual(open.directives, []);
    assert.match(open.diagnostics[0], /is never closed/);

    const stray = scanDirectives(parse('a 1<!--/bm--> b\n'), { ns: 'bm' });
    assert.deepEqual(stray.directives, []);
    assert.match(stray.diagnostics[0], /stray/);

    const nested = scanDirectives(parse('a <!--bm:x-->1 <!--bm:y-->2<!--/bm--> z<!--/bm-->\n'), { ns: 'bm' });
    assert.match(nested.diagnostics[0], /do not nest/);
  });

  it('does not pair across a container boundary', function () {
    // an opener in a blockquote and a closer outside it are two unpaired
    // markers, not a directive spanning a boundary the tree lacks
    const doc = parse('> quoted <!--bm:x-->1\n\nafter <!--/bm--> here\n');
    const { directives, diagnostics } = scanDirectives(doc, { ns: 'bm' });
    assert.deepEqual(directives, []);
    assert.equal(diagnostics.length, 2);
  });
});

describe('a directive is invisible to a renderer', function () {
  // The property the whole design rests on: every markdown renderer
  // drops HTML comments, so a marker costs a reader nothing.
  const SRC = 'Jaren is <!--bm:r-->23.1<!--/bm-->x faster.\n\n<!--bm:t-->\nbody\n<!--/bm-->\n';

  it('renders as plain prose through the vnode path', function () {
    const html = renderToString(mdToVnode(parse(SRC)));
    assert.equal(html.includes('<!--'), false);
    assert.equal(html.includes('bm:'), false);
    assert.match(html, /Jaren is 23\.1x faster\./);
    assert.match(html, /<p>body<\/p>/);
  });

  it('and reads identically to the same document with the markers removed', function () {
    const plain = 'Jaren is 23.1x faster.\n\nbody\n';
    assert.equal(renderToString(mdToVnode(parse(SRC))), renderToString(mdToVnode(parse(plain))));
    assert.equal(toHtml(parse(SRC), { html: 'skip' }), toHtml(parse(plain)));
  });
});

describe('replaceDirectives', function () {
  it('replaces a body and returns a new document', function () {
    const doc = parse('x <!--bm:a-->old<!--/bm--> y\n');
    const next = replaceDirectives(doc, { ns: 'bm' }, () => [{ type: 'text', value: 'new' }]);
    assert.notEqual(next, doc);
    assert.match(toHtml(next, { html: 'skip' }), /x new y/);
    assert.match(toHtml(doc, { html: 'skip' }), /x old y/, 'the input is untouched');
  });

  it('keeps untouched subtrees reference-equal', function () {
    const doc = parse('# heading\n\nuntouched paragraph\n\nx <!--bm:a-->old<!--/bm--> y\n');
    const next = replaceDirectives(doc, { ns: 'bm' }, () => [{ type: 'text', value: 'new' }]);
    assert.equal(next.ast[0], doc.ast[0]);
    assert.equal(next.ast[1], doc.ast[1]);
    assert.notEqual(next.ast[2], doc.ast[2]);
  });

  it('returns the input untouched when nothing matches', function () {
    const doc = parse('# nothing here\n');
    assert.equal(replaceDirectives(doc, { ns: 'bm' }, () => []), doc);
  });

  it('leaves a directive alone when the replacer returns undefined', function () {
    const doc = parse('x <!--bm:a-->old<!--/bm--> y\n');
    assert.equal(replaceDirectives(doc, { ns: 'bm' }, () => undefined), doc);
  });
});

describe('bake', function () {
  it('writes the resolved value between the markers, keeping them', function () {
    const src = 'Jaren is <!--bm:r-->0<!--/bm-->x faster.\n';
    const out = bake(src, { ns: 'bm', resolve: () => '23.1' });
    assert.equal(out.text, 'Jaren is <!--bm:r-->23.1<!--/bm-->x faster.\n');
    assert.equal(out.changed, true);
    assert.deepEqual(out.diagnostics, []);
    assert.deepEqual(out.applied, [{ key: 'r', from: '0', to: '23.1' }]);
  });

  it('is idempotent', function () {
    const src = 'a <!--bm:x-->1<!--/bm--> b <!--bm:y-->2<!--/bm-->\n';
    const resolve = (key) => (key === 'x' ? '9' : '8');
    const once = bake(src, { ns: 'bm', resolve });
    const twice = bake(once.text, { ns: 'bm', resolve });
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once.text);
  });

  it('replaces a multi-line block body', function () {
    const src = 'intro\n\n<!--bm:table-->\n| old |\n| --- |\n<!--/bm-->\n\nafter\n';
    const out = bake(src, { ns: 'bm', resolve: () => '\n| a | b |\n| - | - |\n| 1 | 2 |\n' });
    assert.equal(out.text,
      'intro\n\n<!--bm:table-->\n| a | b |\n| - | - |\n| 1 | 2 |\n<!--/bm-->\n\nafter\n');
    // and it re-parses as the table it now spells
    assert.deepEqual(parse(out.text).ast.map((n) => n.type),
      ['paragraph', 'html', 'table', 'html', 'paragraph']);
  });

  it('leaves every byte of a document with no directives of that namespace', function () {
    for (const rel of DOCS) {
      const src = read(rel);
      const out = bake(src, { ns: 'nope', resolve: () => 'x' });
      assert.equal(out.changed, false, rel);
      assert.equal(out.text, src, rel);
      assert.deepEqual(out.diagnostics, [], rel);
    }
  });

  it('rewrites only the bodies of the real documents, never the prose', function () {
    // The reason bake splices SOURCE rather than re-printing: toMarkdown
    // canonicalizes, so re-printing a hand-written README would reflow
    // every list and re-wrap every table — correct markdown, unreviewable
    // diff.
    for (const rel of DOCS) {
      const src = read(rel);
      const out = bake(src, { ns: 'bm', resolve: (key, d) => d.body });
      assert.equal(out.text, src, `${rel} must be byte-identical when every body is unchanged`);
    }
  });

  it('reports a resolver that throws, and bakes the rest', function () {
    const src = 'a <!--bm:bad-->1<!--/bm--> b <!--bm:good-->2<!--/bm-->\n';
    const out = bake(src, {
      ns: 'bm',
      resolve: (key) => { if (key === 'bad') throw new Error('no data'); return '9'; },
    });
    assert.match(out.diagnostics[0], /bad: resolver threw — no data/);
    assert.equal(out.text, 'a <!--bm:bad-->1<!--/bm--> b <!--bm:good-->9<!--/bm-->\n');
  });

  it('names the line-start trap instead of baking a line the renderer will eat', function () {
    // A marker that BEGINS a line opens a CommonMark HTML block, which
    // swallows the rest of that line — the bytes bake fine and the
    // sentence disappears from every rendering. Six markers in this
    // repository were written that way; the gate now says so.
    const src = 'takes\n<!--bm:x-->1<!--/bm-->x the time others take.\n';
    const out = bake(src, { ns: 'bm', resolve: () => '2' });
    assert.equal(out.diagnostics.length, 1);
    assert.match(out.diagnostics[0], /starts a line opens an HTML block/);
    // and it is a real loss, not a theoretical one
    assert.equal(renderToString(mdToVnode(parse(src))).includes('x the time'), false);
  });

  it('ignores a directive shown as an example inside a fence', function () {
    const src = '```md\n<!--bm:x-->1<!--/bm-->\n```\n\nreal: <!--bm:x-->1<!--/bm-->\n';
    const out = bake(src, { ns: 'bm', resolve: () => '2' });
    assert.equal(out.text, '```md\n<!--bm:x-->1<!--/bm-->\n```\n\nreal: <!--bm:x-->2<!--/bm-->\n');
    assert.deepEqual(out.diagnostics, []);
  });

  it('surfaces an unpaired marker without rewriting around it', function () {
    const out = bake('a <!--bm:x-->1 and nothing closes it\n', { ns: 'bm', resolve: () => '2' });
    assert.equal(out.changed, false);
    assert.match(out.diagnostics[0], /is never closed/);
  });
});

describe('scanSourceDirectives', function () {
  it('reports the offsets a rewriter needs', function () {
    const src = 'a <!--bm:x-->body<!--/bm--> b\n';
    const { directives } = scanSourceDirectives(src, { ns: 'bm' });
    assert.equal(directives.length, 1);
    const d = directives[0];
    assert.equal(src.slice(d.bodyStart, d.bodyEnd), 'body');
    assert.equal(src.slice(d.start, d.end), '<!--bm:x-->body<!--/bm-->');
  });

  it('agrees with the AST scanner on every committed document', function () {
    // The two answer different questions — where a directive is, and
    // whether the renderer sees one there — and they must not disagree
    // about how many there are.
    for (const rel of DOCS) {
      const src = read(rel);
      assert.deepEqual(keysOf(scanSourceDirectives(src, { ns: 'bm' })),
        keysOf(scanDirectives(parse(src), { ns: 'bm' })), rel);
    }
  });
});
