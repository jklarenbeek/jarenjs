//@ts-check

/**
 * The non-Dutch locale packs (fr, es, pt, de, ja, ko, zh-TW, ru, tr, ar).
 *
 * Key parity with the built-in English catalogs is enforced HERE (by
 * test, not by imports - the packs themselves have zero dependencies),
 * together with a no-throw render sweep over every key and an
 * end-to-end `localizeErrors` pass per pack over one real compiled
 * validator result. The nl pack keeps its own suite (nl.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { fr, es, pt, de, ja, ko, zhTW, ru, tr, ar } from '@jarenjs/locales';
import {
  JarenValidator,
  ValidatorOptions,
  messagesEn,
  compileMessageCatalog,
  localizeErrors,
} from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';

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
  // form chrome takes no params: the accessible names of the array buttons
  'form/addItem': {},
  'form/removeItem': {},
};

/**
 * Per-pack demonstration renders: the plural pair (or the counter form
 * for Japanese), a type name, the required property, the document-voice
 * minLength/minimum a real validator produces, and the enum-list
 * connector word of the pack's Intl.ListFormat.
 */
const PACKS = [
  {
    code: 'fr', pack: fr,
    singular: 'Doit contenir au moins 1 caractère (actuellement 0)',
    plural: 'Doit contenir au moins 8 caractères (actuellement 3)',
    type: 'doit être un nombre entier',
    required: "doit contenir la propriété obligatoire 'name'",
    minLength: 'ne doit pas contenir moins de 2 caractères',
    minimum: 'doit être >= 18',
    enumConnector: / ou /,
  },
  {
    code: 'es', pack: es,
    singular: 'Debe tener al menos 1 carácter (actualmente 0)',
    plural: 'Debe tener al menos 8 caracteres (actualmente 3)',
    type: 'debe ser un número entero',
    required: "debe tener la propiedad obligatoria 'name'",
    minLength: 'no debe tener menos de 2 caracteres',
    minimum: 'debe ser >= 18',
    enumConnector: / o /,
  },
  {
    code: 'pt', pack: pt,
    singular: 'Deve ter pelo menos 1 caractere (atualmente 0)',
    plural: 'Deve ter pelo menos 8 caracteres (atualmente 3)',
    type: 'deve ser um número inteiro',
    required: "deve ter a propriedade obrigatória 'name'",
    minLength: 'não deve ter menos de 2 caracteres',
    minimum: 'deve ser >= 18',
    enumConnector: / ou /,
  },
  {
    code: 'de', pack: de,
    singular: 'Muss mindestens 1 Zeichen enthalten (derzeit 0)',
    plural: 'Muss mindestens 8 Zeichen enthalten (derzeit 3)',
    type: 'muss eine ganze Zahl sein',
    required: "muss die Pflichteigenschaft 'name' enthalten",
    minLength: 'darf nicht weniger als 2 Zeichen enthalten',
    minimum: 'muss >= 18 sein',
    enumConnector: / oder /,
  },
  {
    code: 'ja', pack: ja,
    singular: '1 文字以上で入力してください（現在 0 文字）',
    plural: '8 文字以上で入力してください（現在 3 文字）',
    type: '整数でなければなりません',
    required: "必須プロパティ 'name' が必要です",
    minLength: '2 文字以上でなければなりません',
    minimum: '>= 18 でなければなりません',
    enumConnector: /または/,
  },
  {
    code: 'ko', pack: ko,
    singular: '1자 이상 입력해야 합니다 (현재 0자)',
    plural: '8자 이상 입력해야 합니다 (현재 3자)',
    type: '정수 유형이어야 합니다',
    required: "필수 속성 'name'이(가) 필요합니다",
    minLength: '2자 이상이어야 합니다',
    minimum: '>= 18 이어야 합니다',
    enumConnector: /또는/,
  },
  {
    code: 'zh-TW', pack: zhTW,
    singular: '至少需要 1 個字元（目前 0 個）',
    plural: '至少需要 8 個字元（目前 3 個）',
    type: '必須是整數',
    required: "必須包含必要屬性 'name'",
    minLength: '不得少於 2 個字元',
    minimum: '必須 >= 18',
    enumConnector: /或/,
  },
  {
    // the 'one' category recurs at 21, 31, ... - the genitive pair must
    // follow it, not `count === 1` (the 21-символа case)
    code: 'ru', pack: ru,
    singular: 'Должно содержать не менее 1 символа (сейчас 0)',
    plural: 'Должно содержать не менее 8 символов (сейчас 3)',
    type: 'должно быть целым числом',
    required: "должно содержать обязательное свойство 'name'",
    minLength: 'не должно содержать менее 2 символов',
    minimum: 'должно быть >= 18',
    enumConnector: / или /,
  },
  {
    code: 'tr', pack: tr,
    singular: 'En az 1 karakter içermelidir (şu an 0)',
    plural: 'En az 8 karakter içermelidir (şu an 3)',
    type: 'tam sayı olmalıdır',
    required: "zorunlu 'name' özelliğini içermelidir",
    minLength: 'en az 2 karakter içermelidir',
    minimum: '>= 18 olmalıdır',
    enumConnector: / veya /,
  },
  {
    code: 'ar', pack: ar,
    singular: 'يجب ألا يقل عدد الأحرف عن 1 (حاليًا 0)',
    plural: 'يجب ألا يقل عدد الأحرف عن 8 (حاليًا 3)',
    type: 'يجب أن تكون القيمة من نوع عدد صحيح',
    required: "يجب أن تحتوي على الخاصية الإلزامية 'name'",
    minLength: 'يجب ألا يقل عدد الأحرف عن 2',
    // in words, not '>= 18': a neutral ASCII operator inside RTL text
    // renders reordered ("=<"), flipping the comparison visually
    minimum: 'يجب ألا تقل القيمة عن 18',
    enumConnector: / أو /,
  },
];

describe('@jarenjs/locales fr/es/pt/de/ja', () => {
  for (const { code, pack, ...expected } of PACKS) {
    const compiled = compileMessageCatalog(pack);

    describe(code, () => {
      it('has key parity with the built-in English catalogs', () => {
        const keys = new Set(Object.keys(pack));
        for (const key of Object.keys(messagesEn)) {
          assert.ok(keys.has(key), `${code} is missing validate key '${key}'`);
        }
        for (const key of Object.keys(formsMessagesEn)) {
          assert.ok(keys.has(key), `${code} is missing forms key '${key}'`);
        }
        assert.ok(keys.has('x-form/assert'));
      });

      it('renders the demonstration samples', () => {
        assert.strictEqual(compiled['form/minLength']({ limit: 1, len: 0 }), expected.singular);
        assert.strictEqual(compiled['form/minLength']({ limit: 8, len: 3 }), expected.plural);
        assert.strictEqual(compiled.type({ type: 'integer' }), expected.type);
        assert.strictEqual(compiled.required({ missingProperty: 'name' }), expected.required);
        assert.match(compiled['form/enum']({ enumValues: ['a', 'b', 'c'] }), expected.enumConnector,
          `${code} enum list renders through the pack's disjunction`);
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
        assert.strictEqual(
          result.errors.find(e => e.keyword === 'minLength').message, expected.minLength);
        assert.strictEqual(
          result.errors.find(e => e.keyword === 'minimum').message, expected.minimum);
      });

      it('every entry renders without throwing (no-throw sweep)', () => {
        for (const key of Object.keys(pack)) {
          const params = SAMPLE_PARAMS[key];
          assert.ok(params !== undefined, `no sample params for '${key}' - extend the fixture`);
          const message = compiled[key](params);
          assert.strictEqual(typeof message, 'string');
          assert.ok(message.length > 0, `'${key}' rendered an empty string`);
        }
      });
    });
  }

  it('arabic renders known comparisons as phrases and isolates unknown symbols', () => {
    const compiled = compileMessageCatalog(ar);
    assert.strictEqual(compiled.maximum({ comparison: '<=', limit: 9 }),
      'يجب ألا تزيد القيمة عن 9');
    assert.strictEqual(compiled.exclusiveMinimum({ comparison: '>', limit: 0 }),
      'يجب أن تكون القيمة أكبر من 0');
    // an operator outside the four known ones keeps its symbol, wrapped
    // in a first-strong-isolate so it cannot visually flip
    assert.match(compiled.minimum({ comparison: '≥', limit: 5 }),
      /⁦≥ 5⁩/);
  });

  it("russian genitive follows CLDR's recurring 'one' category (21, 22, 25)", () => {
    const compiled = compileMessageCatalog(ru);
    assert.strictEqual(compiled.minLength({ limit: 21 }),
      'не должно содержать менее 21 символа');
    assert.strictEqual(compiled.minLength({ limit: 22 }),
      'не должно содержать менее 22 символов');
    assert.strictEqual(compiled.minLength({ limit: 25 }),
      'не должно содержать менее 25 символов');
  });
});
