//@ts-check
/**
 * @file The keywords a compiled schema asserts are the ones its
 * meta-schema's `$vocabulary` and its declared draft define: a keyword of
 * a vocabulary the meta-schema leaves out is an annotation, and a keyword
 * a declared draft does not know is ignored, on every compile path (the
 * item fast paths, the item loop, the boolean `items` form, `contains`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

const NO_VALIDATION = 'https://x.test/no-validation.json';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const DRAFT_2019 = 'https://json-schema.org/draft/2019-09/schema';

/**
 * A validator holding a 2020-12 meta-schema whose `$vocabulary` names the
 * core and applicator vocabularies only.
 * @param {object} [options]
 */
function withoutValidation(options) {
  const validator = new JarenValidator(options);
  validator.addSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: NO_VALIDATION,
    $vocabulary: {
      'https://json-schema.org/draft/2020-12/vocab/core': true,
      'https://json-schema.org/draft/2020-12/vocab/applicator': true,
    },
  });
  return validator;
}

/**
 * The answers of one schema under the vocabulary-off meta-schema, in
 * boolean mode and in collect mode.
 * @param {object} schema
 * @param {unknown[]} instances
 */
function answersWithoutValidation(schema, instances) {
  const boolean = withoutValidation().compile({ $schema: NO_VALIDATION, ...schema });
  const collecting = withoutValidation({ collectErrors: true }).compile({ $schema: NO_VALIDATION, ...schema });
  return [instances.map((x) => boolean(x)), instances.map((x) => collecting(x).valid)];
}

describe('with the validation vocabulary off', () => {
  it('walks every item past maxItems, which is only an annotation', () => {
    const items = { maxItems: 1, items: { properties: { x: false } } };
    assert.deepEqual(answersWithoutValidation(items, [[{}, { x: 1 }], [{}, {}]]), [[false, true], [false, true]]);
    const contains = { maxItems: 1, contains: { items: false } };
    assert.deepEqual(answersWithoutValidation(contains, [[[1], []], [[1], [2]]]), [[true, false], [true, false]]);
  });

  it('asserts neither type nor required through the item fast paths', () => {
    assert.deepEqual(answersWithoutValidation({ items: { type: 'string' } }, [[5], ['a', 5]]), [[true, true], [true, true]]);
    assert.deepEqual(answersWithoutValidation({ items: { required: ['a'] } }, [[{}]]), [[true], [true]]);
    // the siblings that already followed the vocabulary
    assert.deepEqual(answersWithoutValidation({ properties: { a: { type: 'string' } } }, [{ a: 5 }]), [[true], [true]]);
    assert.deepEqual(answersWithoutValidation({ type: 'string' }, [5]), [[true], [true]]);
  });

  it('counts contains matches against no minContains or maxContains', () => {
    assert.deepEqual(answersWithoutValidation({ contains: true, minContains: 3 }, [[1], []]), [[true, false], [true, false]]);
    assert.deepEqual(answersWithoutValidation({ contains: true, maxContains: 0 }, [[1]]), [[true], [true]]);
    assert.deepEqual(answersWithoutValidation({ contains: { items: false }, minContains: 2, maxContains: 2 }, [[[], [1]], [[1]]]), [[true, false], [true, false]]);
    assert.deepEqual(answersWithoutValidation({ items: { contains: true, minContains: 3 } }, [[[1]]]), [[true], [true]]);
  });
});

describe('a keyword the declared draft does not define is ignored', () => {
  it('prefixItems before 2020-12 leaves items: false forbidding every item', () => {
    for (const draft of [DRAFT_2019, DRAFT_07]) {
      const validate = new JarenValidator().compile({ $schema: draft, prefixItems: [{}], items: false });
      assert.deepEqual([validate([]), validate([1]), validate([1, 2])], [true, false, false], draft);
      const withContains = new JarenValidator().compile({ $schema: draft, prefixItems: [{}], contains: true, items: false });
      assert.equal(withContains([1]), false, draft);
    }
    // A document that declares no draft reads prefixItems, as before.
    const undeclared = new JarenValidator().compile({ prefixItems: [{}], items: false });
    assert.deepEqual([undeclared([1]), undeclared([1, 2])], [true, false]);
    const current = new JarenValidator().compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', prefixItems: [{}], items: false });
    assert.deepEqual([current([1]), current([1, 2])], [true, false]);
  });

  it('minContains and maxContains before 2019-09 are unknown', () => {
    const at = (schema, data) => new JarenValidator().compile({ $schema: DRAFT_07, ...schema })(data);
    assert.equal(at({ contains: true, minContains: 3 }, [1]), true);
    assert.equal(at({ contains: true, maxContains: 0 }, [1]), true);
    assert.equal(at({ contains: { type: 'string' }, minContains: 0 }, [1]), false);
    assert.equal(at({ contains: { type: 'string' }, maxContains: 1 }, ['a', 'b']), true);
    // 2019-09 defines them
    assert.equal(new JarenValidator().compile({ $schema: DRAFT_2019, contains: true, minContains: 3 })([1]), false);
  });

  it('unevaluatedProperties and unevaluatedItems before 2019-09 are unknown', () => {
    const at = (schema, data) => new JarenValidator().compile({ $schema: DRAFT_07, ...schema })(data);
    assert.equal(at({ unevaluatedProperties: false }, { a: 1 }), true);
    assert.equal(at({ unevaluatedItems: false }, [1]), true);
    assert.equal(at({ properties: { p: { unevaluatedProperties: false } } }, { p: { a: 1 } }), true);
    assert.equal(new JarenValidator().compile({ $schema: DRAFT_2019, unevaluatedProperties: false })({ a: 1 }), false);
    assert.equal(new JarenValidator().compile({ unevaluatedProperties: false })({ a: 1 }), false);
  });
});
