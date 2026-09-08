//@ts-check
/** Dedicated keyword emission, immutable snapshots and validator readings. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as s from '@jarenjs/linq/schema';
import { JarenValidator } from '@jarenjs/validate';
import { dateTimeFormats } from '@jarenjs/formats';
import { getSchemaDraftByVersion } from '@jarenjs/refs';

const [main, ...vocabs] = getSchemaDraftByVersion(2020).schema;
const grammar = new JarenValidator().addSchema(vocabs).compile(main);
const [main2019, ...vocabs2019] = getSchemaDraftByVersion(2019).schema;
const grammar2019 = new JarenValidator().addSchema(vocabs2019).compile(main2019);
const SIMPLE = [
  ['minContains', () => s.array(s.any()).contains(s.number()), 2, [1, 2], [1, 'x']],
  ['maxContains', () => s.array(s.any()).contains(s.number()), 1, [1, 'x'], [1, 2]],
  ['contentEncoding', s.string, 'base64', 'e30=', '?'],
  ['contentMediaType', s.string, 'application/json', '{}', '{'],
  ['contentSchema', s.string, s.object({}), '{}', 1],
  ['formatMinimum', s.date, '2020-01-01', '2021-01-01', '2019-01-01'],
  ['formatMaximum', s.date, '2020-01-01', '2019-01-01', '2021-01-01'],
  ['formatExclusiveMinimum', s.date, '2020-01-01', '2021-01-01', '2020-01-01'],
  ['formatExclusiveMaximum', s.date, '2020-01-01', '2019-01-01', '2020-01-01'],
  ['id', s.string, 'https://example.test/value', 'ok', 1],
];

describe('dedicated schema keyword families', () => {
  for (const [method, make, value, valid, invalid] of SIMPLE) {
    it(`${method}: exact JSON, grammar, runtime and unchanged original`, () => {
      const original = make();
      const before = JSON.stringify(original);
      const keyword = method === 'id' ? '$id' : method;
      const expected = { ...original.schema, [keyword]: method === 'contentSchema' ? value.schema : value };
      const built = original[method](value);
      assert.equal(JSON.stringify(built), JSON.stringify(expected));
      assert.equal(JSON.stringify(original), before);
      assert.notEqual(original, built);
      assert.equal(JSON.stringify(built[method](value)), JSON.stringify(expected));
      assert.equal(grammar(built.schema), true);
      const validate = new JarenValidator({ contentValidation: true, formatAssertion: true })
        .addFormats(dateTimeFormats).compile(built.schema);
      assert.equal(validate(valid), true);
      assert.equal(validate(invalid), false);
    });
  }
  it('refuses invalid domains at the authoring boundary', () => {
    for (const n of [-1, 1.5, NaN, Infinity, '1']) {
      assert.throws(() => s.array(s.any()).minContains(n), { code: 'JL0101' });
      assert.throws(() => s.array(s.any()).maxContains(n), { code: 'JL0101' });
    }
    for (const [method, make] of SIMPLE.filter(([m]) => !['minContains', 'maxContains', 'contentSchema'].includes(m))) {
      assert.throws(() => make()[method](null), { code: 'JL0101' });
    }
    assert.throws(() => s.string().contentSchema({ type: 'number' }), { code: 'JL0101' });
    assert.equal(grammar({ minContains: -1 }), false);
    assert.equal(grammar({ contentSchema: 3 }), false);
    assert.equal(grammar({ $id: 3 }), false);
  });
  it('replaces values in their original position', () => {
    const original = s.array(s.any()).minContains(1).maxContains(3);
    assert.equal(JSON.stringify(original.minContains(2)),
      '{"type":"array","items":{},"minContains":2,"maxContains":3}');
    assert.equal(original.schema.minContains, 1);
  });
  it('contentSchema is annotation data, without an invented decoded-content assertion', () => {
    const schema = s.string().contentMediaType('application/json').contentSchema(s.number()).schema;
    assert.equal(new JarenValidator({ contentValidation: true }).compile(schema)('"a"'), true);
  });
  it('identifiers work on every object-shaped builder and refuse bare boolean schemas', () => {
    const named = s.named('N', s.string());
    for (const b of [s.any(), s.literal(1), s.enumOf([1]), s.union([s.string()]),
      s.intersection([s.string()]), s.when(s.string()), s.from({}), named,
      s.lazy(() => named), s.never().nullable()]) {
      assert.equal(b.id('https://example.test/s').schema.$id, 'https://example.test/s');
    }
    assert.throws(() => s.never().id('x'), { code: 'JL0102' });
    assert.throws(() => s.from(false).id('x'), { code: 'JL0102' });
  });
  it('content schemas hoist named definitions through the shared document context', () => {
    const N = s.named('N', s.number());
    const doc = s.string().contentSchema(N).schema;
    assert.deepEqual(doc, { $defs: { N: { type: 'number' } }, type: 'string', contentSchema: { $ref: '#/$defs/N' } });
    assert.equal(grammar(doc), true);
  });
});

// The census independently reads the private owned set, then executes each route.
import { readFileSync } from 'node:fs';
import { KEYWORD_ROUTES } from './schema-keyword-corpus.js';

describe('dedicated keyword census', () => {
  it('holds all owned names equal to executable dedicated routes, with no silent aliases', () => {
    const source = readFileSync(new URL('../../packages/linq/src/schema/builders.js', import.meta.url), 'utf8');
    const block = /const OWNED = new Set\(\[([\s\S]*?)\]\);/.exec(source);
    assert.ok(block);
    const owned = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    assert.equal(owned.length, 69);
    assert.deepEqual(Object.keys(KEYWORD_ROUTES).sort(), owned);
    for (const [keyword, build] of Object.entries(KEYWORD_ROUTES)) {
      const built = build();
      const doc = built.schema ?? built;
      assert.equal(Object.hasOwn(doc, keyword), true, `dedicated route must actually emit ${keyword}`);
      assert.equal(JSON.stringify(built), JSON.stringify(doc));
    }
  });
});

const SEMANTIC = [
  ['not', s.number(), { not: { type: 'number' } }, 'x', 1],
  ['unevaluatedProperties', s.never(), { unevaluatedProperties: false }, {}, { x: 1 }],
  ['unevaluatedItems', s.never(), { unevaluatedItems: false }, [], [1]],
  ['dependentSchemas', { x: s.object({ y: s.number() }).open() },
    { dependentSchemas: { x: { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] } } }, {}, { x: 1 }],
  ['dependencies', { x: ['y'], z: s.number() }, { dependencies: { x: ['y'], z: { type: 'number' } } }, {}, { x: 1 }],
  ['anchor', 'node', { $anchor: 'node' }, {}, undefined],
  ['vocabulary', { 'urn:test': false }, { $vocabulary: { 'urn:test': false } }, 1, undefined],
  ['dynamicAnchor', 'node', { $dynamicAnchor: 'node' }, 1, undefined],
  ['recursiveAnchor', true, { $recursiveAnchor: true }, 1, undefined],
  ['definitions', { N: s.number() }, { definitions: { N: { type: 'number' } } }, 1, undefined],
  ['additionalItems', s.never(), { additionalItems: false }, [], undefined],
  ['dollarData', '/limit', { $data: '/limit' }, 1, undefined],
  ['data', { maximum: '/limit' }, { data: { maximum: '/limit' } }, {}, undefined],
];

describe('semantic schema keywords', () => {
  for (const [method, value, expected, valid, invalid] of SEMANTIC) {
    it(`${method}: byte equality, replacement, original preservation and runtime reading`, () => {
      const root = s.any();
      const built = root[method](value);
      assert.equal(JSON.stringify(built), JSON.stringify(expected));
      assert.equal(JSON.stringify(built[method](value)), JSON.stringify(expected));
      assert.equal(JSON.stringify(root), '{}');
      // The recursive pair belongs to 2019-09; 2020-12 reserves and refuses it.
      assert.equal((method === 'recursiveAnchor' ? grammar2019 : grammar)(built.schema), true);
      const validate = new JarenValidator().compile(built.schema);
      assert.equal(validate(valid), true);
      if (invalid !== undefined) assert.equal(validate(invalid), false);
    });
  }
  it('dynamic and recursive references emit exactly and validate recursive data', () => {
    for (const [anchor, ref, value] of [['dynamicAnchor', 'dynamicRef', 'node'], ['recursiveAnchor', 'recursiveRef', true]]) {
      const b = s.object({ children: s.array(s.any()[ref](ref === 'dynamicRef' ? '#node' : '#')).optional() })[anchor](value);
      const doc = b.schema;
      assert.equal(doc[`$${anchor}`], value);
      assert.deepEqual(doc.properties.children.items, { [`$${ref}`]: ref === 'dynamicRef' ? '#node' : '#' });
      assert.equal((anchor === 'recursiveAnchor' ? grammar2019 : grammar)(doc), true);
      const validate = new JarenValidator().compile(doc);
      assert.equal(validate({ children: [{ children: [{}] }] }), true);
      assert.equal(validate({ children: [1] }), false);
    }
  });
  it('new applicators share named identity and reject conflicting definitions', () => {
    const N = s.named('N', s.number());
    const doc = s.any().not(N).dependentSchemas({ x: N }).definitions({ old: N }).schema;
    assert.deepEqual(doc.$defs, { N: { type: 'number' } });
    assert.deepEqual(doc.not, { $ref: '#/$defs/N' });
    assert.deepEqual(doc.definitions.old, doc.not);
    assert.throws(() => s.any().not(N).dependentSchemas({ x: s.named('N', s.string()) }).schema, { code: 'JL0103' });
    assert.throws(() => s.any().not(s.ref('missing')).schema, { code: 'JL0103' });
  });
  it('legacy tuples, definitions and both data-reference spellings run in the validator', () => {
    const tuple = s.from({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'array', items: [{ type: 'number' }] }).additionalItems(s.never());
    const validateTuple = new JarenValidator().compile(tuple.schema);
    assert.equal(validateTuple([1]), true);
    assert.equal(validateTuple([1, 2]), false);
    const legacy = s.from({ $ref: '#/definitions/N' }).definitions({ N: s.number() });
    assert.equal(new JarenValidator().compile(legacy.schema)('x'), false);
    for (const bound of [s.number().data({ maximum: '/limit' }),
      s.number().keyword('maximum', s.any().dollarData('/limit').schema)]) {
      const validate = new JarenValidator().compile(s.object({ limit: s.number(), value: bound }).schema);
      assert.equal(validate({ limit: 2, value: 1 }), true);
      assert.equal(validate({ limit: 2, value: 3 }), false);
    }
  });
  it('maps are snapshots, computed prototype names are ordinary data, and invalid shapes fail', () => {
    const deps = { x: ['y'] };
    const b = s.any().dependencies(deps);
    deps.x.push('z');
    assert.deepEqual(b.schema.dependencies, { x: ['y'] });
    assert.equal(Object.isFrozen(deps.x), false);
    const special = s.any().definitions({ ['__proto__']: s.number() }).schema;
    assert.equal(Object.hasOwn(special.definitions, '__proto__'), true);
    for (const method of ['definitions', 'dependentSchemas', 'dependencies', 'vocabulary', 'data']) {
      for (const bad of [null, [], 1, { __proto__: { x: 1 } }])
        assert.throws(() => s.any()[method](bad), { code: 'JL0101' });
    }
    assert.throws(() => s.any().dependencies({ x: ['y', 'y'] }), { code: 'JL0101' });
    assert.throws(() => s.any().recursiveAnchor('true'), { code: 'JL0101' });
    assert.throws(() => s.any().vocabulary({ x: 1 }), { code: 'JL0101' });
    assert.throws(() => s.any().data({ maximum: 1 }), { code: 'JL0101' });
    for (const method of ['not', 'unevaluatedProperties', 'unevaluatedItems']) {
      assert.throws(() => s.any()[method](false), { code: 'JL0101' });
      assert.throws(() => s.any()[method](s.string().default('x')).schema, { code: 'JL0102' });
    }
  });
  it('the legacy nullable spelling is distinct from the inferred null union', () => {
    const b = s.string().legacyNullable(true);
    assert.deepEqual(b.schema, { type: 'string', nullable: true });
    assert.equal(new JarenValidator().compile(b.schema)(null), true);
    assert.deepEqual(s.string().nullable().schema, { type: ['string', 'null'] });
  });
});

describe('raw keyword snapshots', () => {
  it('refuses cycles and sparse values without freezing caller-owned data', () => {
    const circular = {};
    circular.self = circular;
    assert.throws(() => s.any().keyword('x-custom', circular), { code: 'JL0101' });
    assert.throws(() => s.any().keyword('x-custom', Array(1)), { code: 'JL0101' });
    const shared = { value: 1 };
    const input = { a: shared, b: shared };
    const b = s.any().keyword('x-custom', input);
    shared.value = 2;
    assert.deepEqual(b.schema['x-custom'], { a: { value: 1 }, b: { value: 1 } });
    assert.equal(Object.isFrozen(shared), false);
  });
});
