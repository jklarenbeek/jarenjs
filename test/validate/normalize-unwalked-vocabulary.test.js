//@ts-check
/**
 * @file A `$ref` target below a keyword no draft defines (an OpenAPI
 * document's `components/schemas`, an `x-` member) is read by the
 * normalizer under the dialect governing it — the nearest `$schema` on the
 * way to it — as the validator reads it, so it normalizes as the same
 * subschema under `$defs` does. Under a held dialect without the
 * validation vocabulary its `type` coerced a value the validator accepts
 * as sent. A target under a dialect that requires a vocabulary this
 * package does not implement is left as written, as before: refusing it
 * would refuse a document that compiles today.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
const OFF = 'https://v.test/no-validation';
const UNITS = 'https://v.test/needs-units';
const offDialect = () => ({ $schema: D20, $id: OFF, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true } });
const unitsDialect = () => ({ $schema: D20, $id: UNITS, $dynamicAnchor: 'meta',
  $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true, [`${VOCAB}validation`]: true, 'https://v.test/vocab/units': true } });
const holding = () => new JarenValidator().addMetaSchema(offDialect()).addMetaSchema(unitsDialect());

/**
 * What the normalizer makes of each instance under a document, and what the
 * validator holding the same dialects answers for the instance and for that.
 * @param {object} document @param {unknown[]} instances @param {object} [options]
 */
const both = (document, instances, options = { coerceTypes: true }) => {
  const normalize = compileNormalizer(document, { ...options, dialects: holding() });
  const validate = holding().compile(structuredClone(document));
  return instances.map((instance) => {
    const out = normalize(instance);
    return [out, validate(instance), validate(out)];
  });
};

describe('the normalizer reads a target below a keyword no draft defines under its own dialect', () => {
  it('the entry\'s schema: { v: "5" } is left as sent, as its $defs twin is (it was coerced to { v: 5 })', () => {
    const at = (/** @type {string} */ where) => ({ $schema: D20, properties: { v: { $ref: `#/${where}` } },
      x: { $schema: OFF, properties: { m: { type: 'integer' } } }, $defs: { m: { $schema: OFF, type: 'integer' } } });
    assert.deepEqual(both(at('x/properties/m'), [{ v: '5' }]), [[{ v: '5' }, true, true]]);
    assert.deepEqual(both(at('$defs/m'), [{ v: '5' }]), [[{ v: '5' }, true, true]]);
  });

  it('a document of that dialect, compiled itself: below the keyword and under $defs', () => {
    const document = (/** @type {string} */ ref) => ({ $schema: OFF, $ref: ref,
      components: { schemas: { p: { type: 'integer' }, o: { properties: { m: { type: 'integer' } } } } }, $defs: { q: { type: 'integer' } } });
    for (const ref of ['#/components/schemas/p', '#/$defs/q'])
      assert.deepEqual(both(document(ref), ['5']), [['5', true, true]], ref);
    assert.deepEqual(both(document('#/components/schemas/o'), [{ m: '5' }]), [[{ m: '5' }, true, true]]);
  });

  it('the dialect on the way restores the vocabulary its document leaves out, two unknown keywords deep too', () => {
    const restored = { $schema: OFF, properties: { v: { $ref: '#/x/properties/m' } }, x: { $schema: D20, properties: { m: { type: 'integer' } } } };
    assert.deepEqual(both(restored, [{ v: '5' }]), [[{ v: 5 }, false, true]]);
    const deep = { $schema: D20, properties: { v: { $ref: '#/x-outer/x-inner/p' } }, 'x-outer': { $schema: OFF, 'x-inner': { p: { type: 'integer' } } } };
    assert.deepEqual(both(deep, [{ v: '5' }]), [[{ v: '5' }, true, true]]);
    const plain = { $schema: D20, properties: { v: { $ref: '#/x-outer/x-inner/p' } }, 'x-outer': { 'x-inner': { p: { type: 'integer' } } } };
    assert.deepEqual(both(plain, [{ v: '5' }]), [[{ v: 5 }, false, true]]);
  });

  it('defaults read the same: a member count the dialect leaves out keeps no default out', () => {
    const at = (/** @type {string} */ dialect) => ({ $schema: D20, properties: { v: { $ref: '#/x/o' } },
      x: { $schema: dialect, o: { properties: { a: { default: 1 }, b: {} }, maxProperties: 1 } } });
    assert.deepEqual(both(at(OFF), [{ v: { b: 2 } }], { useDefaults: true }), [[{ v: { b: 2, a: 1 } }, true, true]]);
    assert.deepEqual(both(at(D20), [{ v: { b: 2 } }], { useDefaults: true }), [[{ v: { b: 2 } }, true, true]]);
  });

  it('a target of a dialect requiring an unimplemented vocabulary is read as written, and the document compiles as before', () => {
    const document = { $schema: D20, properties: { v: { $ref: '#/x/p' } }, x: { $schema: UNITS, p: { type: 'integer' } } };
    assert.deepEqual(compileNormalizer(document, { coerceTypes: true, dialects: holding() })({ v: '5' }), { v: 5 });
    // a document that reaches no such place normalizes whatever it holds there
    const unrelated = { $schema: D20, properties: { v: { type: 'integer' } }, x: { $schema: UNITS, p: { type: 'integer' } } };
    assert.deepEqual(compileNormalizer(unrelated, { coerceTypes: true, dialects: holding() })({ v: '5' }), { v: 5 });
    // under $defs, as before, it is refused when the normalizer compiles
    assert.throws(() => compileNormalizer({ $schema: D20, $defs: { p: { $schema: UNITS, type: 'integer' } } }, { dialects: holding() }),
      { name: 'SchemaCompileError', code: 'JK0016' });
  });

  it('data is not read as a schema: a default or an example keeps its members under a dialect without the vocabulary', () => {
    const document = { $schema: OFF, properties: { v: { default: { type: 'integer' }, examples: [{ type: 1 }] } }, 'x-a': { example: { type: 'kept' } } };
    assert.deepEqual(compileNormalizer(document, { useDefaults: true, dialects: holding() })({}), { v: { type: 'integer' } });
  });

  it('what no reference reaches below such a keyword stays as written: an annotation a predicate reads keeps its members', () => {
    const document = { $schema: OFF, properties: { a: { 'x-ui': { type: 'k', required: ['z'] }, type: 'string' }, v: { $ref: '#/components/schemas/p' } },
      components: { schemas: { p: { type: 'integer' } } } };
    /** @type {unknown[]} */
    const seen = [];
    const normalize = compileNormalizer(document, { coerceTypes: true, dialects: holding(),
      trimStrings: (node) => { if (node['x-ui'] !== undefined) seen.push(node['x-ui']); return false; } });
    assert.deepEqual(seen, [{ type: 'k', required: ['z'] }]);
    assert.deepEqual(normalize({ v: '5' }), { v: '5' });
  });

  it('a target inside a default is not read: the default is filled as written', () => {
    const document = { $schema: OFF, properties: { v: { $ref: '#/properties/d/default/s' }, d: { default: { s: { type: 'integer' } } } } };
    assert.deepEqual(compileNormalizer(document, { useDefaults: true, dialects: holding() })({}), { d: { s: { type: 'integer' } } });
  });
});
