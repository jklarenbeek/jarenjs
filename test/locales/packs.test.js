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

import {
  fr, es, pt, de, ja, ko, zhTW, ru, tr, ar,
  dateMessagesEn,
  compileDateLocale,
} from '@jarenjs/locales';
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


/**
 * The date msgids take either no parameter or an absolute `{ value }`,
 * so their sample params are DERIVED from the English key set rather
 * than typed out again: a hand-copied list of a mechanical key set is a
 * list that drifts away from it.
 */
const DATE_SAMPLE_PARAMS = Object.fromEntries(
  Object.keys(dateMessagesEn).map((key) => [key, { value: 2 }]));

/** Representative params per message key, for renders and the sweep. */
const SAMPLE_PARAMS = {
  ...DATE_SAMPLE_PARAMS,
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
  // the contract wire errors: params are protocol facts, never request
  // content (operation ids, declared limits, media types, header names)
  'contract/not-found': {},
  'contract/method-not-allowed': { allow: 'GET, PUT' },
  'contract/body-too-large': { op: 'product.save', limit: 1048576 },
  'contract/unsupported-media': { op: 'product.save', media: 'application/json' },
  'contract/malformed-json': { op: 'product.save' },
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

/**
 * Per-pack demonstration renders: the plural pair (or the counter form
 * for Japanese), a type name, the required property, the document-voice
 * minLength/minimum a real validator produces, the enum-list connector
 * word of the pack's Intl.ListFormat, and the calendar language - a
 * pattern through the pack's own month and weekday names, both relative
 * directions and a translated format name.
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
    dates: {
      long: 'dimanche 5 juillet 2026', short: 'dim. 5 juil.',
      past3days: 'il y a 3 jours', future21months: 'dans 21 mois',
      yesterday: 'hier', dateTime: 'date et heure',
    },
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
    dates: {
      long: 'domingo 5 julio 2026', short: 'dom 5 jul',
      past3days: 'hace 3 días', future21months: 'dentro de 21 meses',
      yesterday: 'ayer', dateTime: 'fecha y hora',
    },
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
    dates: {
      long: 'domingo 5 julho 2026', short: 'dom. 5 jul.',
      past3days: 'há 3 dias', future21months: 'dentro de 21 meses',
      yesterday: 'ontem', dateTime: 'data e hora',
    },
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
    dates: {
      long: 'Sonntag 5 Juli 2026', short: 'So 5 Jul',
      past3days: 'vor 3 Tagen', future21months: 'in 21 Monaten',
      yesterday: 'gestern', dateTime: 'Datum und Uhrzeit',
    },
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
    dates: {
      long: '日曜日 5 7月 2026', short: '日 5 7月',
      past3days: '3 日前', future21months: '21 か月後',
      yesterday: '昨日', dateTime: '日時',
    },
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
    dates: {
      long: '일요일 5 7월 2026', short: '일 5 7월',
      past3days: '3일 전', future21months: '21개월 후',
      yesterday: '어제', dateTime: '날짜 및 시간',
    },
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
    dates: {
      long: '星期日 5 7月 2026', short: '週日 5 7月',
      past3days: '3 天前', future21months: '21 個月後',
      yesterday: '昨天', dateTime: '日期與時間',
    },
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
    dates: {
      long: 'воскресенье 5 июля 2026', short: 'вс 5 июл.',
      past3days: '3 дня назад', future21months: 'через 21 месяц',
      yesterday: 'вчера', dateTime: 'дата и время',
    },
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
    dates: {
      long: 'Pazar 5 Temmuz 2026', short: 'Paz 5 Tem',
      past3days: '3 gün önce', future21months: '21 ay sonra',
      yesterday: 'dün', dateTime: 'tarih ve saat',
    },
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
    dates: {
      long: 'الأحد 5 يوليو 2026', short: 'الأحد 5 يوليو',
      past3days: 'قبل 3 أيام', future21months: 'خلال 21 شهرًا',
      yesterday: 'أمس', dateTime: 'تاريخ ووقت',
    },
  },
];

/** 2026-07-05 is a Sunday, so weekday index 0 renders too. */
const SUNDAY = parseRFC3339Parts('2026-07-05T14:30:05Z');

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
        for (const key of Object.keys(contractMessagesEn)) {
          assert.ok(keys.has(key), `${code} is missing contract key '${key}'`);
        }
        for (const key of Object.keys(dateMessagesEn)) {
          assert.ok(keys.has(key), `${code} is missing date key '${key}'`);
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

      it('renders its calendar language', () => {
        const dates = compileDateLocale(pack);
        assert.strictEqual(
          compileDateFormat('EEEE d MMMM yyyy', dates.names)(SUNDAY), expected.dates.long);
        assert.strictEqual(
          compileDateFormat('EEE d MMM', dates.names)(SUNDAY), expected.dates.short);
        assert.strictEqual(dates.relative(-3, 'day'), expected.dates.past3days);
        assert.strictEqual(dates.relative(21, 'month'), expected.dates.future21months);
        assert.strictEqual(dates.relative(-1, 'day', { numeric: 'auto' }), expected.dates.yesterday);
        assert.strictEqual(dates.formatName('date-time'), expected.dates.dateTime);
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
