//@ts-check
/**
 * @file A plain-name reference read outside the validator — by
 * `compileNormalizer` and `deriveStrictProfile` — reaches the target the
 * validator reaches, and reads it as the validator reads it. A fragment-only
 * `$id` (`$id: '#foo'`, the draft-07 spelling of an anchor) names its schema
 * object as the validator names it: it starts no resource, so the anchors
 * below it are the document's too. An anchor's target is read under the
 * nearest `$schema` above it, as a pointer's target is.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { collectSameDocumentAnchors, compileNormalizer } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/** @param {any} schema */
const validator = (schema) => new JarenValidator().compile(schema);
/** @param {any} schema */
const coerce = (schema) => compileNormalizer(schema, { coerceTypes: true });

/** The document of the plain-name `$id` case, under `$schema` when one is given. @param {string} [draft] */
const plainId = (draft) => ({
  ...(draft === undefined ? {} : { $schema: draft }),
  definitions: { a: { $id: '#foo', type: 'integer' } },
  properties: { y: { $ref: '#foo' } },
});

describe('a fragment-only $id names its schema as the validator names it', () => {
  it('the normalizer coerces through it (left \'1\' as sent)', () => {
    const schema = plainId(D07);
    const validate = validator(schema);
    assert.deepEqual([validate({ y: 1 }), validate({ y: '1' })], [true, false]);
    const normalized = coerce(schema)({ y: '1' });
    assert.deepEqual([normalized, validate(normalized)], [{ y: 1 }, true]);
  });

  it('in every draft the validator reads it in, and where none is declared', () => {
    for (const draft of [undefined, 'http://json-schema.org/draft-06/schema#', D07, 'https://json-schema.org/draft/2019-09/schema', D20]) {
      const schema = plainId(draft);
      const validate = validator(schema);
      const normalized = coerce(schema)({ y: '1' });
      assert.deepEqual([validate({ y: 1 }), validate({ y: '1' }), normalized, validate(normalized)], [true, false, { y: 1 }, true], String(draft));
    }
  });

  it('the strict profile bundles it (refused JK0104, "resolves to no schema")', () => {
    const schema = { ...plainId(D07), type: 'object' };
    const validate = validator(schema);
    const profile = deriveStrictProfile(schema);
    const strict = new JarenValidator().compile({ $schema: D20, ...profile.schema });
    assert.deepEqual([{ y: 1 }, { y: '1' }].map((value) => [validate(value), strict(profile.toProfile(value))]), [[true, true], [false, false]]);
    assert.deepEqual(profile.fromProfile({ y: 1 }), { y: 1 });
    // the entry's own document, an object of any type, derives too
    const entry = deriveStrictProfile(plainId(D07));
    assert.deepEqual([{ y: 1 }, { y: '1' }].map((value) => validate(entry.fromProfile(entry.toProfile(value)))), [true, false]);
  });

  it('starts no resource: an anchor below it is the document\'s', () => {
    const schema = { $schema: D07, definitions: { a: { $id: '#foo', definitions: { b: { $id: '#bar', type: 'integer' } } } }, properties: { y: { $ref: '#bar' } } };
    assert.deepEqual([validator(schema)({ y: '1' }), coerce(schema)({ y: '1' })], [false, { y: 1 }]);
    assert.deepEqual([...collectSameDocumentAnchors(schema).keys()], ['foo', 'bar']);
    // a name is read as a reference spells it: escapes decoded once
    const spelled = { definitions: { a: { $id: '#a%20b', type: 'integer' } }, properties: { y: { $ref: '#a b' } } };
    assert.deepEqual([validator(spelled)({ y: '1' }), coerce(spelled)({ y: '1' })], [false, { y: 1 }]);
  });

  it('what named another resource still does', () => {
    // an $id with a path starts an embedded resource: its anchors are its own
    const embedded = { definitions: { a: { $id: 'other.json', definitions: { b: { $anchor: 'bar', type: 'integer' } } } } };
    assert.deepEqual([...collectSameDocumentAnchors(embedded).keys()], []);
    assert.deepEqual([...collectSameDocumentAnchors({ $defs: { a: { $anchor: 'foo' } } }).keys()], ['foo']);
  });
});

describe('an anchor\'s target is read under the nearest $schema above it', () => {
  // undeclared root; the anchor sits under a 2020-12 resource, where a $ref's siblings apply
  const schema = {
    $defs: { S: {}, B: { $schema: D20, $defs: { C: { $anchor: 'c', $ref: '#/$defs/S', type: 'integer' } } } },
    properties: { q: { $ref: '#c' } },
  };

  it('the normalizer coerces by the target\'s sibling type (left \'12\' as sent)', () => {
    const validate = validator(schema);
    assert.deepEqual([validate({ q: '12' }), validate({ q: 12 })], [false, true]);
    const normalized = coerce(schema)({ q: '12' });
    assert.deepEqual([normalized, validate(normalized)], [{ q: 12 }, true]);
  });

  it('as a pointer to the same target is read', () => {
    const byPointer = { ...schema, properties: { q: { $ref: '#/$defs/B/$defs/C' } } };
    assert.deepEqual(coerce(byPointer)({ q: '12' }), { q: 12 });
  });

  it('and under a draft-07 place, the target is its $ref alone', () => {
    const under07 = { $schema: D20, $defs: { S: {}, B: { $schema: D07, definitions: { C: { $id: '#c', $ref: '#/$defs/S', type: 'integer' } } } }, properties: { q: { $ref: '#c' } } };
    const validate = validator(under07);
    assert.deepEqual([validate({ q: '12' }), coerce(under07)({ q: '12' })], [true, { q: '12' }]);
  });
});
