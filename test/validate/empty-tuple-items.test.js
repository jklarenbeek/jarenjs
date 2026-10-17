//@ts-check
/**
 * @file An empty `items` array is a tuple of no positions: every element of
 * the instance lies beyond it, so `additionalItems` beside it applies to every
 * element, as it applies past the last position of a longer tuple. Alone, the
 * empty tuple constrains no element.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

const DRAFTS = /** @type {[string, string | undefined][]} */ ([
  ['no $schema', undefined],
  ['draft-06', 'http://json-schema.org/draft-06/schema#'],
  ['draft-07', 'http://json-schema.org/draft-07/schema#'],
  ['draft 2019-09', 'https://json-schema.org/draft/2019-09/schema'],
  ['draft 2020-12', 'https://json-schema.org/draft/2020-12/schema'],
]);
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';

const ARRAYS = [[], [1], ['a', 2], [[]]];

/**
 * The boolean answers of a schema for each instance.
 * @param {object} schema @param {unknown[]} instances
 */
function answers(schema, instances) {
  const validate = new JarenValidator().compile(schema);
  return instances.map((x) => validate(x));
}

/**
 * The collected errors of one instance, as keyword, instance path and schema
 * path below the root.
 * @param {object} schema @param {unknown} instance
 */
function collected(schema, instance) {
  const result = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema)(instance));
  return result.errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath, e.schemaPath.slice(e.schemaPath.indexOf('#'))]);
}

describe('additionalItems beside an empty items array applies to every element', () => {
  for (const [label, draft] of DRAFTS) {
    const schema = (/** @type {object} */ keywords) => (draft === undefined ? keywords : { $schema: draft, ...keywords });

    it(`refuses every non-empty array beside additionalItems: false (${label})`, () => {
      assert.deepEqual(answers(schema({ items: [], additionalItems: false }), ARRAYS), [true, false, false, false]);
    });

    it(`applies an additionalItems schema to the first element on (${label})`, () => {
      assert.deepEqual(answers(schema({ items: [], additionalItems: { type: 'string' } }), [[], ['a'], ['a', 'b'], [1], ['a', 2]]),
        [true, true, true, false, false]);
    });

    it(`keeps the answers that were right: alone, and beside additionalItems: true (${label})`, () => {
      assert.deepEqual(answers(schema({ items: [] }), ARRAYS), [true, true, true, true]);
      assert.deepEqual(answers(schema({ items: [], additionalItems: true }), ARRAYS), [true, true, true, true]);
    });
  }

  it('reports what a one-position tuple reports past its last position', () => {
    assert.deepEqual(collected({ items: [], additionalItems: false }, [1]), collected({ items: [{}], additionalItems: false }, [0, 1]));
    assert.deepEqual(collected({ items: [], additionalItems: false }, [1]), [['items', '', '#']]);
    assert.deepEqual(collected({ items: [], additionalItems: { type: 'string' } }, [1]),
      [['type', '/0', '#/additionalItems'], ['items', '', '#']]);
  });

  it('reads the elements additionalItems covers as evaluated, and no other', () => {
    assert.deepEqual(answers({ $schema: D19, items: [], additionalItems: false, unevaluatedItems: false }, ARRAYS), [true, false, false, false]);
    assert.deepEqual(answers({ $schema: D19, items: [], additionalItems: true, unevaluatedItems: false }, ARRAYS), [true, true, true, true]);
    assert.deepEqual(answers({ $schema: D19, items: [], unevaluatedItems: false }, ARRAYS), [true, false, false, false]);
  });

  it('keeps an empty prefixItems beside items: false refusing every non-empty array', () => {
    assert.deepEqual(answers({ $schema: D20, prefixItems: [], items: false }, ARRAYS), [true, false, false, false]);
  });
});
