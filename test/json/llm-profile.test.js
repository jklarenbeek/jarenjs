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

import {
  compileArtifact, deriveLlmProfile, deriveAuthoringProfile, JSLT_AUTHORING_OPEN,
} from './schema-artifact-helpers.js';

import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import queryProfile from '@jarenjs/json/schemas/jaren-query.llm-profile.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import jsltProfile from '@jarenjs/json/schemas/jaren-jslt.llm-profile.schema.json' with { type: 'json' };
import jsltAuthoring from '@jarenjs/json/schemas/jaren-jslt.authoring.schema.json' with { type: 'json' };

import { EXAMPLES as PLAY_EXAMPLES } from '../../components/play/src/index.js';

/** Play's canonical library, parsed back to documents. The `$mean`
 * example uses a host-REGISTERED operator that is deliberately outside
 * the published closed grammar (the site mounts a registry to run it),
 * so it is not canonical-valid and stays out of this corpus. */
const playDocs = (engine, paneKey, skipIds) => PLAY_EXAMPLES
  .filter((e) => e.engine === engine && !skipIds.includes(e.id))
  .map((e) => JSON.parse(e.source[paneKey]));

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
    const docs = [...QUERY_CORPUS, ...playDocs('query', 'query', ['query-mean'])];
    for (const doc of docs) {
      assert.strictEqual(checks.query(doc), true,
        `corpus doc is canonical-valid: ${JSON.stringify(doc).slice(0, 60)}`);
      assert.strictEqual(checks.queryProfile(doc), true,
        `and profile-valid: ${JSON.stringify(doc).slice(0, 60)}`);
    }
  });

  it('every canonical-valid JSLT stylesheet is profile-valid (pure relaxation)', function () {
    const docs = [...JSLT_CORPUS, ...playDocs('jslt', 'stylesheet', [])];
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

describe('json — the JSLT authoring profile', function () {
  const authoringCheck = compileArtifact(jsltAuthoring);

  it('the committed artifact is a byte-stable derivation of the canonical schema', function () {
    assert.deepStrictEqual(jsltAuthoring,
      deriveAuthoringProfile(jsltSchema, { open: JSLT_AUTHORING_OPEN }),
      'jaren-jslt.authoring.schema.json = deriveAuthoringProfile(canonical)');
    assert.match(jsltAuthoring.$id, /\/authoring$/);
  });

  it('SHRINKS the grammar, which is the entire reason it exists', function () {
    // the LLM profile is a relaxation: it restates every constraint it
    // removes, so it does not get smaller — measured, it gets BIGGER.
    // An oversized response_format is what stops a small model decoding
    // at all, so a profile that does not shrink does not help.
    const canonical = JSON.stringify(jsltSchema).length;
    assert.ok(JSON.stringify(jsltProfile).length >= canonical,
      'the relaxation is not a shrink');
    assert.ok(JSON.stringify(jsltAuthoring).length < canonical / 4,
      'the narrowing is: under a quarter of the canonical grammar');
  });

  it('opens the body and nothing else', function () {
    assert.deepStrictEqual(Object.keys(jsltAuthoring.$defs.queryDocument), ['description'],
      'the open node carries a description and no constraint');
    for (const gone of ['expression', 'flworPhrase', 'binaryOperatorPhrase', 'objectExpression']) {
      assert.ok(!Object.hasOwn(jsltAuthoring.$defs, gone),
        `${gone} is reachable only through the body and left with it`);
    }
    for (const kept of ['stylesheetDocument', 'stylesheetEnvelope', 'rule', 'matchSpec']) {
      assert.ok(Object.hasOwn(jsltAuthoring.$defs, kept),
        `${kept} is document shape and stays`);
    }
  });

  it('is a pure WIDENING: every canonical-valid stylesheet is authoring-valid', function () {
    // the one failure mode a narrowing must not have — a document the
    // engine can run that the response format cannot express
    const docs = [...JSLT_CORPUS, ...playDocs('jslt', 'stylesheet', [])];
    for (const doc of docs) {
      assert.strictEqual(authoringCheck(doc), true,
        `authoring-valid: ${JSON.stringify(doc).slice(0, 60)}`);
    }
  });

  it('is DELIBERATELY weaker, so the compiler is what makes it safe', function () {
    // nonsense in the body position decodes here and must not survive
    // the validate-then-compile pipeline the README documents
    const nonsense = { $jslt: '0.1', rules: [{ match: '$', body: { $nope: [1, 2, 3] } }] };
    assert.strictEqual(authoringCheck(nonsense), true,
      'the authoring profile accepts it — that is the trade');
    assert.strictEqual(checks.jslt(nonsense), false,
      'and canonical validation refuses it, before the compiler ever sees it');
  });

  it('contains none of the keywords strict provider subsets reject', function () {
    assert.deepStrictEqual(forbiddenKeywords(jsltAuthoring), []);
  });
});
