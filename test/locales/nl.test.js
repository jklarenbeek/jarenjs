//@ts-check

/**
 * TODO_17 work item 4: the Dutch locale pack.
 *
 * Key parity with the built-in English catalogs is enforced HERE (by
 * test, not by imports - the pack itself has zero dependencies).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { nl } from '@jarenjs/locales';
import {
  JarenValidator,
  ValidatorOptions,
  messagesEn,
  compileMessageCatalog,
  localizeErrors,
} from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';

const compiled = compileMessageCatalog(nl);

/** Representative params per message key, for renders and the sweep. */
const SAMPLE_PARAMS = {
  type: { type: 'string' },
  required: { missingProperty: 'name' },
  minimum: { limit: 10, comparison: '>=' },
  maximum: { limit: 10, comparison: '<=' },
  exclusiveMinimum: { limit: 10, comparison: '>' },
  exclusiveMaximum: { limit: 10, comparison: '<' },
  multipleOf: { multipleOf: 5 },
  minLength: { limit: 2 },
  maxLength: { limit: 2 },
  pattern: { pattern: '^[a-z]+$' },
  additionalProperties: { additionalProperty: 'extra' },
  minProperties: { limit: 2 },
  maxProperties: { limit: 2 },
  minItems: { limit: 2 },
  maxItems: { limit: 2 },
  uniqueItems: {},
  contains: {},
  items: {},
  allOf: {},
  anyOf: {},
  oneOf: {},
  not: {},
  format: { format: 'email' },
  if: {},
  then: {},
  else: {},
  'false schema': {},
  $query: { code: 'JQ2003', docPath: '/a' },
  JQ2001: { code: 'JQ2001', docPath: '/a' },
  JQ2003: { code: 'JQ2003', docPath: '/a' },
  'form/required': {},
  'form/type': { type: 'integer' },
  'form/const': { constValue: 'EUR' },
  'form/enum': { enumValues: ['a', 'b', 'c'] },
  'form/minLength': { limit: 2, len: 1 },
  'form/maxLength': { limit: 2, len: 3 },
  'form/pattern': { pattern: '^[a-z]+$' },
  'form/format': { format: 'email' },
  'form/minimum': { limit: 1 },
  'form/maximum': { limit: 9 },
  'form/exclusiveMinimum': { limit: 1 },
  'form/exclusiveMaximum': { limit: 9 },
  'form/multipleOf': { multipleOf: 3 },
  'form/minItems': { limit: 2 },
  'form/maxItems': { limit: 2 },
  'form/uniqueItems': {},
  'form/minProperties': { limit: 2 },
  'form/maxProperties': { limit: 2 },
  'x-form/assert': { pointer: '/vatId' },
};

describe('@jarenjs/locales nl', () => {
  it('has key parity with the built-in English catalogs', () => {
    const nlKeys = new Set(Object.keys(nl));
    for (const key of Object.keys(messagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing validate key '${key}'`);
    }
    for (const key of Object.keys(formsMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing forms key '${key}'`);
    }
    assert.ok(nlKeys.has('x-form/assert'));
  });

  it('renders the plural pair correctly (the demonstration case)', () => {
    assert.strictEqual(compiled.minLength({ limit: 1 }), 'mag niet minder dan 1 teken bevatten');
    assert.strictEqual(compiled.minLength({ limit: 2 }), 'mag niet minder dan 2 tekens bevatten');
    assert.strictEqual(compiled['form/minLength']({ limit: 1, len: 0 }),
      'Moet ten minste 1 teken bevatten (nu 0)');
    assert.strictEqual(compiled['form/minLength']({ limit: 8, len: 3 }),
      'Moet ten minste 8 tekens bevatten (nu 3)');
  });

  it('renders sample document-voice messages', () => {
    assert.strictEqual(compiled.required({ missingProperty: 'name' }),
      "moet de verplichte eigenschap 'name' bevatten");
    assert.strictEqual(compiled.type({ type: 'integer' }), 'moet een geheel getal zijn');
    assert.strictEqual(compiled.minimum({ limit: 18, comparison: '>=' }), 'moet >= 18 zijn');
    assert.strictEqual(compiled['form/enum']({ enumValues: ['a', 'b'] }), 'Moet "a" of "b" zijn');
  });

  it('localizes a real compiled-validator result end to end', () => {
    const jaren = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
    const validate = jaren.compile({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 2 },
        age: { type: 'integer', minimum: 18 },
      },
    });

    const result = validate({ name: 'x', age: 7 });
    assert.strictEqual(result.valid, false);
    localizeErrors(result.errors, compiled);

    const minLength = result.errors.find(e => e.keyword === 'minLength');
    const minimum = result.errors.find(e => e.keyword === 'minimum');
    assert.strictEqual(minLength.message, 'mag niet minder dan 2 tekens bevatten');
    assert.strictEqual(minimum.message, 'moet >= 18 zijn');

    // and back to English
    localizeErrors(result.errors, compileMessageCatalog(messagesEn));
    assert.strictEqual(minLength.message, 'must NOT have fewer than 2 characters');
  });

  it('every entry renders without throwing (no-throw sweep)', () => {
    for (const key of Object.keys(nl)) {
      const params = SAMPLE_PARAMS[key];
      assert.ok(params !== undefined, `no sample params for '${key}' - extend the fixture`);
      const message = compiled[key](params);
      assert.strictEqual(typeof message, 'string');
      assert.ok(message.length > 0, `'${key}' rendered an empty string`);
    }
  });
});
