//@ts-check

/**
 * Every locale pack over every recording output format: the document a
 * validation returned renders again in the pack (`localizeErrors` over the
 * document), its every text the one the collected errors of the same
 * validation render in that pack, and the branch units the pack's
 * `subschema` entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ar, de, es, fr, ja, ko, nl, pt, ru, tr, zhTW } from '@jarenjs/locales';
import { JarenValidator, compileMessageCatalog, localizeErrors, messagesEn } from '@jarenjs/validate';
import { basicOutput, detailedOutput, verboseOutput, listOutput, hierarchicalOutput } from '@jarenjs/validate/output';
import { stringFormats } from '@jarenjs/formats';

const PACKS = { ar, de, es, fr, ja, ko, nl, pt, ru, tr, 'zh-TW': zhTW };
const FORMATS = { basic: basicOutput, detailed: detailedOutput, verbose: verboseOutput, list: listOutput, hierarchical: hierarchicalOutput };
const S = 'https://json-schema.org/draft/2020-12/schema';

/** One member per keyword family, each failing one keyword once. */
const SCHEMA = {
  $schema: S, type: 'object',
  properties: {
    type: { type: 'string' },
    minimum: { minimum: 5 }, maximum: { maximum: 1 }, exclusiveMinimum: { exclusiveMinimum: 5 }, exclusiveMaximum: { exclusiveMaximum: 1 }, multipleOf: { multipleOf: 2 },
    minLength: { minLength: 3 }, maxLength: { maxLength: 1 }, pattern: { pattern: '^a' }, format: { format: 'email' }, contentEncoding: { contentEncoding: 'base64' },
    minItems: { minItems: 2 }, maxItems: { maxItems: 0 }, uniqueItems: { uniqueItems: true }, contains: { contains: { const: 9 } },
    maxContains: { contains: { const: 1 }, maxContains: 1 }, items: { prefixItems: [{}], items: false }, unevaluatedItems: { unevaluatedItems: false },
    minProperties: { minProperties: 2 }, maxProperties: { maxProperties: 0 }, required: { required: ['x'] }, additionalProperties: { additionalProperties: false },
    propertyNames: { propertyNames: { maxLength: 1 } }, dependentRequired: { dependentRequired: { a: ['b'] } }, dependentSchemas: { dependentSchemas: { a: { required: ['c'] } } },
    unevaluatedProperties: { unevaluatedProperties: false },
    const: { const: 1 }, enum: { enum: [1, 2] },
    anyOf: { anyOf: [{ type: 'null' }, { type: 'boolean' }] }, oneOf: { oneOf: [{}, {}] }, not: { not: {} }, allOf: { allOf: [{ type: 'null' }] },
    ifThen: { if: {}, then: false }, false: false,
  },
};
const DATA = {
  type: 1, minimum: 1, maximum: 5, exclusiveMinimum: 5, exclusiveMaximum: 1, multipleOf: 3,
  minLength: 'ab', maxLength: 'ab', pattern: 'b', format: 'nope', contentEncoding: '!!!',
  minItems: [1], maxItems: [1], uniqueItems: [1, 1], contains: [1], maxContains: [1, 1], items: [1, 2], unevaluatedItems: [1],
  minProperties: { a: 1 }, maxProperties: { a: 1 }, required: {}, additionalProperties: { a: 1 }, propertyNames: { ab: 1 },
  dependentRequired: { a: 1 }, dependentSchemas: { a: 1 }, unevaluatedProperties: { a: 1 }, const: 2, enum: 3,
  anyOf: 1, oneOf: 1, not: 1, allOf: 1, ifThen: 1, false: 1,
};
const OPTIONS = { formatAssertion: true, formats: stringFormats, contentValidation: true };

/**
 * Every text of an output: a 2020-12 unit's `error`, each entry of a
 * `list`/`hierarchical` unit's `errors`.
 * @param {any} unit
 * @returns {string[]}
 */
function textsOf(unit) {
  /** @type {string[]} */
  const texts = [];
  const visit = (/** @type {any} */ node) => {
    if (typeof node.error === 'string') texts.push(node.error);
    if (node.errors !== undefined && !Array.isArray(node.errors)) texts.push(...Object.values(/** @type {Record<string, string>} */ (node.errors)));
    for (const key of ['errors', 'annotations', 'details']) if (Array.isArray(node[key])) node[key].forEach(visit);
  };
  visit(unit);
  return texts;
}

const collected = () => /** @type {any} */ (new JarenValidator({ collectErrors: true, ...OPTIONS }).compile(SCHEMA)(DATA)).errors;
const output = (/** @type {any} */ format) => new JarenValidator(/** @type {any} */ ({ outputFormat: format, ...OPTIONS })).compile(SCHEMA)(DATA);
const english = new Set([...collected().map((/** @type {any} */ e) => e.message), compileMessageCatalog(messagesEn).subschema({})]);

describe('every locale pack over every output format', () => {
  it('fails every keyword family the schema names', () => {
    const keywords = new Set(collected().map((/** @type {any} */ e) => e.keyword));
    for (const keyword of ['type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format',
      'contentEncoding', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'maxContains', 'items', 'unevaluatedItems', 'minProperties', 'maxProperties',
      'required', 'additionalProperties', 'dependentRequired', 'unevaluatedProperties', 'const', 'enum', 'anyOf', 'oneOf', 'not', 'false schema'])
      assert.ok(keywords.has(keyword), `no ${keyword} error`);
    assert.ok(collected().some((/** @type {any} */ e) => e.params.propertyName === 'ab'), 'no propertyNames error');
  });

  for (const [code, pack] of Object.entries(PACKS)) {
    it(`${code}: every text of every format renders in the pack as the collected errors do, branch units by its subschema entry`, () => {
      const catalog = compileMessageCatalog(pack);
      // what each English message of the collected errors is in the pack
      const errors = collected();
      const before = errors.map((/** @type {any} */ e) => e.message);
      const after = localizeErrors(errors, catalog).map((/** @type {any} */ e) => e.message);
      /** @type {Map<string, string>} */
      const inPack = new Map(before.map((text, i) => [text, after[i]]));
      inPack.set(compileMessageCatalog(messagesEn).subschema({}), catalog.subschema({}));
      let compared = 0;
      for (const [name, format] of Object.entries(FORMATS)) {
        const out = output(format);
        const englishTexts = textsOf(out);
        const texts = textsOf(localizeErrors(out, catalog));
        assert.equal(texts.length, englishTexts.length, name);
        assert.ok(texts.length > 0, name);
        texts.forEach((text, i) => {
          // a probe's error (a contains item) is no collected error: it is at least not English
          const expected = inPack.get(englishTexts[i]);
          if (expected !== undefined) {
            assert.equal(text, expected, `${code} ${name}: '${englishTexts[i]}'`);
            compared++;
          }
          assert.ok(!english.has(text) && !englishTexts.includes(text), `${code} ${name}: '${text}' stayed English`);
        });
        if (name === 'basic') assert.ok(texts.includes(catalog.subschema({})), `${code}: no branch unit reads subschema`);
      }
      assert.ok(compared > 100, `${code}: ${compared} texts compared`);
    });
  }
});
