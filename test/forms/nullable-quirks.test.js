//@ts-check
/**
 * @file Layer 1's nullable reading, each defect reproduced before it was
 * fixed:
 *
 * 1. The `oneOf` const/title idiom with a `null` ("none") option split as
 *    a nullable spelling: the field became a fixed `const` of its first
 *    option, `createInitialData` wrote that option into an optional member,
 *    and the view showed it for a `null`.
 * 2. `nullable` read only `type: [T, 'null']`, so layer 1 accepted a `null`
 *    the validator refuses (an `enum` or `const` beside the type that does
 *    not list it) and refused one it accepts (OpenAPI's `nullable: true`).
 * 3. A json-control field (a schema layer 1 cannot judge) holding the
 *    `null` the json control writes for half-typed input showed no error,
 *    although the field is required and the validator refuses it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { buildFormModel, validateField, createInitialData, buildFormViewModel } from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';

/** @param {Record<string, any>} property @param {string[]} [required] */
const modelOf = (property, required = []) => buildFormModel({ type: 'object', properties: { x: property }, required });

describe('forms — the nullable reading of layer 1', () => {
  it('1. the oneOf const/title idiom with a null option stays an enum select; its null is an option', () => {
    const priority = { oneOf: [{ const: 'high', title: 'High' }, { const: null, title: 'None' }] };
    const model = modelOf(priority);
    const field = model.children[0];
    assert.deepStrictEqual([field.kind, field.control], ['enum', 'select']);
    assert.deepStrictEqual(field.enumValues, ['high', null]);
    assert.deepStrictEqual(field.enumLabels, ['High', 'None']);
    assert.strictEqual(field.nullable, true);
    assert.deepStrictEqual(createInitialData(model), {}, 'an optional member stays absent');
    const node = buildFormViewModel(model, { x: null }).children[0];
    assert.strictEqual(node.control, 'select');
    assert.strictEqual(node.value, null);
    assert.deepStrictEqual(validateField(field, null), []);
  });

  it('2. an explicit null is judged as the validator judges it: enum, const, nullable: true', () => {
    const cases = /** @type {[Record<string, any>, string[]][]} */ ([
      [{ type: ['string', 'null'], enum: ['a', 'b'] }, ['enum']],
      [{ type: ['string', 'null'], const: 'a' }, ['const']],
      [{ type: ['string', 'null'], enum: ['a', null] }, []],
      [{ type: 'integer', nullable: true }, []],
      [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, []],
    ]);
    for (const [property, keywords] of cases) {
      const field = modelOf(property, ['x']).children[0];
      assert.deepStrictEqual(validateField(field, null).map((e) => e.keyword), keywords, JSON.stringify(property));
      const accepts = new JarenValidator().compile({ type: 'object', properties: { x: property }, required: ['x'] })({ x: null });
      assert.strictEqual(accepts, keywords.length === 0, `the validator agrees for ${JSON.stringify(property)}`);
    }
  });

  it('3. a required json-control field holding null says required, as for an absent value', () => {
    const field = modelOf({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, ['x']).children[0];
    assert.strictEqual(field.control, 'json');
    assert.deepStrictEqual(validateField(field, null).map((e) => e.keyword), ['required']);
    const optional = modelOf({ anyOf: [{ type: 'string' }, { type: 'integer' }] }).children[0];
    assert.deepStrictEqual(validateField(optional, null), [], 'an optional one treats it as absent');
  });
});
