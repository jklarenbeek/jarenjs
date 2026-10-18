//@ts-check
/**
 * @file The standalone readers of a schema — `compileNormalizer`,
 * `indexSchemaResources` and `deriveStrictProfile` — read a `$schema` by its
 * name alone, where a custom dialect reads as draft-07, unless handed a
 * validator as `dialects`: then each `$schema` is read through the
 * meta-schemas that validator holds, as its compile reads it (a dialect
 * extending 2020-12 reads as 2020-12, a chain of dialects by its last known
 * draft, a loop as draft-07).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, indexSchemaResources, schemaPlace } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const MINE = 'https://example.com/my-dialect';
const OUTER = 'https://example.com/outer';
const MINE19 = 'https://example.com/my-2019-dialect';
const LEGACY = 'https://example.com/2020-12/legacy';
const LOOP = 'https://example.com/loop';

/** A validator holding the dialects: MINE extends 2020-12, OUTER extends MINE, MINE19 2019-09, LEGACY draft-07, LOOP itself. */
function dialects() {
  return new JarenValidator()
    .addSchema({ $id: MINE, $schema: D20 })
    .addSchema({ $id: OUTER, $schema: MINE })
    .addSchema({ $id: MINE19, $schema: D19 })
    .addSchema({ $id: LEGACY, $schema: D07 })
    .addSchema({ $id: LOOP, $schema: LOOP });
}

/** The entry's document: a `$ref` whose sibling `properties` holds a default. @param {string} $schema */
const refWithSiblings = ($schema) => ({ $schema, $defs: { s: { type: 'object' } }, $ref: '#/$defs/s', properties: { a: { default: 1 } } });

describe('compileNormalizer reads a dialect through the validator it is handed', () => {
  const validator = dialects();
  /** @param {string} uri @param {object} [options] */
  const fill = (uri, options = {}) => compileNormalizer(refWithSiblings(uri), { useDefaults: true, ...options })({});

  it('applies a $ref\'s siblings under a dialect extending 2020-12 or 2019-09, directly or through a chain', () => {
    for (const uri of [MINE, OUTER, MINE19]) {
      assert.deepEqual(fill(uri, { dialects: validator }), { a: 1 }, uri);
      // the validator applies them too: the filled default is what it reads
      assert.equal(validator.compile({ ...refWithSiblings(uri), properties: { a: { const: 1 } } })({ a: 2 }), false, uri);
    }
  });

  it('reads a dialect whose meta-schema is draft-07, a loop and an unheld dialect as draft-07, as the validator does', () => {
    for (const uri of [LEGACY, LOOP, 'https://example.com/unheld']) {
      assert.deepEqual(fill(uri, { dialects: validator }), {}, uri);
      assert.equal(validator.compile({ ...refWithSiblings(uri), properties: { a: { const: 1 } } })({ a: 2 }), true, uri);
    }
  });

  it('reads every dialect by its name alone without the option (a custom dialect as draft-07)', () => {
    for (const uri of [MINE, OUTER, MINE19, LEGACY, LOOP]) assert.deepEqual(fill(uri), {}, uri);
    assert.deepEqual(fill(D20), { a: 1 });
  });

  it('reads prefixItems and a nested $schema through it', () => {
    const tuple = { $schema: OUTER, type: 'array', prefixItems: [{ type: 'integer' }] };
    assert.deepEqual(compileNormalizer(tuple, { coerceTypes: true, dialects: validator })(['1']), [1]);
    assert.deepEqual(compileNormalizer(tuple, { coerceTypes: true })(['1']), ['1']);
    const nested = { type: 'object', properties: { r: { ...refWithSiblings(MINE), $id: 'https://x.test/r.json' } } };
    assert.deepEqual(compileNormalizer(nested, { useDefaults: true, dialects: validator })({ r: {} }), { r: { a: 1 } });
    assert.deepEqual(compileNormalizer(nested, { useDefaults: true })({ r: {} }), { r: {} });
  });

  it('resolves a $ref beside an $id against the $id under a dialect extending 2019-09 or later', () => {
    const schema = {
      $schema: MINE, $id: 'https://x.test/root.json', $defs: { t: { type: 'string', default: 'z' } }, type: 'object',
      properties: { q: { $id: 'q.json', $defs: { t: { type: 'integer' } }, $ref: '#/$defs/t' } },
    };
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true, dialects: validator })({ q: '5' }), { q: 5 });
    assert.deepEqual(validator.compile(schema)({ q: 5 }), true);
    // by name, draft-07: the $ref resolves against the enclosing resource, to a string
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true })({ q: '5' }), { q: '5' });
  });

  it('reads a draft-04 id as no identifier under a dialect extending 2020-12, as the validator does', () => {
    const schema = { $schema: MINE, $defs: { t: { type: 'integer' } }, type: 'object', properties: { p: { id: 'http://x.test/p.json', type: 'object', properties: { q: { $ref: '#/$defs/t' } } } } };
    assert.deepEqual([validator.compile(schema)({ p: { q: 5 } }), validator.compile(schema)({ p: { q: '5' } })], [true, false]);
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true, dialects: validator })({ p: { q: '5' } }), { p: { q: 5 } });
    // by name, an unknown dialect: the id names a resource, and the $ref resolves against it to nothing
    assert.deepEqual(compileNormalizer(schema, { coerceTypes: true })({ p: { q: '5' } }), { p: { q: '5' } });
  });

  it('reads a member\'s own $schema, and the root\'s, for the default beside a $ref', () => {
    const member = { type: 'object', $defs: { n: { type: 'number' } }, properties: { a: { $schema: MINE, $ref: '#/$defs/n', default: 2 } } };
    assert.deepEqual(compileNormalizer(member, { useDefaults: true, dialects: validator })({}), { a: 2 });
    assert.deepEqual(compileNormalizer(member, { useDefaults: true })({}), {});
    const root = { $schema: MINE, $defs: { n: { type: 'number' } }, $ref: '#/$defs/n', default: 3 };
    assert.equal(compileNormalizer(root, { useDefaults: true, dialects: validator })(undefined), 3);
    assert.equal(compileNormalizer(root, { useDefaults: true })(undefined), undefined);
  });

  it('places each node of the index under the draft the validator reads', () => {
    const schema = refWithSiblings(OUTER);
    assert.equal(schemaPlace(indexSchemaResources(schema, { dialects: validator }), schema).draft, 2020);
    assert.equal(schemaPlace(indexSchemaResources(schema), schema).draft, 7);
    assert.throws(() => indexSchemaResources(schema, { dialects: new Map() }),
      { name: 'TypeError', message: "indexSchemaResources: 'dialects' must be a JarenValidator, whose held meta-schemas name the dialects" });
  });
});

describe('deriveStrictProfile reads a dialect through the validator it is handed', () => {
  const validator = dialects();

  it('refuses the siblings of a $ref the dialect applies, as for 2020-12 itself', () => {
    const schema = { ...refWithSiblings(MINE), properties: { a: { type: 'integer' } } };
    assert.throws(() => deriveStrictProfile(schema, { dialects: validator }), { code: 'JK0103' });
    assert.throws(() => deriveStrictProfile({ ...schema, $schema: D20 }), { code: 'JK0103' });
    // by name, draft-07: the $ref alone shapes the profile
    assert.deepEqual(deriveStrictProfile(schema).schema.properties, { value: { $ref: '#/$defs/s' } });
  });

  it('maps an answer back as the validator reads the place', () => {
    for (const uri of [MINE, OUTER]) {
      const schema = { $schema: uri, $defs: { any: {} }, type: 'object', properties: { m: { $ref: '#/$defs/any', type: 'string' } } };
      const profile = deriveStrictProfile(schema, { dialects: validator });
      assert.deepEqual(profile.schema.properties.m.type, ['string', 'null'], uri);
      // the null the profile placed is removed: the original refuses it and lets m be absent
      assert.deepEqual(profile.fromProfile({ m: null }), {}, uri);
      assert.equal(validator.compile(schema)(profile.fromProfile({ m: null })), true, uri);
      // by name, draft-07: the $ref alone, which accepts null, so the null is kept
      assert.deepEqual(deriveStrictProfile(schema).fromProfile({ m: null }), { m: null }, uri);
    }
  });

  it('reads a draft-04 id as no identifier under a dialect extending 2020-12, as the validator does', () => {
    const named = { $schema: MINE, id: 'nope', $defs: { t: { type: 'string' } }, type: 'object', properties: { p: { $ref: '#/$defs/t' } } };
    assert.deepEqual([validator.compile(named)({ p: 's' }), validator.compile(named)({ p: 1 })], [true, false]);
    assert.deepEqual(deriveStrictProfile(named, { dialects: validator }).schema.properties, { p: { anyOf: [{ $ref: '#/$defs/t' }, { type: 'null' }] } });
    // by name, an unknown dialect: the root id names the document, where nothing holds its pointers
    assert.throws(() => deriveStrictProfile(named), { code: 'JK0009' });
    const member = { $schema: MINE, type: 'object', properties: { a: { id: 'x.json', type: 'string' } } };
    assert.match(deriveStrictProfile(member, { dialects: validator }).schema.properties.a.description, /id "x\.json" is relaxed here/);
    assert.equal(deriveStrictProfile(member).schema.properties.a.description, undefined);
  });

  it('refuses a dialects option that is no validator', () => {
    for (const value of [{}, null, new Map()])
      assert.throws(() => deriveStrictProfile({ type: 'object', properties: { a: { type: 'string' } } }, { dialects: value }), { code: 'JK0107' });
  });
});
