//@ts-check
/**
 * @file The defaults a normalizer checks are checked by a validator
 * configured as the host's: `createValidator` returns a new
 * `JarenValidator` with the host's options (`lengthUnit`), formats and held
 * documents, and is handed the normalizer's two bounds. Without it the
 * checks counted string length in graphemes whatever unit the host's
 * validator counts, asserted no `format`, and filled as written a default
 * beside a reference to a document only the host's validator holds.
 * Without the option every answer is as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { flagOutput } from '@jarenjs/validate/output';
import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';
import { stringFormats } from '@jarenjs/formats';
import { emitTypeScript } from '@jarenjs/emit';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
/** 'e' and a combining acute: one grapheme, two code points. */
const E = 'é';
/** @param {object} schema @param {unknown} input @param {object} [options] */
const normalized = (schema, input, options = {}) => compileNormalizer(schema, { useDefaults: true, ...options })(input);
/** A factory of code-point validators, and the bounds each call was handed. */
const codepoints = () => {
  /** @type {object[]} */
  const calls = [];
  /** @param {{ maxReferenceDepth: number, maxSchemaDepth: number }} bounds */
  const createValidator = (bounds) => {
    calls.push(bounds);
    return new JarenValidator({ lengthUnit: 'codepoint', ...bounds });
  };
  return { calls, createValidator };
};

describe('the checks count string length in the host validator\'s unit', () => {
  /** @type {[string, (bound: object) => object][]} The bound beside the default, and under a branch of the object declaring it */
  const shapes = [['for certain', (bound) => ({ properties: { s: { type: 'string', ...bound, default: E } } })],
    ['under a branch', (bound) => ({ properties: { s: { default: E } }, anyOf: [{ properties: { s: { type: 'string', ...bound } } }, { required: ['z'] }] })]];
  for (const [where, shape] of shapes) {
    it(`a default of two code points is left out beside maxLength: 1 and filled beside minLength: 2, ${where} (the reverse before)`, () => {
      const max = shape({ maxLength: 1 });
      const min = shape({ minLength: 2 });
      const { createValidator } = codepoints();
      assert.deepEqual(normalized(max, {}, { createValidator }), {});
      assert.deepEqual(normalized(min, {}, { createValidator }), { s: E });
      // the host's validator agrees with both outputs
      const host = new JarenValidator({ lengthUnit: 'codepoint' });
      assert.deepEqual([host.compile(max)({}), host.compile(min)({ s: E })], [true, true]);
      // without the option: graphemes, as before
      assert.deepEqual([normalized(max, {}), normalized(min, {})], [{ s: E }, {}]);
    });
  }

  it('is handed the normalizer\'s bounds, called once, and only where a default is checked', () => {
    const { calls, createValidator } = codepoints();
    const normalize = compileNormalizer({ properties: { s: { maxLength: 1, default: E }, t: { maxLength: 9, default: 'x' } } },
      { useDefaults: true, createValidator, maxReferenceDepth: 300, maxSchemaDepth: 150 });
    assert.deepEqual([normalize({}), normalize({ s: 'a' })], [{ t: 'x' }, { s: 'a', t: 'x' }]);
    assert.deepEqual(calls, [{ maxReferenceDepth: 300, maxSchemaDepth: 150 }]);
    compileNormalizer({ properties: { s: { maxLength: 1 } } }, { useDefaults: true, createValidator, coerceTypes: true });
    compileNormalizer({ properties: { s: { maxLength: 1, default: E } } }, { createValidator });
    assert.equal(calls.length, 1);
  });

  it('reads a collecting validator\'s answer, and an output format\'s, as the boolean one\'s', () => {
    const schema = { properties: { s: { type: 'string', maxLength: 1, default: E }, t: { type: 'string', minLength: 2, default: E } } };
    for (const options of [{ collectErrors: true }, { outputFormat: flagOutput }])
      assert.deepEqual(normalized(schema, {}, { createValidator: () => new JarenValidator({ lengthUnit: 'codepoint', ...options }) }), { t: E });
  });
});

describe('the checks assert the host validator\'s formats', () => {
  it('a default its registered format refuses is left out (it was filled), one it accepts is filled', () => {
    const schema = { type: 'object', properties: { a: { type: 'string', format: 'email', default: 'nope' }, b: { type: 'string', format: 'email', default: 'a@b.test' } } };
    const createValidator = () => new JarenValidator({ formatAssertion: true }).addFormats(stringFormats);
    assert.deepEqual(normalized(schema, {}, { createValidator }), { b: 'a@b.test' });
    assert.equal(createValidator().compile(schema)(normalized(schema, {}, { createValidator })), true);
    assert.deepEqual(normalized(schema, {}), { a: 'nope', b: 'a@b.test' });
  });
});

describe('the checks read the documents the host validator holds', () => {
  const lone = { $schema: D20, type: 'object', properties: { a: { $ref: 'https://x.test/other.json', default: 5 }, b: { $ref: 'https://x.test/other.json', default: 's' } } };
  const createValidator = () => new JarenValidator().addSchema({ $id: 'https://x.test/other.json', type: 'string' });

  it('a default beside a reference to one is decided (5 was filled as written)', () => {
    assert.deepEqual(normalized(lone, {}, { createValidator }), { b: 's' });
    assert.equal(createValidator().compile(lone)(normalized(lone, {}, { createValidator })), true);
    assert.deepEqual(normalized(lone, {}), { a: 5, b: 's' });
  });

  it('unfilledDefaults and @jarenjs/emit read the same checks', () => {
    assert.deepEqual([...unfilledDefaults(lone, { useDefaults: true, createValidator }).get(lone) ?? []], ['a']);
    assert.equal(unfilledDefaults(lone, { useDefaults: true }).size, 0);
    const ts = emitTypeScript(lone, { name: 'T', banner: false, normalize: { useDefaults: true, createValidator } });
    assert.match(ts, /export interface T \{\n(?:.*\n)*? {2}a\?: [^\n]*;\n {2}b: [^\n]*;\n/);
  });
});

describe('without the option, as before', () => {
  it('a root the checking validator cannot compile still answers none of the checks grouped with it', () => {
    const schema = { $schema: D20, maxProperties: 5, properties: { a: { $ref: '#/$defs/int', default: 'x' }, r: { $ref: 'https://other.test/x.json' } },
      $defs: { int: { type: 'integer' } } };
    assert.deepEqual(normalized(schema, {}), { a: 'x' });
  });
});

describe('the option is refused as the others are', () => {
  it('a createValidator that is no function, or returns no JarenValidator, is a TypeError', () => {
    const schema = { properties: { a: { type: 'integer', default: 1 } } };
    assert.throws(() => compileNormalizer(schema, { useDefaults: true, createValidator: /** @type {any} */ (new JarenValidator()) }),
      { name: 'TypeError', message: "compileNormalizer: 'createValidator' must be a function returning a new JarenValidator" });
    assert.throws(() => compileNormalizer(schema, { useDefaults: true, createValidator: /** @type {any} */ (() => ({})) }),
      { name: 'TypeError', message: "compileNormalizer: 'createValidator' must return a new JarenValidator" });
    assert.throws(() => unfilledDefaults(schema, { useDefaults: true, createValidator: /** @type {any} */ (null) }), { name: 'TypeError' });
  });

  it('a factory that leaves the bounds out checks under its own', () => {
    // the bounds are handed over; a validator built without them reads at its own defaults
    const tree = (/** @type {number} */ n) => { let t = /** @type {any} */ ({}); for (let i = 0; i < n; i++) t = { c: t }; return t; };
    const schema = { $schema: D20, properties: { t: { $ref: '#/$defs/tree', default: tree(300) } }, $defs: { tree: { type: 'object', properties: { c: { $ref: '#/$defs/tree' } } } } };
    assert.deepEqual(normalized(schema, {}, { maxReferenceDepth: 512, createValidator: (bounds) => new JarenValidator(bounds) }), { t: tree(300) });
    assert.deepEqual(normalized(schema, {}, { maxReferenceDepth: 512, createValidator: () => new JarenValidator() }), { t: tree(300) });
  });
});
