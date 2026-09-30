//@ts-check
/**
 * @file The one nullable normalizer (`@jarenjs/core/schema`): the
 * structural split forms and the transport compiler read, and the
 * value-exact canonical spelling the contract diff reads. The two
 * spellings — `{ type: [T, 'null'] }` and a two-branch `anyOf`/`oneOf`
 * with a null-only branch — are one meaning only when they accept the
 * same values, and every case that keeps them apart is pinned here
 * against the validator itself, so the table cannot drift from what the
 * validator does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  splitNullable, canonicalNullable, TYPE_SCOPED_KEYWORDS, ANNOTATION_KEYWORDS,
  STRING_CONSTRAINTS, NUMERIC_CONSTRAINTS, ARRAY_CONSTRAINTS, OBJECT_CONSTRAINTS,
} from '@jarenjs/core/schema';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, dateTimeFormats } from '@jarenjs/formats';

const validator = () => new JarenValidator({ formatAssertion: true })
  .addFormats(stringFormats).addFormats(dateTimeFormats);

/** Values of every JSON type, the ones that separate the spellings among them. */
const PROBES = [null, '', 'ab', 'abc', '2026-09-30', 'x@y.z', 0, 1.5, 7, -3, true, false,
  [], [1], ['a', 'b'], {}, { a: 1 }, { a: 'x', b: 2 }];

/**
 * Whether two schemas accept exactly the same probes.
 * @param {any} a
 * @param {any} b
 */
function sameVerdicts(a, b) {
  const va = validator().compile(a);
  const vb = validator().compile(b);
  return PROBES.every((probe) => va(probe) === vb(probe));
}

describe('the keyword tables', () => {
  it('compose the shared groups, their order kept, and list each annotation once', () => {
    assert.deepStrictEqual(TYPE_SCOPED_KEYWORDS.string.slice(0, STRING_CONSTRAINTS.length), [...STRING_CONSTRAINTS]);
    assert.deepStrictEqual([...TYPE_SCOPED_KEYWORDS.number], [...NUMERIC_CONSTRAINTS]);
    assert.deepStrictEqual([...TYPE_SCOPED_KEYWORDS.integer], [...NUMERIC_CONSTRAINTS]);
    assert.deepStrictEqual(TYPE_SCOPED_KEYWORDS.array.slice(0, ARRAY_CONSTRAINTS.length), [...ARRAY_CONSTRAINTS]);
    assert.deepStrictEqual(TYPE_SCOPED_KEYWORDS.object.slice(0, OBJECT_CONSTRAINTS.length), [...OBJECT_CONSTRAINTS]);
    assert.strictEqual(new Set(ANNOTATION_KEYWORDS).size, ANNOTATION_KEYWORDS.length);
    assert.ok(Object.isFrozen(TYPE_SCOPED_KEYWORDS) && Object.isFrozen(TYPE_SCOPED_KEYWORDS.string));
  });

  it('every type-scoped keyword accepts null in the validator (the property the canonical form rests on)', () => {
    /** @type {Record<string, any>} */
    const sample = {
      minLength: 2, maxLength: 3, pattern: '^a', format: 'email', formatMinimum: '2026-01-01',
      formatMaximum: '2026-12-31', formatExclusiveMinimum: '2026-01-01', formatExclusiveMaximum: '2026-12-31',
      contentEncoding: 'base64', contentMediaType: 'application/json', contentSchema: { type: 'object' },
      minimum: 1, maximum: 2, exclusiveMinimum: 0, exclusiveMaximum: 3, multipleOf: 2,
      minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' }, prefixItems: [{ type: 'string' }],
      contains: { type: 'string' }, minContains: 1, maxContains: 2, unevaluatedItems: false,
      minProperties: 1, maxProperties: 2, properties: { a: { type: 'string' } },
      patternProperties: { '^a': { type: 'string' } }, additionalProperties: false, required: ['a'],
      propertyNames: { maxLength: 1 }, dependentRequired: { a: ['b'] }, dependentSchemas: { a: { required: ['b'] } },
      unevaluatedProperties: false,
    };
    for (const [type, keywords] of Object.entries(TYPE_SCOPED_KEYWORDS)) {
      for (const keyword of keywords) {
        const schema = { type: [type, 'null'], [keyword]: sample[keyword] };
        if (keyword === 'formatMinimum' || keyword.startsWith('formatExclusive') || keyword === 'formatMaximum') schema.format = 'date';
        assert.strictEqual(validator().compile(schema)(null), true, `${type}.${keyword} refuses null`);
      }
    }
  });
});

describe('splitNullable — structural', () => {
  it('gives the type array\'s non-null node, and a two-branch union\'s non-null branch with the node\'s annotations', () => {
    assert.deepStrictEqual(splitNullable({ type: ['string', 'null'], minLength: 2 }),
      { schema: { type: 'string', minLength: 2 }, nullable: true });
    assert.deepStrictEqual(splitNullable({ type: ['null', 'integer'] }), { schema: { type: 'integer' }, nullable: true });
    assert.deepStrictEqual(splitNullable({ title: 'Due', anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }),
      { schema: { type: 'string', format: 'date', title: 'Due' }, nullable: true });
    for (const nullOnly of [{ type: 'null' }, { const: null }, { enum: [null] }, { type: 'null', title: 'none' }]) {
      assert.deepStrictEqual(splitNullable({ oneOf: [nullOnly, { $ref: '#/$defs/A' }] }),
        { schema: { $ref: '#/$defs/A' }, nullable: true }, JSON.stringify(nullOnly));
    }
  });

  it('is null for anything else', () => {
    for (const schema of [
      { type: 'string' }, { type: ['string', 'integer', 'null'] }, { type: 'null' }, { enum: ['a', null] },
      { anyOf: [{ type: 'string' }, { type: 'null' }], $query: { $gt: ['$', 1] } },
      { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
      { anyOf: [{ type: 'null' }, { const: null }] },
      { anyOf: [{ type: 'string' }, { type: 'null' }], minLength: 1 },
      true, null, 'x', [],
    ]) {
      assert.strictEqual(splitNullable(schema), null, JSON.stringify(schema));
    }
  });

  it('never modifies its input', () => {
    const schema = Object.freeze({ anyOf: Object.freeze([Object.freeze({ type: 'string' }), Object.freeze({ type: 'null' })]) });
    assert.doesNotThrow(() => splitNullable(schema));
    const typed = Object.freeze({ type: Object.freeze(['string', 'null']) });
    assert.deepStrictEqual(splitNullable(typed)?.schema, { type: 'string' });
  });
});

describe('canonicalNullable — value-exact', () => {
  const equal = [
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: ['string', 'null'] }],
    [{ oneOf: [{ type: 'null' }, { type: 'string', minLength: 2, format: 'email' }] }, { type: ['string', 'null'], minLength: 2, format: 'email' }],
    [{ anyOf: [{ type: 'integer', minimum: 1, maximum: 9 }, { const: null }] }, { type: ['null', 'integer'], minimum: 1, maximum: 9 }],
    [{ anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, { type: 'null' }] },
      { type: ['object', 'null'], properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }],
    [{ anyOf: [{ type: 'array', items: { type: 'string' }, minItems: 1 }, { enum: [null] }] }, { type: ['array', 'null'], items: { type: 'string' }, minItems: 1 }],
    [{ title: 'Due', anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] }, { title: 'Due', type: ['string', 'null'], format: 'date' }],
    [{ default: 'x', anyOf: [{ type: 'string' }, { type: 'null' }] }, { type: ['string', 'null'], default: 'x' }],
  ];
  for (const [union, array] of equal) {
    it(`one spelling for ${JSON.stringify(union)}`, () => {
      const a = canonicalNullable(union);
      const b = canonicalNullable(array);
      assert.notStrictEqual(a, null);
      assert.deepStrictEqual(a, b);
      assert.ok(sameVerdicts(union, array), 'the validator agrees they accept the same values');
    });
  }

  it('keeps the spellings apart whenever the value sets can differ', () => {
    const apart = [
      // the check runs on null in the type array and not in the union
      { anyOf: [{ type: 'string', $query: { $gt: [{ '$string-length': '$' }, 2] } }, { type: 'null' }] },
      { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
      { anyOf: [{ type: 'string', const: 'a' }, { type: 'null' }] },
      { anyOf: [{ type: 'string', allOf: [{ type: 'string' }] }, { type: 'null' }] },
      { anyOf: [{ $ref: '#/$defs/A' }, { type: 'null' }] },
      { anyOf: [{ type: 'string', minimum: 2 }, { type: 'null' }] },
      { anyOf: [{ type: 'string', default: 'x' }, { type: 'null' }] },
      { anyOf: [{ type: 'string', 'x-trim': true }, { type: 'null' }] },
      { title: 'a', anyOf: [{ type: 'string', title: 'b' }, { type: 'null' }] },
      { type: ['string', 'null'], $query: { $gt: [1, 0] } },
      { type: ['string', 'integer', 'null'] },
      { type: 'string' },
    ];
    for (const schema of apart) assert.strictEqual(canonicalNullable(schema), null, JSON.stringify(schema));
  });

  it('a normalizer keyword at any depth below the branch keeps them apart: the normalizer enters the type array, never the union', () => {
    const apart = [
      { anyOf: [{ type: 'object', properties: { zip: { type: 'string', 'x-trim': true } } }, { type: 'null' }] },
      { anyOf: [{ type: 'object', properties: { city: { type: 'string', default: 'Utrecht' } } }, { type: 'null' }] },
      { anyOf: [{ type: 'array', items: { type: 'integer', 'x-coerce': true } }, { type: 'null' }] },
      { anyOf: [{ type: 'object', additionalProperties: { type: 'string', default: '' } }, { type: 'null' }] },
    ];
    for (const schema of apart) assert.strictEqual(canonicalNullable(schema), null, JSON.stringify(schema));
    // a nested member without one still has the one spelling, and a $ref is not followed
    assert.deepStrictEqual(canonicalNullable({ anyOf: [{ type: 'object', properties: { zip: { type: 'string' } } }, { type: 'null' }] }),
      { type: ['object', 'null'], properties: { zip: { type: 'string' } } });
    assert.deepStrictEqual(canonicalNullable({ anyOf: [{ type: 'object', properties: { next: { $ref: '#/$defs/N' } } }, { type: 'null' }] }),
      { type: ['object', 'null'], properties: { next: { $ref: '#/$defs/N' } } });
  });

  it('the check() example: the type array rejects null, the union accepts it — so they stay apart', () => {
    const check = { $gt: [{ '$string-length': '$' }, 2] };
    const array = { type: ['string', 'null'], $query: check };
    const union = { anyOf: [{ type: 'string', $query: check }, { type: 'null' }] };
    assert.strictEqual(validator().compile(array)(null), false);
    assert.strictEqual(validator().compile(union)(null), true);
    assert.strictEqual(canonicalNullable(array), null);
    assert.strictEqual(canonicalNullable(union), null);
  });
});
