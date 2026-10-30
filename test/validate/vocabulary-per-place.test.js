//@ts-check
/**
 * @file A place reads the vocabularies of the dialect governing it — the
 * nearest `$schema` on the way to it in its own document — so a held
 * document answers alike compiled directly and through a `$ref`, and an
 * embedded resource declaring its own dialect is read by it. The
 * assertions a draft defaults (`format` before 2020-12, the content keywords
 * before 2019-09) follow the place's dialect too; the options still win.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, ValidatorOptions } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
const OFF = 'https://v.test/no-validation';
const KEY = 'https://v.test/held.json';

/** A validator holding a dialect extending 2020-12 without the validation vocabulary. @param {object} [options] */
const holding = (options) => new JarenValidator(options && new ValidatorOptions(options)).addFormats(stringFormats)
  .addMetaSchema({ $schema: D20, $id: OFF, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true } });

/**
 * The verdicts of a document compiled directly, then held under a key and
 * compiled as a `$ref` to it from a root declaring `from`.
 * @param {any} document @param {unknown[]} instances @param {string} [from] @param {object} [options]
 */
const alike = (document, instances, from, options) => {
  const direct = holding(options).compile(structuredClone(document));
  const referenced = holding(options).addSchema(structuredClone(document), KEY).compile({ ...(from ? { $schema: from } : {}), $ref: KEY });
  return [instances.map((instance) => direct(instance)), instances.map((instance) => referenced(instance))];
};

describe('a held document reads its own dialect\'s vocabularies, however it is compiled', () => {
  it('the reported input: no validation vocabulary, so nothing asserts either way (the $ref compile refused both)', () => {
    const document = { $schema: OFF, type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] };
    assert.deepEqual(alike(document, [{ b: 'n' }, {}]), [[true, true], [true, true]]);
    assert.deepEqual(alike(document, [{ b: 'n' }, {}], D20), [[true, true], [true, true]]);
  });

  it('a document of a dialect with the vocabulary asserts under a root without it (accepted "x")', () => {
    const validator = holding().addSchema({ $schema: D20, $id: 'https://v.test/int.json', type: 'integer' });
    const validate = validator.compile({ $schema: OFF, $ref: 'https://v.test/int.json', minimum: 5 });
    assert.deepEqual([validate('x'), validate(3)], [false, true]);
  });

  it('an embedded resource declaring its own dialect is read by it', () => {
    const off = holding().compile({ $schema: D20, properties: { r: { $id: 'https://v.test/r.json', $schema: OFF, type: 'integer' } } });
    assert.deepEqual([off({ r: 'x' }), off({ r: 1 })], [true, true]);
    const on = holding().compile({ $schema: OFF, properties: { r: { $id: 'https://v.test/r.json', $schema: D20, type: 'integer' } } });
    assert.deepEqual([on({ r: 'x' }), on({ r: 1 })], [false, true]);
  });
});

describe('the assertions a draft defaults follow the place\'s dialect', () => {
  it('format asserts in a draft-07 document, and annotates in a 2020-12 one, whatever the root declares', () => {
    const draft07 = { $schema: D07, $id: 'https://v.test/d7.json', type: 'string', format: 'email' };
    assert.deepEqual(alike(draft07, ['x', 'a@b.test'], D20), [[false, true], [false, true]]);
    const draft2020 = { $schema: D20, $id: 'https://v.test/d20.json', type: 'string', format: 'email' };
    assert.deepEqual(alike(draft2020, ['x', 'a@b.test'], D07), [[true, true], [true, true]]);
  });

  it('the content keywords assert in a draft-07 document whatever the root declares', () => {
    const draft07 = { $schema: D07, $id: 'https://v.test/c7.json', type: 'string', contentMediaType: 'application/json' };
    assert.deepEqual(alike(draft07, ['{', '{}'], D20), [[false, true], [false, true]]);
  });

  it('the formatAssertion and contentValidation options still decide everywhere', () => {
    const draft07 = { $schema: D07, $id: 'https://v.test/d7.json', type: 'string', format: 'email', contentMediaType: 'application/json' };
    assert.deepEqual(alike(draft07, ['x'], D20, { formatAssertion: false, contentValidation: false }), [[true], [true]]);
    const draft2020 = { $schema: D20, $id: 'https://v.test/d20.json', type: 'string', format: 'email' };
    assert.deepEqual(alike(draft2020, ['x'], D07, { formatAssertion: true }), [[false], [false]]);
  });
});
