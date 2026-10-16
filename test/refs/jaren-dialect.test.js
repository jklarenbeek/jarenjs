import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import jaren2020, { dialect, queryVocabulary } from '@jarenjs/refs/jaren-2020-12';
import draft2020 from '@jarenjs/refs/draft-2020-12';
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };

// The Jaren 2020-12 dialect: the standard 2020-12 meta-schema plus a
// vocabulary for '$query', whose value is checked by the query grammar
// @jarenjs/json already publishes.

describe('@jarenjs/refs/jaren-2020-12', function () {
  it('names the dialect and the query vocabulary', function () {
    assert.strictEqual(dialect, 'https://jarenjs.dev/schemas/2020-12/schema');
    assert.strictEqual(queryVocabulary, 'https://jarenjs.dev/schemas/2020-12/vocab/query');
  });

  it('bundles the dialect, the vocabulary meta-schema, the query grammar and the 2020-12 documents', function () {
    assert.deepStrictEqual(jaren2020.map(s => s.$id), [
      dialect,
      'https://jarenjs.dev/schemas/2020-12/meta/query',
      'https://jarenjs.dev/schemas/jaren-query/0.1',
      ...draft2020.map(s => s.$id),
    ]);
    // The grammar is the one @jarenjs/json ships, not a copy of it.
    assert.strictEqual(jaren2020[2], querySchema);
    assert.deepStrictEqual(jaren2020.slice(3), draft2020);
  });

  it('declares every 2020-12 vocabulary and requires the query vocabulary', function () {
    const [root, vocab] = jaren2020;
    assert.deepStrictEqual(root.$vocabulary, { ...draft2020[0].$vocabulary, [queryVocabulary]: true });
    assert.strictEqual(root.$schema, 'https://json-schema.org/draft/2020-12/schema');
    // Both carry the 2020-12 dynamic anchor, so the standard applicators
    // re-enter this dialect for every subschema.
    assert.strictEqual(root.$dynamicAnchor, 'meta');
    assert.strictEqual(vocab.$dynamicAnchor, 'meta');
    assert.deepStrictEqual(vocab.$vocabulary, { [queryVocabulary]: true });
    assert.deepStrictEqual(vocab.properties, { $query: { $ref: 'https://jarenjs.dev/schemas/jaren-query/0.1' } });
  });
});
