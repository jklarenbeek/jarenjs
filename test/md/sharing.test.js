//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, compileMarkdown, mdToVnode } from '@jarenjs/md';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { renderToString } from '@jarenjs/view';

describe('structural sharing and reference equality', function () {
  it('identity JSLT returns the document by reference', function () {
    const doc = parseMarkdown('# A\n\npara *em*\n\n- 1\n- 2\n');
    const identity = compileJsltStylesheet([]);
    assert.equal(identity(doc), doc);
    assert.equal(identity(doc.ast), doc.ast);
  });

  it('a partial JSLT transform keeps unmatched subtrees ===', function () {
    const doc = parseMarkdown('# Title\n\nuntouched *para*\n\n- a\n- b\n');
    // Bump every heading one level; touch nothing else.
    const transform = compileJsltStylesheet([
      { match: { path: '$.ast[*]', schema: { properties: { type: { const: 'heading' } }, required: ['type'] } },
        body: { type: 'heading', depth: { $add: ['$.depth', 1] }, children: '$.children' } },
    ], { compileTypeTest: schemaTest });
    const out = transform(doc);
    assert.notEqual(out, doc);
    assert.equal(out.ast[0].depth, 2);
    // The paragraph and list blocks are the same references.
    assert.equal(out.ast[1], doc.ast[1]);
    assert.equal(out.ast[2], doc.ast[2]);
    // Even the transformed heading's children are shared.
    assert.equal(out.ast[0].children, doc.ast[0].children);
  });

  it('mdToVnode memoizes per AST node reference', function () {
    const doc = parseMarkdown('# A\n\npara\n\n- x\n');
    const v1 = mdToVnode(doc);
    const v2 = mdToVnode(doc);
    // Same node references → same block vnode references.
    for (let i = 0; i < v1[2].length; i++) {
      assert.equal(v1[2][i], v2[2][i]);
    }
  });

  it('shared subtrees after a transform emit shared vnodes', function () {
    const doc = parseMarkdown('# T\n\nsame para\n');
    const transform = compileJsltStylesheet([
      { match: { path: '$.ast[*]', schema: { properties: { type: { const: 'heading' } }, required: ['type'] } },
        body: { type: 'heading', depth: 2, children: '$.children' } },
    ], { compileTypeTest: schemaTest });
    const out = transform(doc);
    const before = mdToVnode(doc);
    const after = mdToVnode(out);
    // The untouched paragraph hits the memo: identical vnode reference,
    // which is the patcher's O(1) skip.
    assert.equal(before[2][1], after[2][1]);
    assert.notEqual(before[2][0], after[2][0]);
  });

  it('compiled projections are cached per compiled document', function () {
    const md = compileMarkdown('# A\n\ntext\n');
    assert.equal(md.toVnode(), md.toVnode());
    assert.equal(md.toMarkdown(), md.toMarkdown());
    assert.equal(md.externals(), md.externals());
  });

  it('block vnodes carry stable content-hash keys', function () {
    const doc1 = parseMarkdown('# Same\n\nunique one\n');
    const doc2 = parseMarkdown('other lead\n\n# Same\n');
    const key1 = mdToVnode(doc1)[2][0][1].key;
    const heading2 = mdToVnode(doc2)[2][1];
    assert.equal(typeof key1, 'string');
    assert.equal(heading2[1].key, key1); // same content, same key, any position
    const dup = parseMarkdown('# Same\n\n# Same\n');
    const [a, b] = mdToVnode(dup)[2];
    assert.notEqual(a[1].key, b[1].key); // occurrence counter disambiguates
  });

  it('keyed: false drops the keys and changes nothing else', function () {
    // Keys cost about a quarter of the projection, and a caller that
    // renders once and throws the tree away pays it for nothing. The
    // default stays ON: a renderer cannot know whether its output will
    // be patched, and guessing wrong turns O(1) reconciliation into a
    // rebuild with no error to show for it.
    const src = '# H\n\npara *em*\n\n- a\n- b\n\n| x |\n| - |\n| 1 |\n';
    const doc = parseMarkdown(src);
    const keyed = mdToVnode(doc);
    const bare = mdToVnode(doc, { keyed: false });
    assert.equal(keyed[2].every((block) => typeof block[1].key === 'string'), true);
    assert.equal(bare[2].every((block) => block[1].key === undefined), true);
    // and the rendered document is the same one, keys aside
    const strip = (markup) => markup.replace(/ data-key="[^"]*"/g, '');
    assert.equal(strip(renderToString(bare)), strip(renderToString(keyed)));
    // `keyed` is part of the memo identity, and the memo holds ONE entry
    // per node: rendering the same document under the same options is
    // reference-stable, and switching options rebuilds rather than
    // handing back a tree built for the other answer.
    assert.equal(mdToVnode(doc, { keyed: false })[2][0], mdToVnode(doc, { keyed: false })[2][0]);
    assert.notEqual(mdToVnode(doc)[2][0], bare[2][0]);
  });

  it('keys are the same strings whatever else the emitter is asked for', function () {
    // The key scheme is a content hash of the block subtree. Every
    // consumer's patch behaviour depends on it, so it is pinned here:
    // a change to the hash walk shows up as a diff in this list.
    const doc = parseMarkdown('# Title\n\nA *paragraph*.\n\n- one\n- two\n');
    assert.deepEqual(mdToVnode(doc)[2].map((b) => b[1].key),
      ['lj57zr', '1eqeya3', '15qeivb']);
    // unaffected by options that do not change the block's content
    assert.deepEqual(mdToVnode(doc, { html: 'text' })[2].map((b) => b[1].key),
      ['lj57zr', '1eqeya3', '15qeivb']);
  });

  it('retainSource: false drops the source string', function () {
    const kept = compileMarkdown('# A\n');
    const dropped = compileMarkdown('# A\n', { retainSource: false });
    assert.equal(kept.source, '# A\n');
    assert.equal(dropped.source, null);
    assert.deepEqual(dropped.ast, kept.ast);
  });
});

/**
 * A minimal compileTypeTest hook for the shape matches used here (the
 * real hook lives in @jarenjs/validate/query; tests keep the md suite
 * validator-independent).
 * @param {any} schema
 * @returns {(value: any) => boolean}
 */
function schemaTest(schema) {
  return (value) => {
    if (value === null || typeof value !== 'object') return false;
    for (const key of schema.required ?? []) {
      if (!(key in value)) return false;
    }
    for (const key of Object.keys(schema.properties ?? {})) {
      const rule = schema.properties[key];
      if (rule.const !== undefined && value[key] !== rule.const) return false;
    }
    return true;
  };
}
