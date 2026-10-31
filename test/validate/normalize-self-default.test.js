//@ts-check
/**
 * @file A default holding the object that declares it is filled once: its
 * copy runs through the schema that would fill it again, and inside its
 * own copy that default fills nothing more, whether the copy's own
 * normalizers or a later step's reach it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

const S = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Normalize each input with `useDefaults` (and the options given), and
 * answer the outputs.
 * @param {object} schema @param {unknown[]} inputs @param {object} [options]
 */
const outputs = (schema, inputs, options = {}) => {
  const normalize = compileNormalizer(schema, { useDefaults: true, ...options });
  return inputs.map((input) => normalize(input));
};

describe('a default holding the object that declares it is filled once', () => {
  it('fills the member of the schema object a $ref to the root declares', () => {
    const schema = { $schema: S, properties: { o: { $ref: '#', default: {} } } };
    assert.deepEqual(outputs(schema, [{}, { o: {} }, { o: 1 }, 5]),
      [{ o: {} }, { o: { o: {} } }, { o: 1 }, 5]);
  });

  it('places a default that holds the member as written', () => {
    const schema = { $schema: S, properties: { o: { $ref: '#', default: { o: {} } } } };
    assert.deepEqual(outputs(schema, [{}, { o: {} }]), [{ o: { o: {} } }, { o: { o: { o: {} } } }]);
  });

  it('fills each of two defaults that hold each other once on the way down', () => {
    const schema = { $schema: S, $ref: '#/$defs/a', $defs: {
      a: { properties: { b: { $ref: '#/$defs/b', default: {} } } },
      b: { properties: { a: { $ref: '#/$defs/a', default: {} } } },
    } };
    assert.deepEqual(outputs(schema, [{}, { o: 1 }]), [{ b: { a: {} } }, { o: 1, b: { a: {} } }]);
  });

  it('fills nothing more inside a copy a later allOf branch runs through the root', () => {
    const schema = { $schema: S, allOf: [{ properties: { o: { default: {} } } }, { properties: { o: { $ref: '#' } } }] };
    assert.deepEqual(outputs(schema, [{}, { o: {} }, { o: 1 }]), [{ o: {} }, { o: { o: {} } }, { o: 1 }]);
  });

  it('fills an item of an array default once', () => {
    const schema = { $schema: S, properties: { l: { type: 'array', items: { $ref: '#' }, default: [{}] } } };
    assert.deepEqual(outputs(schema, [{}, { l: [] }]), [{ l: [{}] }, { l: [] }]);
  });

  it('still coerces, and fills the other defaults, inside the copy', () => {
    const coerced = { $schema: S, properties: { o: { $ref: '#', default: { n: '1' } }, n: { type: 'number' } } };
    assert.deepEqual(outputs(coerced, [{}], { coerceTypes: true }), [{ o: { n: 1 } }]);
    const sibling = { $schema: S, properties: { o: { $ref: '#', default: {} }, k: { default: 1 } } };
    assert.deepEqual(outputs(sibling, [{}, { o: {} }]), [{ o: { k: 1 }, k: 1 }, { o: { o: { k: 1 }, k: 1 }, k: 1 }]);
  });

  it('checks the copy as it is filled: one its own schema refuses is not filled', () => {
    const schema = { $schema: S, properties: { o: { $ref: '#', default: {} } }, required: ['o'] };
    assert.deepEqual(outputs(schema, [{}, { o: {} }, { o: { o: 1 } }]), [{}, { o: {} }, { o: { o: 1 } }]);
  });

  it('answers a value the validator accepts, and leaves the input as it was', () => {
    const schema = { $schema: S, properties: { o: { $ref: '#', default: {} }, n: { type: 'integer', default: 0 } } };
    const input = Object.freeze({});
    const [out] = outputs(schema, [input]);
    assert.deepEqual(out, { o: { n: 0 }, n: 0 });
    assert.deepEqual(input, {});
    assert.equal(new JarenValidator().compile(schema)(out), true);
  });
});
