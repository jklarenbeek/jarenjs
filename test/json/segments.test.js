import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseJSONPath, compileJSONPath } from '@jarenjs/json';

// segments.js is package-internal (not in the exports map); the shared
// nodes-mode runner is exercised directly, the way the JSLT dispatcher
// will consume it.
import { compileSegmentP, runSegmentsP } from '../../packages/json/src/segments.js';

const doc = {
  limit: 10,
  store: {
    book: [
      { title: 'A', price: 5 },
      { title: 'B', price: 15 },
      { title: 'C', price: 8 },
    ],
    "odd 'key": { price: 1 },
  },
};

function segsOf(source) {
  return parseJSONPath(source).segments.map(compileSegmentP);
}

describe('runSegmentsP (shared nodes-mode runner)', () => {
  it('threads a non-root start path into the normalized paths', () => {
    // run against the store subtree, rooted at the full document: the
    // filter's '$.limit' resolves against the real root, and the
    // normalized paths grow from the caller-supplied base path
    const segs = segsOf('$.book[?@.price < $.limit].title');
    const { vals, paths } = runSegmentsP(segs, doc.store, "$['store']", doc);
    assert.deepStrictEqual(vals, ['A', 'C']);
    assert.deepStrictEqual(paths, [
      "$['store']['book'][0]['title']",
      "$['store']['book'][2]['title']",
    ]);
  });

  it('escapes member names in produced paths', () => {
    const segs = segsOf('$..price');
    const { vals, paths } = runSegmentsP(segs, doc.store, "$['store']", doc);
    assert.deepStrictEqual(vals, [5, 15, 8, 1]);
    assert.strictEqual(paths[3], "$['store']['odd \\'key']['price']");
  });

  it('returns empty parallel arrays when a segment empties the nodelist', () => {
    const segs = segsOf('$.missing.deeper');
    const { vals, paths } = runSegmentsP(segs, doc.store, "$['store']", doc);
    assert.deepStrictEqual(vals, []);
    assert.deepStrictEqual(paths, []);
  });

  it('agrees with query.nodes() from the document root', () => {
    const source = '$.store.book[?@.price < $.limit].title';
    const segs = segsOf(source);
    const { vals, paths } = runSegmentsP(segs, doc, '$', doc);
    const nodes = compileJSONPath(source).nodes(doc);
    assert.deepStrictEqual(nodes.map((n) => n.value), vals);
    assert.deepStrictEqual(nodes.map((n) => n.path), paths);
  });
});
