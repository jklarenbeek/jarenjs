//@ts-check
/**
 * The JOSL data-model schema twin: the JSON-safe subset an LLM emits
 * under constrained decoding, rendered to JOSL text by `stringifyJosl`.
 * The twin's promise is the round trip — every schema-valid document
 * stringifies to JOSL that parses back deep-equal.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';
import { parseJosl, stringifyJosl } from '@jarenjs/josl';
import dataSchema from '@jarenjs/josl/schemas/jaren-josl-data.schema.json' with { type: 'json' };

const check = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(dataSchema);

/** Schema-valid documents spanning the JSON-safe JOSL surface. */
const CORPUS = [
  { title: 'plain scalars', count: 3, ratio: 1.5, on: true, off: false, none: null },
  { list: [1, 'two', true, null], nested: { deep: { leaf: 'x' } } },
  { server: { host: 'localhost', ports: [8001, 8002] }, 'dotted key': 'quoted' },
  { unicode: 'héllo — 世界', empty: {}, emptyList: [] },
  { mixed: [{ a: 1 }, { a: 2 }], strings: ['multi\nline', 'tab\there'] },
];

/** Shapes the twin rejects: non-JSON values have no JOSL-JSON encoding. */
const REJECTED = [
  ['a root array', [1, 2, 3]],
  ['a root scalar', 'text'],
];

describe('josl — the data-model schema twin', function () {
  it('accepts the JSON-safe corpus and rejects non-table roots', function () {
    for (const doc of CORPUS) {
      const outcome = check(doc);
      assert.strictEqual(outcome.valid, true,
        `schema-valid: ${JSON.stringify(doc).slice(0, 50)}`);
    }
    for (const [label, doc] of REJECTED) {
      assert.strictEqual(check(doc).valid, false, `${label} is rejected`);
    }
  });

  it('every schema-valid document round-trips through JOSL text exactly', function () {
    for (const doc of CORPUS) {
      const text = stringifyJosl(doc);
      const back = parseJosl(text);
      assert.deepStrictEqual(back, doc,
        `stringify → parse round-trips: ${JSON.stringify(doc).slice(0, 50)}`);
    }
  });

  it('the artifact stays inside the draft-neutral repository subset', function () {
    assert.strictEqual(dataSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(dataSchema.$id, /jaren-josl-data/);
    const text = JSON.stringify(dataSchema);
    assert.doesNotMatch(text, /oneOf|patternProperties|propertyNames|"format"/,
      'the twin is born inside the strict provider subset — no profile derivation needed');
  });
});
