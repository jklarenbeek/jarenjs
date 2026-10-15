//@ts-check
/**
 * @file A flowchart's and a class diagram's `click` statement, read into the
 * tree instead of being skipped: the node ids it names, the link or the
 * callback it carries and the tooltip text the author wrote for it.
 *
 * The forms are the ones Mermaid's own grammars accept (the flowchart's
 * `clickStatement` and the class diagram's `CLICK` rules); a line that is not
 * one of them stays what it was before, parse-accepted and left out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { parseMermaid, toMermaid, diagramToVnode } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { JarenValidator } from '@jarenjs/validate';

/** @param {string} source @returns {any} */
const clicksOf = (source) => parseMermaid(source).ast.clicks;

/** @param {Partial<{ ids: string[], href: string|null, target: string|null, call: any, tooltip: string|null }>} over */
const click = (over) => ({ ids: ['A'], href: null, target: null, call: null, tooltip: null, ...over });

describe('flowchart click — the forms Mermaid reads', () => {
  const cases = [
    ['click A "https://x.test/a"', click({ href: 'https://x.test/a' })],
    ['click A "https://x.test/a" "Go there"', click({ href: 'https://x.test/a', tooltip: 'Go there' })],
    ['click A "https://x.test/a" _blank', click({ href: 'https://x.test/a', target: '_blank' })],
    ['click A "https://x.test/a" "Go" _top', click({ href: 'https://x.test/a', tooltip: 'Go', target: '_top' })],
    ['click A href "https://x.test/a"', click({ href: 'https://x.test/a' })],
    ['click A href "https://x.test/a" "Go"', click({ href: 'https://x.test/a', tooltip: 'Go' })],
    ['click A href "https://x.test/a" _self', click({ href: 'https://x.test/a', target: '_self' })],
    ['click A href "https://x.test/a" "Go" _parent', click({ href: 'https://x.test/a', tooltip: 'Go', target: '_parent' })],
    ['click A report', click({ call: { name: 'report', args: [] } })],
    ['click A report "Tell me"', click({ call: { name: 'report', args: [] }, tooltip: 'Tell me' })],
    ['click A call report', click({ call: { name: 'report', args: [] } })],
    ['click A call report()', click({ call: { name: 'report', args: [] } })],
    ['click A call report(A, "two words") "Tell"', click({ call: { name: 'report', args: ['A', 'two words'] }, tooltip: 'Tell' })],
    ['click A,B "https://x.test/a" "Both"', click({ ids: ['A', 'B'], href: 'https://x.test/a', tooltip: 'Both' })],
    ['click A "https://x.test/a" "Go";', click({ href: 'https://x.test/a', tooltip: 'Go' })],
  ];
  for (const [line, expected] of cases) {
    it(`reads ${line}`, () => {
      assert.deepEqual(clicksOf(`flowchart LR\n  A --> B\n  ${line}`), [expected]);
    });
  }

  it('keeps every statement in source order, and a flowchart without one has none', () => {
    assert.deepEqual(clicksOf('flowchart LR\n  A --> B'), []);
    assert.deepEqual(clicksOf('flowchart LR\n  A --> B\n  click B "u2"\n  click A cb "t"').map((c) => c.ids[0]), ['B', 'A']);
  });

  it('leaves a line that is not a click statement parse-accepted and out of the tree', () => {
    for (const line of [
      'click A', 'click A href', 'click A href "unclosed', 'click A "u" "t" _sideways',
      'click A call report "tip"', 'click A call (x)', 'click A "u" "t" "third"', 'click A call r(x',
    ]) {
      const doc = parseMermaid(`flowchart LR\n  A --> B\n  ${line}`);
      assert.deepEqual(doc.ast.clicks, [], line);
      assert.deepEqual(doc.ast.nodes.map((n) => n.id), ['A', 'B'], line);
    }
  });
});

describe('class diagram click — the forms Mermaid reads', () => {
  it('reads a link or a call with its tooltip and target', () => {
    const ast = parseMermaid([
      'classDiagram', '  class Foo', '  class Bar',
      '  click Foo href "https://x.test/foo" "Foo docs" _blank',
      '  click Bar call show(Bar) "Show it"',
    ].join('\n')).ast;
    assert.deepEqual(ast.clicks, [
      click({ ids: ['Foo'], href: 'https://x.test/foo', tooltip: 'Foo docs', target: '_blank' }),
      click({ ids: ['Bar'], call: { name: 'show', args: ['Bar'] }, tooltip: 'Show it' }),
    ]);
    assert.deepEqual(ast.classes.map((c) => c.name), ['Foo', 'Bar'], 'a click names a class, it declares none');
  });

  it('does not read the flowchart-only bare forms', () => {
    // Mermaid's class grammar has no `click Foo "url"` and no bare callback
    for (const line of ['click Foo "https://x.test"', 'click Foo report', 'click Foo report "tip"']) {
      assert.deepEqual(parseMermaid(`classDiagram\n  class Foo\n  ${line}`).ast.clicks, [], line);
    }
    assert.deepEqual(parseMermaid('classDiagram\n  class Foo').ast.clicks, []);
  });
});

describe('click — printed back as a fixed point', () => {
  it('prints a flowchart click in its canonical form', () => {
    const doc = parseMermaid([
      'flowchart LR', '  A --> B',
      '  click A "https://x.test/a" "Go" _blank',
      '  click B report',
      '  click A,B call log(A, "two words") "Logged"',
    ].join('\n'));
    const text = toMermaid(doc);
    assert.equal(text, 'flowchart LR\nA\nB\nA --> B\n'
      + 'click A href "https://x.test/a" "Go" _blank\n'
      + 'click B call report()\n'
      + 'click A,B call log(A, two words) "Logged"\n');
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
  });

  it('prints a class click', () => {
    const doc = parseMermaid('classDiagram\n  class Foo\n  click Foo href "https://x.test/foo" "Docs"');
    const text = toMermaid(doc);
    assert.equal(text, 'classDiagram\nclass Foo\nclick Foo href "https://x.test/foo" "Docs"\n');
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
  });

  it('prints a tree written before clicks were read', () => {
    const doc = parseMermaid('flowchart LR\n  A --> B');
    const { clicks, ...older } = doc.ast;
    assert.deepEqual(clicks, []);
    assert.equal(toMermaid({ ...doc, ast: older }), toMermaid(doc));
    const cls = parseMermaid('classDiagram\n  class Foo');
    const { clicks: none, ...olderClass } = cls.ast;
    assert.deepEqual(none, []);
    assert.equal(toMermaid({ ...cls, ast: olderClass }), toMermaid(cls));
  });
});

describe('click — the tooltip reaches the render as text', () => {
  const HOSTILE = '<img src=x onerror=alert(1)> & \'it\'';

  it('carries the tooltip on the node it names, escaped, and never as markup', () => {
    const svg = renderToString(diagramToVnode(`flowchart LR\n  A --> B\n  click A "https://x.test" "${HOSTILE}"`));
    assert.match(svg, /<g class="mm-node" data-id="A"><desc>&lt;img src=x onerror=alert\(1\)&gt; &amp; 'it'<\/desc><rect /);
    assert.ok(!svg.includes('<img'), 'the author text is never markup');
    assert.equal((svg.match(/<desc>/g) ?? []).length, 1, 'only node A carries it');
  });

  it('uses the last tooltip a node is given, and one per id of a multi-id click', () => {
    const svg = renderToString(diagramToVnode('flowchart LR\n  A --> B\n  click A cb "first"\n  click A,B cb "second"'));
    assert.equal((svg.match(/<desc>second<\/desc>/g) ?? []).length, 2);
    assert.ok(!svg.includes('first'));
  });

  it('renders a click without a tooltip byte-identically to the diagram without the line', () => {
    const plain = renderToString(diagramToVnode('flowchart LR\n  A --> B'));
    // the hash keys the root; compare everything but it
    const strip = (s) => s.replace(/mmfc-[0-9a-z]+/g, 'mmfc-');
    for (const line of ['click A "https://x.test"', 'click A cb', 'click A call cb(1)', 'click A ""']) {
      assert.equal(strip(renderToString(diagramToVnode(`flowchart LR\n  A --> B\n  ${line}`))), strip(plain), line);
    }
  });

  it('carries a class click tooltip on its panel', () => {
    const svg = renderToString(diagramToVnode('classDiagram\n  class Foo\n  click Foo href "https://x.test" "Foo <docs>"'));
    assert.match(svg, /<g class="mm-node" data-id="Foo"><desc>Foo &lt;docs&gt;<\/desc><rect /);
  });
});

describe('click — the AST schema', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../components/mermaid/schemas/jaren-mermaid-ast.schema.json', import.meta.url), 'utf8'));
  const validate = new JarenValidator().compile({ $schema: schema.$schema, $ref: '#/$defs/flowchartAst', $defs: schema.$defs });

  it('describes a flowchart click, and accepts a tree written before they were read', () => {
    const { ast } = parseMermaid('flowchart LR\n  A --> B\n  click A "https://x.test" "Go" _blank\n  click B cb');
    assert.equal(ast.clicks.length, 2);
    assert.equal(validate(ast), true);
    const { clicks, ...older } = ast;
    assert.equal(validate(older), true, 'clicks is not required');
    assert.equal(validate({ ...ast, clicks: [{ ...clicks[0], ids: [] }] }), false, 'a click names a node');
    assert.equal(validate({ ...ast, clicks: [{ ...clicks[0], href: null }] }), false, 'a click carries a link or a call');
    assert.equal(validate({ ...ast, clicks: [{ ...clicks[0], target: '_sideways' }] }), false, 'a target is one of four');
  });
});
