//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, compileMarkdown, mdToVnode } from '@jarenjs/md';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

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
