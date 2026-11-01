//@ts-check
/**
 * @file A form field reads `exclusiveMinimum` and `exclusiveMaximum` as
 * the validator does (`getInclusiveExclusiveBounds` of `@jarenjs/core`):
 * a number is an exclusive bound of its own beside `minimum`/`maximum`,
 * and the draft-04 boolean modifies the bound beside it, `true` making it
 * exclusive and `false` leaving it inclusive. The field check compared
 * the value with the boolean itself, as the number it converts to, so
 * under `maximum: 5, exclusiveMaximum: true` it refused `4` ("less than
 * true"), under `exclusiveMaximum: false` it refused `0` and `5`, and
 * under `minimum: 5, exclusiveMinimum: true` it took `5`. The validator
 * reads both spellings under every draft, so the form model needs no
 * draft: the fixture holds each schema under every `$schema` and none.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { buildFormModel, validateAllFields } from '@jarenjs/forms';

const DRAFTS = [
  undefined,
  'http://json-schema.org/draft-04/schema#',
  'http://json-schema.org/draft-06/schema#',
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
];

/** Both spellings of both sides, alone, together, and with no bound beside the boolean. */
const BOUNDS = [
  { minimum: 5, exclusiveMinimum: true },
  { minimum: 5, exclusiveMinimum: false },
  { maximum: 5, exclusiveMaximum: true },
  { maximum: 5, exclusiveMaximum: false },
  { maximum: 0.5, exclusiveMaximum: true },
  { minimum: -0.5, exclusiveMinimum: true },
  { minimum: 0, exclusiveMinimum: true },
  { maximum: 0, exclusiveMaximum: true },
  { minimum: 3, exclusiveMinimum: true, maximum: 7, exclusiveMaximum: true },
  { minimum: 3, exclusiveMinimum: false, maximum: 7, exclusiveMaximum: true },
  { minimum: 3, exclusiveMinimum: true, maximum: 7, exclusiveMaximum: false },
  { exclusiveMinimum: true },
  { exclusiveMinimum: false },
  { exclusiveMaximum: true },
  { exclusiveMaximum: false },
  { minimum: '5', exclusiveMinimum: true },
  { exclusiveMinimum: 5 },
  { exclusiveMaximum: 5 },
  { minimum: 3, exclusiveMinimum: 5 },
  { maximum: 7, exclusiveMaximum: 5 },
  { minimum: 3, exclusiveMinimum: 5, maximum: 7, exclusiveMaximum: 6 },
];

/** At and around every limit above. */
const VALUES = [-2, -1, -0.5000001, -0.5, -0.4999999, -0, 0, 1e-9, 0.4999999, 0.5, 0.5000001, 1, 2,
  2.9999999, 3, 3.0000001, 4, 4.9999999, 5, 5.0000001, 6, 6.9999999, 7, 7.0000001, 8];

/** @param {unknown} value */
const label = (value) => (Object.is(value, -0) ? '-0' : JSON.stringify(value));

/** The form document for one bound schema under one draft. @param {string} type @param {object} bounds @param {string} [draft] */
const documentOf = (type, bounds, draft) => ({
  ...(draft === undefined ? {} : { $schema: draft }),
  type: 'object',
  properties: { n: { type, ...bounds } },
});

describe('a form field reads the exclusive bounds as the validator does', () => {
  it("gives the validator's answer at and around every limit, under every draft", () => {
    /** @type {string[]} */
    const wrong = [];
    let cases = 0;
    for (const type of ['number', 'integer']) {
      for (const bounds of BOUNDS) {
        /** @type {boolean[] | undefined} */
        let firstDraft;
        for (const draft of DRAFTS) {
          const document = documentOf(type, bounds, draft);
          const validate = new JarenValidator().compile(document);
          const model = buildFormModel(document);
          const answers = VALUES.map((value) => validate({ n: value }));
          // the validator reads both spellings alike under every draft
          firstDraft ??= answers;
          assert.deepEqual(answers, firstDraft, `${type} ${JSON.stringify(bounds)} under ${draft}`);
          VALUES.forEach((value, i) => {
            cases++;
            const errors = validateAllFields(model, { n: value })['/n'] ?? [];
            if ((errors.length === 0) !== answers[i]) {
              wrong.push(`${type} ${JSON.stringify(bounds)} ${label(value)} (${draft ?? 'no $schema'}): validator ${answers[i]}, form ${JSON.stringify(errors.map((e) => e.keyword))}`);
            }
          });
        }
      }
    }
    assert.equal(cases, 2 * BOUNDS.length * DRAFTS.length * VALUES.length);
    assert.deepEqual(wrong, []);
  });

  /** The errors of one value under one bound schema. @param {object} schema @param {number} value */
  const errorsOf = (schema, value) => validateAllFields(buildFormModel({ type: 'object', properties: { n: schema } }), { n: value });

  it('takes what the boolean leaves inside the bound, and names the bound it modifies', () => {
    const below = { type: 'number', maximum: 5, exclusiveMaximum: true };
    assert.deepEqual(errorsOf(below, 4), {});
    assert.deepEqual(errorsOf(below, 5), {
      '/n': [{ keyword: 'exclusiveMaximum', params: { limit: 5 }, msgid: 'form/exclusiveMaximum', message: 'Must be less than 5' }],
    });
    const upTo = { type: 'number', maximum: 5, exclusiveMaximum: false };
    assert.deepEqual(errorsOf(upTo, 0), {});
    assert.deepEqual(errorsOf(upTo, 5), {});
    assert.deepEqual(errorsOf(upTo, 6), {
      '/n': [{ keyword: 'maximum', params: { limit: 5 }, msgid: 'form/maximum', message: 'Must be at most 5' }],
    });
    assert.deepEqual(errorsOf({ minimum: 5, exclusiveMinimum: true }, 5), {
      '/n': [{ keyword: 'exclusiveMinimum', params: { limit: 5 }, msgid: 'form/exclusiveMinimum', message: 'Must be greater than 5' }],
    });
    assert.deepEqual(errorsOf({ minimum: 5, exclusiveMinimum: false }, 5), {});
  });

  it('reads a boolean with no bound beside it as no bound', () => {
    for (const value of [-1, 0, 1, 2]) {
      assert.deepEqual(errorsOf({ type: 'number', exclusiveMinimum: true }, value), {}, String(value));
      assert.deepEqual(errorsOf({ type: 'number', exclusiveMaximum: false }, value), {}, String(value));
    }
  });

  it('reads a bigint bound as bounding no number, as the validator does', () => {
    // the boolean beside a bigint bound made 5 refused; a bigint bounds no
    // number, as a bigint multipleOf step asserts nothing for one
    for (const [schema, value] of /** @type {[object, number][]} */ ([
      [{ type: 'number', minimum: 5n, exclusiveMinimum: true }, 5],
      [{ type: 'number', minimum: 5n }, 3],
      [{ type: 'integer', maximum: 5n, exclusiveMaximum: false }, 7],
      [{ type: 'number', minimum: 1, exclusiveMinimum: 5n }, 2],
    ])) {
      assert.equal(new JarenValidator().compile(schema)(value), true);
      assert.deepEqual(errorsOf(schema, value), {}, `${value}`);
    }
    assert.deepEqual(errorsOf({ type: 'number', minimum: 1, exclusiveMinimum: 5n }, 0), {
      '/n': [{ keyword: 'minimum', params: { limit: 1 }, msgid: 'form/minimum', message: 'Must be at least 1' }],
    });
  });

  it('reads a number as its own exclusive bound, as before', () => {
    assert.deepEqual(errorsOf({ type: 'number', exclusiveMinimum: 5 }, 5), {
      '/n': [{ keyword: 'exclusiveMinimum', params: { limit: 5 }, msgid: 'form/exclusiveMinimum', message: 'Must be greater than 5' }],
    });
    assert.deepEqual(errorsOf({ type: 'number', minimum: 3, exclusiveMaximum: '6' }, 6), {
      '/n': [{ keyword: 'exclusiveMaximum', params: { limit: '6' }, msgid: 'form/exclusiveMaximum', message: 'Must be less than 6' }],
    });
    assert.deepEqual(errorsOf({ type: 'number', minimum: 3, maximum: 7, exclusiveMaximum: 6 }, 2), {
      '/n': [{ keyword: 'minimum', params: { limit: 3 }, msgid: 'form/minimum', message: 'Must be at least 3' }],
    });
  });
});
