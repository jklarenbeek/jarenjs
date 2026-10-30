//@ts-check
/**
 * @file A default the normalizer fills is a member every schema object that
 * may apply at its place admits by its name. One that an
 * `additionalProperties: false` beside a `$ref` or in another `allOf` branch
 * refuses, or that an `unevaluatedProperties: false` does not evaluate, is
 * not filled: the normalized value of an instance the validator accepts is
 * accepted too.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
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
const CLOSED = () => ({ properties: { b: {} }, additionalProperties: false });

describe('a default a schema object at its place refuses is not filled', () => {
  it('beside a $ref (was { a: "x" }, which the validator refuses)', () => {
    const schema = { $schema: D20, $defs: { s: { type: 'object', properties: { a: { type: 'string', default: 'x' } } } }, $ref: '#/$defs/s', properties: { b: { type: 'integer' } }, additionalProperties: false };
    assert.deepEqual(run(schema, {}), [{}, true, true]);
    assert.deepEqual(run(schema, { b: 1 }), [{ b: 1 }, true, true]);
  });

  it('in an allOf branch (was { a: "x" })', () => {
    const schema = { allOf: [{ properties: { a: { default: 'x' } } }], properties: { b: {} }, additionalProperties: false };
    assert.deepEqual(run(schema, {}), [{}, true, true]);
  });

  it('closed by another allOf branch or a $ref target, in every draft that reads them', () => {
    for (const $schema of [D07, D19, D20, undefined]) {
      const branch = { $schema, properties: { a: { default: 'x' } }, allOf: [CLOSED()] };
      assert.deepEqual(run(branch, { b: 1 }), [{ b: 1 }, true, true], String($schema));
    }
    for (const $schema of [D19, D20]) {
      const target = { $schema, $defs: { c: CLOSED() }, properties: { a: { default: 'x' } }, $ref: '#/$defs/c' };
      assert.deepEqual(run(target, {}), [{}, true, true], $schema);
    }
  });

  it('an unevaluatedProperties: false that does not evaluate the member', () => {
    for (const $schema of [D19, D20]) {
      const sibling = { $schema, allOf: [{ properties: { a: { default: 'x' } } }, { properties: { b: {} }, unevaluatedProperties: false }] };
      assert.deepEqual(run(sibling, {}), [{}, true, true], $schema);
      const target = { $schema, $defs: { c: { unevaluatedProperties: false } }, properties: { a: { default: 'x' } }, $ref: '#/$defs/c' };
      assert.deepEqual(run(target, {}), [{}, true, true], $schema);
    }
  });

  it('a schema object under a branch the instance may take refuses it', () => {
    // which branch applies is known only after validating: a closer in any
    // branch keeps the member out, even where another branch would pass
    const closer = (/** @type {object} */ rest) => ({ properties: { a: { default: 'x' } }, ...rest });
    assert.deepEqual(run(closer({ anyOf: [CLOSED(), { required: ['z'] }] }), {}), [{}, true, true]);
    assert.deepEqual(run(closer({ oneOf: [CLOSED(), { required: ['z'] }] }), {}), [{}, true, true]);
    assert.deepEqual(run(closer({ if: {}, then: CLOSED() }), {}), [{}, true, true]);
    assert.deepEqual(run(closer({ not: { not: CLOSED() } }), {}), [{}, true, true]);
    assert.deepEqual(run(closer({ anyOf: [CLOSED(), {}] }), {}), [{}, true, true]);
    // a schema dependency, which applies once its member is present
    assert.deepEqual(run(closer({ dependencies: { c: ['b'], b: CLOSED() } }), { b: 1 }), [{ b: 1 }, true, true]);
    assert.deepEqual(run({ $schema: D20, ...closer({ dependentSchemas: { b: CLOSED() } }) }, { b: 1 }), [{ b: 1 }, true, true]);
  });

  it('at a member\'s place, a closer another object applies there refuses it', () => {
    const branches = { allOf: [{ properties: { o: { properties: { a: { default: 'x' } } } } }, { properties: { o: CLOSED() } }] };
    assert.deepEqual(run(branches, { o: {} }), [{ o: {} }, true, true]);
    const pattern = { properties: { o: { properties: { a: { default: 'x' } } } }, patternProperties: { '^o$': CLOSED() } };
    assert.deepEqual(run(pattern, { o: {} }), [{ o: {} }, true, true]);
    const items = { allOf: [{ items: { properties: { a: { default: 'x' } } } }, { items: CLOSED() }] };
    assert.deepEqual(run(items, [{}, { b: 1 }]), [[{}, { b: 1 }], true, true]);
    // a default under a pattern or under additionalProperties, a closer the other object applies to the same member
    const underPattern = { properties: { o: CLOSED() }, patternProperties: { '^o$': { properties: { a: { default: 'x' } } } } };
    assert.deepEqual(run(underPattern, { o: {} }), [{ o: {} }, true, true]);
    const underAdditional = { properties: { q: {} }, additionalProperties: { properties: { a: { default: 'x' } } }, allOf: [{ additionalProperties: CLOSED() }] };
    assert.deepEqual(run(underAdditional, { p: {} }), [{ p: {} }, true, true]);
  });

  it('a closer a dynamic reference may resolve to refuses it', () => {
    const schema = { $schema: D20, $defs: { c: { $dynamicAnchor: 'c', ...CLOSED() } }, properties: { a: { default: 'x' } }, allOf: [{ $dynamicRef: '#c' }] };
    assert.deepEqual(run(schema, {}), [{}, true, true]);
  });
});

describe('a default every object at its place admits is filled as before', () => {
  it('the closed object declaring it, and a $ref target closed by its own declaration', () => {
    assert.deepEqual(run({ properties: { a: { default: 'x' }, b: {} }, additionalProperties: false }, {}), [{ a: 'x' }, true, true]);
    const tool = { $schema: D20, type: 'object', properties: { foo: { $ref: '#/$defs/Foo' } }, required: ['foo'], additionalProperties: false,
      $defs: { Foo: { type: 'object', properties: { unit: { type: 'string', default: 'c' } }, additionalProperties: false } } };
    assert.deepEqual(run(tool, { foo: {} }), [{ foo: { unit: 'c' } }, true, true]);
  });

  it('a closer declaring the member by name or by pattern', () => {
    const named = { properties: { a: { default: 'x' } }, allOf: [{ properties: { a: {}, b: {} }, additionalProperties: false }] };
    assert.deepEqual(run(named, {}), [{ a: 'x' }, true, true]);
    const pattern = { properties: { a: { default: 'x' } }, allOf: [{ patternProperties: { '^a$': {} }, additionalProperties: false }] };
    assert.deepEqual(run(pattern, {}), [{ a: 'x' }, true, true]);
  });

  it('an unevaluatedProperties: false that evaluates it through a $ref or an allOf branch', () => {
    for (const $schema of [D19, D20]) {
      const ref = { $schema, $defs: { s: { properties: { a: { default: 'x' } } } }, $ref: '#/$defs/s', unevaluatedProperties: false };
      assert.deepEqual(run(ref, {}), [{ a: 'x' }, true, true], $schema);
      const branch = { $schema, allOf: [{ properties: { a: { default: 'x' } } }], unevaluatedProperties: false };
      assert.deepEqual(run(branch, {}), [{ a: 'x' }, true, true], $schema);
    }
  });

  it('draft-07 reads a $ref alone and unevaluatedProperties as no keyword: neither closes the place', () => {
    for (const $schema of [D07, undefined]) {
      const ref = { $schema, definitions: { s: { properties: { a: { default: 'x' } } } }, $ref: '#/definitions/s', additionalProperties: false };
      assert.deepEqual(run(ref, {}), [{ a: 'x' }, true, true], String($schema));
    }
    const unevaluated = { $schema: D07, allOf: [{ properties: { a: { default: 'x' } } }], unevaluatedProperties: false };
    assert.deepEqual(run(unevaluated, {}), [{ a: 'x' }, true, true]);
  });

  it('removeAdditional strips what it stripped, beside a default it keeps out', () => {
    const schema = { allOf: [{ properties: { a: { default: 'x' } } }], properties: { b: {} }, additionalProperties: false };
    assert.deepEqual(run(schema, { b: 1, c: 2 }, { removeAdditional: true }), [{ b: 1 }, false, true]);
  });
});

describe('unfilledDefaults', () => {
  it('names, by the object declaring it, each default a place leaves unfilled', () => {
    const schema = { $schema: D20, $defs: { s: { properties: { a: { default: 'x' }, c: { default: 1 } } } }, $ref: '#/$defs/s', properties: { b: {}, c: {} }, additionalProperties: false };
    const unfilled = unfilledDefaults(schema, { useDefaults: true });
    assert.deepEqual([...unfilled].map(([holder, keys]) => [holder === schema.$defs.s, [...keys]]), [[true, ['a']]]);
  });

  it('is empty where defaults are not filled or nothing refuses them', () => {
    const schema = { allOf: [{ properties: { a: { default: 'x' } } }], additionalProperties: false };
    assert.equal(unfilledDefaults(schema).size, 0);
    assert.equal(unfilledDefaults(schema, { useDefaults: false }).size, 0);
    assert.equal(unfilledDefaults({ allOf: [{ properties: { a: { default: 'x' } } }] }, { useDefaults: true }).size, 0);
  });

  it('refuses options compileNormalizer refuses', () => {
    assert.throws(() => unfilledDefaults({}, /** @type {any} */ ({ useDefault: true })), TypeError);
  });
});
