//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import {
  parseMarkdown, createIncrementalParser, toMarkdown, toHtml, mdToVnode,
  walkAst, isContainerNode,
} from '@jarenjs/md';
import { createMdComponent } from '@jarenjs/md/component';
import { renderToString } from '@jarenjs/view';

const MARKER = '<!-- pagebreak -->';
const BREAK = { type: 'pageBreak' };
const HTML = '<div class="md-page-break" role="separator" aria-label="Page break"></div>';
const schema = JSON.parse(readFileSync(new URL('../../components/md/schemas/jaren-md-ast.schema.json', import.meta.url), 'utf8'));

describe('page-break markers', function () {
  it('recognizes standalone markers as core blocks, including inside containers', function () {
    for (const gfm of [true, false]) {
      for (const marker of [MARKER, '<!--pagebreak-->', '   <!--\tpagebreak\t-->  ']) {
        assert.deepEqual(parseMarkdown(marker, { gfm }).ast, [BREAK]);
      }
    }
    const doc = parseMarkdown('before\n' + MARKER + '\nafter');
    assert.deepEqual(doc.ast.map((node) => node.type), ['paragraph', 'pageBreak', 'paragraph']);
    assert.deepEqual(doc.ast[1], BREAK);
    assert.equal(isContainerNode(doc.ast[1]), false);
    for (const source of ['> ' + MARKER, '- ' + MARKER, '[^n]: ' + MARKER]) {
      const found = [];
      walkAst(parseMarkdown(source).ast, (node) => { if (node.type === 'pageBreak') found.push(node); });
      assert.deepEqual(found, [BREAK], source);
    }
  });

  it('leaves code, inline comments and other HTML opaque', function () {
    for (const source of [
      '```md\n' + MARKER + '\n```', '    ' + MARKER, '`' + MARKER + '`',
      'before ' + MARKER + ' after', '\\' + MARKER, '&lt;!-- pagebreak -->',
      '<!-- PAGEBREAK -->', '<!-- pagebreak extra -->', '<!-- pagebreak',
      '<!--\npagebreak\n-->', MARKER + ' trailing', MARKER + MARKER,
      '<div>\n' + MARKER + '\n</div>', '<!-- outer\n' + MARKER,
      '| column |\n| --- |\n| ' + MARKER + ' |',
    ]) {
      walkAst(parseMarkdown(source).ast, (node) => { assert.notEqual(node.type, 'pageBreak', source); });
    }
    assert.deepEqual(parseMarkdown('before ' + MARKER + ' after').ast[0].children[1],
      { type: 'html', value: MARKER });
    assert.deepEqual(parseMarkdown('<div>\n' + MARKER + '\n</div>').ast,
      [{ type: 'html', value: '<div>\n' + MARKER + '\n</div>' }]);
  });

  it('round-trips and streams without dropping adjacent or final markers', function () {
    assert.equal(toMarkdown(parseMarkdown('<!--pagebreak-->')), MARKER + '\n');
    for (const source of [
      MARKER, MARKER + '\n' + MARKER, 'before\r\n' + MARKER + '\r\nafter',
      '> first\n> ' + MARKER + '\n> last', '- first\n  ' + MARKER + '\n  last',
    ]) {
      const doc = parseMarkdown(source);
      const canonical = toMarkdown(doc);
      assert.deepEqual(parseMarkdown(canonical).ast, doc.ast);
      assert.equal(toMarkdown(parseMarkdown(canonical)), canonical);
      for (const size of [1, 7, source.length]) {
        const parser = createIncrementalParser({});
        const emitted = [];
        for (let i = 0; i < source.length; i += size) emitted.push(...parser.feed(source.slice(i, i + size)));
        const streamed = parser.end();
        assert.deepEqual(streamed, doc);
        for (let i = 0; i < emitted.length; i++) assert.equal(emitted[i], streamed.ast[i]);
      }
    }
  });

  it('validates as a block and cannot pass as an inline extension node', function () {
    const validate = new JarenValidator().compile(schema);
    const doc = parseMarkdown(MARKER);
    assert.equal(validate(doc), true);
    assert.equal(validate({ ...doc, ast: [{ type: 'blockquote', children: [BREAK] }] }), true);
    assert.equal(validate({ ...doc, ast: [{ type: 'paragraph', children: [BREAK] }] }), false);
  });

  it('renders through both emitters and the component independently of raw-HTML policy', function () {
    const source = 'before\n' + MARKER + '\nafter';
    const doc = parseMarkdown(source);
    const expected = '<p>before</p>' + HTML + '<p>after</p>';
    for (const html of /** @type {const} */ (['escape', 'skip', 'raw'])) {
      assert.equal(toHtml(doc, { html }), expected);
    }
    for (const html of /** @type {const} */ (['skip', 'text', 'vnode'])) {
      assert.equal(renderToString(mdToVnode(doc, { html })), '<article class="md">' + expected + '</article>');
      const md = createMdComponent({ html });
      const vnode = md.view(source);
      assert.equal(renderToString(vnode), '<article class="md">' + expected + '</article>');
      assert.equal(md.view(source), vnode);
      assert.equal(renderToString(md.view(doc)), renderToString(vnode));
      assert.equal(md.compile(source).doc.ast[1].type, 'pageBreak');
    }
  });
});
