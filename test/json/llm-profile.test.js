//@ts-check
/**
 * The LLM-profile schema twins: mechanically derived relaxations of the
 * canonical query/JSLT grammars for provider structured-output subsets
 * that do not enforce `patternProperties`, `propertyNames` or asserted
 * `format`s.
 *
 * Three properties are enforced here: the committed artifacts ARE the
 * derivation (regeneration is byte-stable), the profile is a pure
 * relaxation (every canonical-valid document validates under it), and
 * the documented pipeline holds — a document the profile lets through
 * is caught by canonical local validation.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileArtifact, deriveLlmProfile } from './schema-artifact-helpers.js';

import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import queryProfile from '@jarenjs/json/schemas/jaren-query.llm-profile.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import jsltProfile from '@jarenjs/json/schemas/jaren-jslt.llm-profile.schema.json' with { type: 'json' };

import { queryExamples, jsltExamples } from '../../packages/website/src/content/engineExamples.js';

/** Representative valid query documents beyond the site examples. */
const QUERY_CORPUS = [
  '$.store.book[*].title',
  { $for: { b: '$.books[*]' }, $where: { $gt: ['$b.price', 10] }, $return: '$b.title' },
  { $let: { total: { $sum: '$.prices[*]' } }, $return: { total: '$total' } },
  { $if: [{ $exists: '$.name' }, '$.name', 'anonymous'] },
  { $some: { r: '$.ratings[*]' }, $satisfies: { $ge: ['$r.stars', 5] } },
  { $concat: ['a', '$.b', 'c'] },
  { $count: '$.items[*]' },
];

/** Representative valid JSLT stylesheets beyond the site examples. */
const JSLT_CORPUS = [
  [{ match: '$..title', body: { $upper: '$' } }],
  {
    $jslt: '0.1',
    rules: [
      { match: '$', body: { total: { $sum: '$.prices[*]' } } },
      { match: { schema: { type: 'object', required: ['id'] } }, body: '$', mode: 'ids' },
    ],
  },
];

const checks = {
  query: compileArtifact(querySchema),
  queryProfile: compileArtifact(queryProfile),
  jslt: compileArtifact(jsltSchema),
  jsltProfile: compileArtifact(jsltProfile),
};

/** Walk an artifact collecting keywords the profile must not contain. */
function forbiddenKeywords(schema) {
  /** @type {string[]} */
  const found = [];
  function walk(node, pointer) {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${pointer}/${i}`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (key === 'patternProperties' || key === 'propertyNames' || key === 'format' || key === 'oneOf')
        found.push(`${key} at ${pointer}`);
      walk(node[key], `${pointer}/${key}`);
    }
  }
  walk(schema, '');
  return found;
}

describe('json — the LLM-profile schema twins', function () {
  it('the committed artifacts are byte-stable derivations of the canonical schemas', function () {
    assert.deepStrictEqual(queryProfile, deriveLlmProfile(querySchema),
      'jaren-query.llm-profile.schema.json = deriveLlmProfile(canonical)');
    assert.deepStrictEqual(jsltProfile, deriveLlmProfile(jsltSchema),
      'jaren-jslt.llm-profile.schema.json = deriveLlmProfile(canonical)');
  });

  it('the profile contains none of the keywords strict provider subsets reject', function () {
    assert.deepStrictEqual(forbiddenKeywords(queryProfile), []);
    assert.deepStrictEqual(forbiddenKeywords(jsltProfile), []);
    assert.match(queryProfile.$id, /\/llm-profile$/);
    assert.match(jsltProfile.title, /\(LLM profile\)$/);
  });

  it('every canonical-valid query document is profile-valid (pure relaxation)', function () {
    // `registry` examples use host-registered operators ($mean, $sqrt, …)
    // that are deliberately OUTSIDE the published closed grammar, so they
    // are not canonical-valid — the site mounts a registry to run them
    const docs = [...QUERY_CORPUS,
      ...queryExamples.filter((e) => e.registry !== true).map((e) => e.query)];
    for (const doc of docs) {
      assert.strictEqual(checks.query(doc), true,
        `corpus doc is canonical-valid: ${JSON.stringify(doc).slice(0, 60)}`);
      assert.strictEqual(checks.queryProfile(doc), true,
        `and profile-valid: ${JSON.stringify(doc).slice(0, 60)}`);
    }
  });

  it('every canonical-valid JSLT stylesheet is profile-valid (pure relaxation)', function () {
    const docs = [...JSLT_CORPUS,
      ...jsltExamples.filter((e) => e.registry !== true).map((e) => e.stylesheet)];
    for (const doc of docs) {
      assert.strictEqual(checks.jslt(doc), true,
        `corpus stylesheet is canonical-valid: ${JSON.stringify(doc).slice(0, 60)}`);
      assert.strictEqual(checks.jsltProfile(doc), true,
        `and profile-valid: ${JSON.stringify(doc).slice(0, 60)}`);
    }
  });

  it('what the profile lets through, canonical local validation catches', function () {
    // a binding name the canonical propertyNames pattern polices, and a
    // $-prefixed member the canonical mapConstructor forbids
    const badBinding = { $for: { '9bad': '$.a[*]' }, $return: '$.b' };
    assert.strictEqual(checks.queryProfile(badBinding), true,
      'the profile accepts it (the provider subset would too)');
    assert.strictEqual(checks.query(badBinding), false,
      'canonical validation rejects it locally — the documented pipeline');
  });
});
