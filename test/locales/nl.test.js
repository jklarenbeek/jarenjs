//@ts-check

/**
 * The Dutch locale pack.
 *
 * Key parity with the built-in English catalogs is enforced HERE (by
 * test, not by imports - the pack itself has zero dependencies).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { nl, dateMessagesEn, compileDateLocale, numberMessagesEn } from '@jarenjs/locales';
import { compileDateFormat, parseRFC3339Parts } from '@jarenjs/core/dates';
import {
  JarenValidator,
  ValidatorOptions,
  messagesEn,
  compileMessageCatalog,
  localizeErrors,
} from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';
import { contractMessagesEn } from '@jarenjs/contract';
import { compileJsonQuery, queryMessagesEn, renderQueryMessage } from '@jarenjs/json';
import { compileFormula, formulaMessagesEn } from '@jarenjs/json/formula';
import { compileMessageTemplate } from '@jarenjs/core/message';

const compiled = compileMessageCatalog(nl);


/**
 * The date msgids take either no parameter or an absolute `{ value }`,
 * so their sample params are DERIVED from the English key set rather
 * than typed out again: a hand-copied list of a mechanical key set is a
 * list that drifts away from it.
 */
const DATE_SAMPLE_PARAMS = Object.fromEntries(
  Object.keys(dateMessagesEn).map((key) => [key, { value: 2 }]));

/** The number entries are characters and words: no parameter. */
const NUMBER_SAMPLE_PARAMS = Object.fromEntries(Object.keys(numberMessagesEn).map((key) => [key, {}]));

/**
 * The query msgids are templates over the values their English names, so
 * their sample params are DERIVED from the English placeholders: one
 * string per parameter.
 */
const QUERY_SAMPLE_PARAMS = Object.fromEntries(Object.entries(queryMessagesEn).map(([key, template]) =>
  [key, Object.fromEntries(compileMessageTemplate(template).parameters.map((name) => [name, `<${name}>`]))]));

/** The formula msgids are derived the same way. */
const FORMULA_SAMPLE_PARAMS = Object.fromEntries(Object.entries(formulaMessagesEn).map(([key, template]) =>
  [key, Object.fromEntries(compileMessageTemplate(template).parameters.map((name) => [name, `<${name}>`]))]));

/**
 * A template that carries no words of its own (only placeholders, operator
 * names and punctuation, or the literal null) is the same in every language.
 * @param {any} template
 */
const wordless = (template) => template === 'null'
  || !/\p{L}/u.test(String(template).replace(/\{[a-z]+\}/gi, '').replace(/\$[a-z-]+/gi, ''));

/** The placeholder names of a template, sorted. @param {any} template */
const placeholders = (template) => [...compileMessageTemplate(String(template)).parameters].sort();

/** Representative params per message key, for renders and the sweep. */
const SAMPLE_PARAMS = {
  ...DATE_SAMPLE_PARAMS,
  ...NUMBER_SAMPLE_PARAMS,
  ...QUERY_SAMPLE_PARAMS,
  ...FORMULA_SAMPLE_PARAMS,
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
  // form chrome takes no params: the accessible names of the array buttons
  'form/addItem': {},
  'form/removeItem': {},
  'form/jsonPlaceholder': {},
  // the contract wire errors: params are protocol facts, never request
  // content (operation ids, declared limits, media types, header names)
  'contract/not-found': {},
  'contract/method-not-allowed': { allow: 'GET, PUT' },
  'contract/body-too-large': { op: 'product.save', limit: 1048576 },
  'contract/unsupported-media': { op: 'product.save', media: 'application/json' },
  'contract/malformed-json': { op: 'product.save' },
  'contract/malformed-body': { op: 'label.render' },
  'contract/invalid-input': { op: 'product.save' },
  'contract/idempotency-key-required': { op: 'product.save' },
  'contract/handler-failed': { op: 'product.save' },
  'contract/idempotency-conflict': { op: 'product.save', kind: 'in-flight' },
  'contract/invalid-output': { op: 'catalog.load' },
  'contract/malformed-path': {},
  'contract/malformed-query': {},
  'contract/not-implemented': { op: 'catalog.load' },
  'contract/precondition-failed': { op: 'product.save' },
  'contract/invalid-header': { op: 'catalog.load', header: 'x-shop-tenant' },
  'contract/handler-error': { op: 'product.save', code: 'conflict' },
  'contract/client-invalid-input': { op: 'product.save' },
  'contract/network': { op: 'catalog.load', name: 'TypeError' },
  'contract/cancelled': { op: 'catalog.load' },
  'contract/invalid-response': { op: 'catalog.load' },
  'contract/key-storage-failed': { op: 'product.save' },
  'contract/undeclared-response': { op: 'catalog.load', status: 418 },
  'contract/not-a-contract': { id: 'shop' },
  'contract/incompatible': { id: 'shop', server: '5', client: '3' },
  'contract/host-failed': { op: 'catalog.load' },
  'contract/local-handler-failed': { op: 'catalog.load' },
  'contract/unknown-operation': {},
  'contract/port-timeout': { op: 'data.rows', ms: 15000 },
  'contract/malformed-frame': { op: 'data.rows' },
  'contract/channel-closed': { op: 'data.rows' },
  'contract/not-a-stream': { op: 'catalog.live' },
  'contract/invalid-snapshot': { op: 'catalog.live' },
  'contract/seq-regression': { op: 'catalog.live' },
  'contract/stream-error': { op: 'catalog.live', code: 'server-shutdown' },
  'contract/heartbeat-missed': { op: 'catalog.live', ms: 30000 },
  'contract/slow-consumer': { op: 'catalog.live' },
  'contract/reconnect-exhausted': { op: 'catalog.live', attempts: 3, lastCode: 'JC2051' },
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
    for (const key of Object.keys(contractMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing contract key '${key}'`);
    }
    for (const key of Object.keys(dateMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing date key '${key}'`);
    }
    for (const key of Object.keys(numberMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing number key '${key}'`);
    }
    for (const key of Object.keys(queryMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing query key '${key}'`);
      assert.deepStrictEqual(placeholders(nl[key]), placeholders(queryMessagesEn[key]), `nl ${key} placeholders`);
    }
    for (const key of Object.keys(formulaMessagesEn)) {
      assert.ok(nlKeys.has(key), `nl is missing formula key '${key}'`);
      assert.deepStrictEqual(placeholders(nl[key]), placeholders(formulaMessagesEn[key]), `nl ${key} placeholders`);
    }
    assert.ok(nlKeys.has('x-form/assert'));
  });

  it('renders a query error in Dutch, the item it met included', () => {
    let error;
    try { compileJsonQuery({ $substring: ['$.s', 1] })({ s: 5 }); }
    catch (thrown) { error = thrown; }
    assert.strictEqual(error.reason, 'expected a string, got a number');
    const dutch = renderQueryMessage(error, nl);
    assert.strictEqual(dutch, 'een tekst (string) verwacht, een getal gekregen');
    assert.strictEqual(dutch, nl['query/expected-string'].replace('{got}', nl['query/item/number']));
    assert.notStrictEqual(dutch, error.reason);
  });

  it('translates every query and formula message that carries words, copying none from English', () => {
    const copied = [...Object.entries(queryMessagesEn), ...Object.entries(formulaMessagesEn)]
      .filter(([key, english]) => !wordless(english) && nl[key] === english).map(([key]) => key);
    assert.deepStrictEqual(copied, []);
  });

  it('renders a formula error in Dutch: its own message, and a query error raised inside the formula', () => {
    let own;
    try { compileFormula({ $formula: '1', id: 'prijs', revision: '1', expression: 1, helpers: [{ name: 'round2', version: '1' }] }); }
    catch (thrown) { own = thrown; }
    assert.strictEqual(own.reason, 'prijs: missing/incompatible pure helper round2@1');
    assert.strictEqual(renderQueryMessage(own, nl), 'prijs: de pure hulpfunctie round2@1 ontbreekt of is niet compatibel');
    let inner;
    try { compileFormula({ $formula: '1', id: 'f', revision: '1', expression: { $nope: 1 } }); }
    catch (thrown) { inner = thrown; }
    assert.strictEqual(renderQueryMessage(inner, nl), "f: onbekende operator '$nope' (bedoelde je '$some'?)");
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

  it('renders its calendar language, plural quirks and all', () => {
    // 2026-07-05 is a Sunday, so weekday index 0 renders too
    const sunday = parseRFC3339Parts('2026-07-05T14:30:05Z');
    const dates = compileDateLocale(nl);
    assert.strictEqual(
      compileDateFormat('EEEE d MMMM yyyy', dates.names)(sunday), 'zondag 5 juli 2026');
    assert.strictEqual(
      compileDateFormat('EEE d MMM yy', dates.names)(sunday), 'zo 5 jul 26');
    assert.strictEqual(compileDateFormat('h:mm a', dates.names)(sunday), '2:30 p.m.');

    // 'uur' and 'jaar' take no plural after a numeral; every other unit does
    assert.strictEqual(dates.relative(-1, 'second'), '1 seconde geleden');
    assert.strictEqual(dates.relative(-2, 'second'), '2 seconden geleden');
    assert.strictEqual(dates.relative(-1, 'hour'), '1 uur geleden');
    assert.strictEqual(dates.relative(-5, 'hour'), '5 uur geleden');
    assert.strictEqual(dates.relative(21, 'year'), 'over 21 jaar');
    assert.strictEqual(dates.relative(0, 'week'), 'over 0 weken');
    assert.strictEqual(dates.relative(-1, 'day', { numeric: 'auto' }), 'gisteren');
    assert.strictEqual(dates.relative(1, 'day', { numeric: 'auto' }), 'morgen');
  });

  it('reads the date formats as words, which is the whole point', () => {
    const dates = compileDateLocale(nl);
    assert.strictEqual(dates.formatName('date'), 'datum');
    assert.strictEqual(dates.formatName('time'), 'tijd');
    assert.strictEqual(dates.formatName('date-time'), 'datum en tijd');
    assert.strictEqual(dates.formatName('iso-date-time'), 'ISO-datum en -tijd');
    // the raw wire name is what a Dutch reader used to be shown
    assert.strictEqual(compiled['form/format']({ format: 'date-time' }),
      'Moet een geldige date-time zijn');
    assert.strictEqual(compiled['form/format']({ format: 'datum en tijd' }),
      'Moet een geldige datum en tijd zijn');
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
