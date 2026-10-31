//@ts-check
/**
 * @file The readers handed a validator's dialects (`compileNormalizer`,
 * `deriveStrictProfile`, `@jarenjs/emit`) read a place as that validator
 * does: where the dialect governing it leaves the validation vocabulary out
 * of its `$vocabulary`, its validation keywords assert nothing, so no
 * reader types, requires, profiles or coerces by them. Elsewhere, and
 * without the option, they read the keywords as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, withoutUnreadVocabularies } from '@jarenjs/validate/normalize';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import { emitTypeScript } from '@jarenjs/emit';
import { VALIDATION_KEYWORDS } from '../../packages/validate/src/schema-keywords.js';
import { KEYWORD_SHAPES } from '../../packages/validate/src/keyword-values.js';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
const VOCAB = 'https://json-schema.org/draft/2020-12/vocab/';
const OFF = 'https://v.test/no-validation';
const holding = () => new JarenValidator().addMetaSchema({ $schema: D20, $id: OFF, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true } });
const reported = () => ({ $schema: OFF, type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] });

describe('the readers read the validation vocabulary where the governing dialect keeps it', () => {
  it('the reported input: the validator accepts { b: "n" } and {}, and so does every reader', () => {
    const dialects = holding();
    const validate = dialects.compile(reported());
    assert.deepEqual([validate({ b: 'n' }), validate({})], [true, true]);
    assert.equal(emitTypeScript(reported(), { name: 'T', banner: false, dialects }),
      'export type T = { b?: unknown; [key: string]: unknown; } | Array<unknown> | string | number | boolean | null;\n');
    const profile = deriveStrictProfile(reported(), { dialects });
    assert.equal(profile.schema.required?.includes('b') ?? false, false);
    assert.deepEqual(profile.fromProfile(profile.toProfile({ b: 'n' })), { b: 'n' });
    assert.deepEqual(compileNormalizer(reported(), { coerceTypes: true, dialects })({ b: '5' }), { b: '5' });
  });

  it('an embedded resource of the dialect drops them there only, and one of 2020-12 inside it reads them again', () => {
    const dialects = holding();
    const schema = { $schema: D20, type: 'object', properties: {
      n: { type: 'integer' },
      r: { $schema: OFF, $id: 'https://v.test/r.json', type: 'object', properties: { b: { type: 'integer' },
        s: { $schema: D20, $id: 'https://v.test/s.json', type: 'integer' } } } } };
    const normalize = compileNormalizer(schema, { coerceTypes: true, dialects });
    assert.deepEqual(normalize({ n: '1', r: { b: '2', s: '3' } }), { n: 1, r: { b: '2', s: 3 } });
    const validate = dialects.compile(schema);
    assert.deepEqual([validate({ n: 1, r: { b: 'x', s: 3 } }), validate({ n: 1, r: { b: 2, s: 'x' } })], [true, false]);
  });

  it('reads them as before without the option, and under a dialect that keeps them', () => {
    assert.deepEqual(compileNormalizer(reported(), { coerceTypes: true })({ b: '5' }), { b: 5 });
    const on = new JarenValidator().addMetaSchema({ $schema: D20, $id: OFF, $dynamicAnchor: 'meta', $vocabulary: { [`${VOCAB}core`]: true, [`${VOCAB}applicator`]: true, [`${VOCAB}validation`]: true } });
    assert.deepEqual(compileNormalizer(reported(), { coerceTypes: true, dialects: on })({ b: '5' }), { b: 5 });
    const document = reported();
    assert.equal(withoutUnreadVocabularies(document, { dialects: on }), document);
    assert.equal(withoutUnreadVocabularies(document), document);
  });

  it('reads the document once: the copy is read as itself, and values that are no schema are shared', () => {
    const dialects = holding();
    const fixed = { a: [1] };
    const document = { ...reported(), properties: { b: { type: 'integer', default: fixed } } };
    const read = /** @type {any} */ (withoutUnreadVocabularies(document, { dialects }));
    assert.deepEqual(read, { $schema: OFF, properties: { b: { default: fixed } } });
    assert.equal(read.properties.b.default, fixed);
    assert.equal(withoutUnreadVocabularies(read, { dialects }), read);
    assert.throws(() => withoutUnreadVocabularies(document, { dialects: {} }), { name: 'TypeError' });
    // the subschemas of every schema position, a map of maps included
    const positions = { $schema: OFF, allOf: [{ minimum: 1 }], $defs: { d: { maxLength: 2 } },
      propertyDependencies: { kind: { a: { required: ['x'], title: 't' } } } };
    assert.deepEqual(withoutUnreadVocabularies(positions, { dialects }),
      { $schema: OFF, allOf: [{}], $defs: { d: {} }, propertyDependencies: { kind: { a: { title: 't' } } } });
  });

  it('the validation keywords are the ones the validator switches with the vocabulary', () => {
    const switched = Object.keys(KEYWORD_SHAPES).filter((keyword) => KEYWORD_SHAPES[keyword][1]);
    assert.deepEqual([...VALIDATION_KEYWORDS].sort(), [...switched, 'const'].sort());
  });
});
