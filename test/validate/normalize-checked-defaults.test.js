//@ts-check
/**
 * @file The validator decides each default the normalizer fills, against
 * the schemas it meets at its place: one a schema applying there for
 * certain refuses (its own, another object's schema for the member, an
 * `additionalProperties` or `patternProperties` it meets, a `false` member
 * schema, `propertyNames`) is never filled; one that can change another
 * answer (a member count, a requirement its presence brings into force, the
 * whole object compared, a branch reading it) is filled per instance, where
 * every schema applied at the place still answers as without it. The
 * normalized value of an instance the validator accepts is accepted too,
 * and a fill the validator accepts is kept.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';
import { emitTypeScript } from '@jarenjs/emit';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The normalized value, and the validator's verdicts on the input and on it.
 * @param {any} schema @param {unknown} input @param {object} [options]
 */
const run = (schema, input, options = {}) => {
  const validate = new JarenValidator().compile(schema);
  const output = compileNormalizer(schema, { useDefaults: true, ...options })(structuredClone(input));
  return [output, validate(structuredClone(input)), validate(output)];
};

describe('a default a keyword other than a by-name closer refuses', () => {
  it('a schema-valued additionalProperties the member meets (was { a: "x" })', () => {
    const schema = { allOf: [{ properties: { a: { default: 'x' } } }], additionalProperties: { type: 'integer' } };
    assert.deepEqual(run(schema, {}), [{}, true, true]);
    assert.deepEqual(run({ ...schema, additionalProperties: { type: 'string' } }, {}), [{ a: 'x' }, true, true]);
  });

  it('dependentRequired: filled only beside the member it requires (was { a: 1 } for {})', () => {
    const schema = { $schema: D20, properties: { a: { default: 1 }, b: {} }, dependentRequired: { a: ['b'] } };
    assert.deepEqual(run(schema, {}), [{}, true, true]);
    assert.deepEqual(run(schema, { b: 2 }), [{ b: 2, a: 1 }, true, true]);
    const dependencies = { $schema: D07, properties: { a: { default: 1 }, b: {} }, dependencies: { a: ['b'] } };
    assert.deepEqual(run(dependencies, {}), [{}, true, true]);
    assert.deepEqual(run(dependencies, { b: 2 }), [{ b: 2, a: 1 }, true, true]);
  });

  it('maxProperties: filled while the object has room (was { a: 1 } under 0)', () => {
    assert.deepEqual(run({ properties: { a: { default: 1 } }, maxProperties: 0 }, {}), [{}, true, true]);
    const one = { properties: { a: { default: 1 } }, maxProperties: 1 };
    assert.deepEqual(run(one, {}), [{ a: 1 }, true, true]);
    assert.deepEqual(run(one, { b: 2 }), [{ b: 2 }, true, true]);
    // two that do not fit together: one by one, in their order
    assert.deepEqual(run({ properties: { a: { default: 1 }, b: { default: 2 } }, maxProperties: 1 }, {}), [{ a: 1 }, true, true]);
  });

  it('a false member schema in another allOf branch (was { a: 1 })', () => {
    assert.deepEqual(run({ allOf: [{ properties: { a: { default: 1 } } }, { properties: { a: false } }] }, {}), [{}, true, true]);
  });

  it('dependentSchemas bringing a closer of the other members into force (was { b: 1, a: 1 })', () => {
    const schema = { $schema: D20, properties: { a: { default: 1 }, b: {} }, dependentSchemas: { a: { properties: { a: {} }, additionalProperties: false } } };
    assert.deepEqual(run(schema, { b: 1 }), [{ b: 1 }, true, true]);
    assert.deepEqual(run(schema, {}), [{ a: 1 }, true, true]);
  });

  it('a default its own schema refuses (was filled as written)', () => {
    assert.deepEqual(run({ properties: { a: { type: 'integer', default: 'x' } } }, {}), [{}, true, true]);
    assert.deepEqual(run({ properties: { a: { enum: ['p', 'q'], default: 'r' } } }, {}), [{}, true, true]);
    assert.deepEqual(run({ $schema: D20, $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s', default: 5 } } }, {}), [{}, true, true]);
  });

  it('propertyNames, the whole object compared, and a member\'s presence read under not, if or oneOf', () => {
    const own = { properties: { a: { default: 1 } } };
    assert.deepEqual(run({ ...own, propertyNames: { pattern: '^b' } }, {}), [{}, true, true]);
    assert.deepEqual(run({ ...own, enum: [{}, { b: 1 }] }, {}), [{}, true, true]);
    assert.deepEqual(run({ ...own, enum: [{}, { a: 1 }] }, {}), [{ a: 1 }, true, true]);
    assert.deepEqual(run({ ...own, const: {} }, {}), [{}, true, true]);
    assert.deepEqual(run({ ...own, not: { required: ['a'] } }, {}), [{}, true, true]);
    assert.deepEqual(run({ ...own, if: { required: ['a'] }, then: { required: ['z'] } }, {}), [{}, true, true]);
    assert.deepEqual(run({ ...own, if: { required: ['a'] }, then: { required: ['z'] } }, { z: 1 }), [{ z: 1, a: 1 }, true, true]);
    assert.deepEqual(run({ ...own, oneOf: [{ required: ['a'] }, {}] }, {}), [{}, true, true]);
    assert.deepEqual(run({ $schema: D20, ...own, not: { dependentRequired: { z: ['a'] } } }, { z: 1 }), [{ z: 1 }, true, true]);
  });

  it('a branch of the place above may not come to accept the object: oneOf counts it (was { o: { a: 1 } })', () => {
    const schema = { properties: { o: { properties: { a: { default: 1 } } } }, oneOf: [{ properties: { o: { required: ['a'] } } }, {}] };
    assert.deepEqual(run(schema, { o: {} }), [{ o: {} }, true, true]);
  });

  it('a default is checked under the dialect governing its place (draft-07 reads no dependentRequired)', () => {
    const member = { type: 'object', dependentRequired: { x: ['y'] }, default: { x: 1 } };
    assert.deepEqual(run({ $schema: D07, properties: { a: member } }, {}), [{ a: { x: 1 } }, true, true]);
    assert.deepEqual(run({ $schema: D20, properties: { a: member } }, {}), [{}, true, true]);
    // a dialect a validator holds, read through it: one extending 2020-12 reads prefixItems
    const MINE = 'https://v.test/mine';
    const dialects = new JarenValidator().addSchema({ $id: MINE, $schema: D20 });
    const schema = { $schema: MINE, $defs: { n: { type: 'integer' } }, properties: { a: { prefixItems: [{ $ref: '#/$defs/n' }], default: ['x'] } } };
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true, dialects })({}), {});
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true })({}), { a: ['x'] });
  });

  it('an item contains may or may not match: filled where its answer does not change', () => {
    const schema = { $schema: D20, items: { properties: { a: { default: 1 } } }, contains: { properties: { a: false }, required: ['z'] } };
    assert.deepEqual(run(schema, [{}, { z: 1 }]), [[{ a: 1 }, { z: 1 }], true, true]);
  });

  it('a child place: the closer or schema another object applies to the member\'s value', () => {
    const schema = { allOf: [{ properties: { o: { properties: { a: { default: 'x' } } } } }, { properties: { o: { maxProperties: 0 } } }] };
    assert.deepEqual(run(schema, { o: {} }), [{ o: {} }, true, true]);
    const items = { allOf: [{ items: { properties: { a: { default: 'x' } } } }, { items: { additionalProperties: { type: 'integer' } } }] };
    assert.deepEqual(run(items, [{}, { b: 1 }]), [[{}, { b: 1 }], true, true]);
  });
});

describe('a fill the validator accepts is kept', () => {
  it('the steps after the one filling a member decide its value: a later branch coerces or fills it', () => {
    const options = { coerceTypes: true };
    const coercing = { properties: { count: { type: 'integer' } } };
    const defaulting = { properties: { count: { default: '42' } } };
    assert.deepEqual(run({ allOf: [defaulting, coercing] }, {}, options), [{ count: 42 }, true, true]);
    assert.deepEqual(run({ allOf: [coercing, defaulting] }, {}, options), [{}, true, true]);
    assert.deepEqual(run({ $schema: D20, $defs: { d: defaulting }, $ref: '#/$defs/d', ...coercing }, {}, options), [{ count: 42 }, true, true]);
    assert.deepEqual(run({ allOf: [defaulting], ...coercing }, {}, options), [{ count: 42 }, true, true]);
    const nested = { allOf: [{ properties: { o: { default: {} } } }, { properties: { o: { properties: { x: { default: 1 } }, required: ['x'] } } }] };
    assert.deepEqual(run(nested, {}), [{ o: { x: 1 } }, true, true]);
    assert.deepEqual(run({ allOf: [nested.allOf[1], nested.allOf[0]] }, {}), [{}, true, true]);
  });

  it('a branch the filled member makes the instance leave, as a tool schema writes a mode', () => {
    const schema = { type: 'object', properties: { mode: { enum: ['basic', 'advanced'], default: 'basic' }, budget: { type: 'integer' } },
      if: { properties: { mode: { const: 'advanced' } } }, then: { required: ['budget'] } };
    assert.deepEqual(run(schema, { budget: 5 }), [{ budget: 5, mode: 'basic' }, true, true]);
  });

  it('a tool schema whose defaults its own schemas accept fills as before', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, default: 10 },
      mode: { enum: ['fast', 'slow'], default: 'fast' }, opts: { type: 'object', properties: { depth: { type: 'integer', default: 2 } }, default: {} } },
    required: ['q'], additionalProperties: false };
    assert.deepEqual(run(schema, { q: 's' }), [{ q: 's', limit: 10, mode: 'fast', opts: { depth: 2 } }, true, true]);
    assert.deepEqual(unfilledDefaults(schema, { useDefaults: true }), new Map());
  });

  it('a default holding the object that declares it compiles as before (its copy would fill itself without end)', () => {
    const schema = { $schema: D20, properties: { o: { $ref: '#', default: {} } } };
    assert.equal(typeof compileNormalizer(schema, { useDefaults: true }), 'function');
    assert.deepEqual(unfilledDefaults(schema, { useDefaults: true }), new Map());
  });

  it('a document the validator cannot compile alone (a reference to another document) fills as written', () => {
    const schema = { $schema: D20, properties: { a: { $ref: 'https://other.test/x.json', default: 1 }, b: { type: 'integer', default: 'x' } } };
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true })({}), { a: 1, b: 'x' });
    const counted = { $schema: D20, properties: { a: { default: 1 }, r: { $ref: 'https://other.test/x.json' } }, maxProperties: 0 };
    assert.deepEqual(compileNormalizer(counted, { useDefaults: true })({}), { a: 1 });
  });
});

describe('the defaults left out, as unfilledDefaults and @jarenjs/emit read them', () => {
  it('names a default never filled and one filled per instance, by the object declaring it', () => {
    const schema = { $schema: D20, type: 'object', properties: { a: { type: 'integer', default: 'x' }, b: { default: 1 }, c: { default: 2 } }, dependentRequired: { b: ['z'] } };
    const unfilled = unfilledDefaults(schema, { useDefaults: true });
    assert.deepEqual([...unfilled.get(schema) ?? []].sort(), ['a', 'b']);
    const ts = emitTypeScript(schema, { name: 'T', banner: false, normalize: { useDefaults: true } });
    assert.match(ts, /export interface T \{\n(?:.*\n)*? {2}a\?: number;\n {2}b\?: unknown;\n {2}c: unknown;\n/);
  });
});
