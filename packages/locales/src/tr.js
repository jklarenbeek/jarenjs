//@ts-check

/**
 * Turkish (tr) message catalog for @jarenjs/validate and @jarenjs/forms.
 *
 * A catalog is a plain flat object `{ [key]: closure | template string }`;
 * compile it with `compileMessageCatalog` from either consumer package
 * and hand it to `localizeErrors` (validate) or the `catalog` parameters
 * of `validateField` / `evaluateFormRules` (forms). A pack imports only
 * the shared rendering helpers; key parity with the built-in English
 * catalogs is enforced by tests in the repo, not by imports.
 *
 * Globalization mechanics (the pack-authoring pattern - see
 * packages/validate/docs/ERROR-MESSAGES.md):
 * - Turkish nouns stay singular after a numeral ("2 karakter"), so
 *   there is no plural helper. Case suffixes obey vowel harmony, so
 *   every message attaches suffixes to FIXED nouns ("'name'
 *   özelliğini", "5 sayısının katı"), never to interpolated text,
 * - `Intl.NumberFormat` renders numeric limits the Turkish way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b veya c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('tr-TR');
const listFormat = new Intl.ListFormat('tr', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Turkish number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Turkish names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'metin (string)',
  number: 'sayı',
  integer: 'tam sayı',
  boolean: 'boole değeri',
  array: 'liste (array)',
  object: 'nesne',
  null: 'null',
};

/** Type keyword values under their Turkish display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Turkish catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const tr = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `şu türlerden biri olmalıdır: ${p.types.join(', ')}`
    : `${typeName(p.type)} olmalıdır`,
  required: (p) => p.missingProperty
    ? `zorunlu '${p.missingProperty}' özelliğini içermelidir`
    : 'zorunlu özellikleri içermelidir',
  minimum: (p) => `${p.comparison} ${num(p.limit)} olmalıdır`,
  maximum: (p) => `${p.comparison} ${num(p.limit)} olmalıdır`,
  exclusiveMinimum: (p) => `${p.comparison} ${num(p.limit)} olmalıdır`,
  exclusiveMaximum: (p) => `${p.comparison} ${num(p.limit)} olmalıdır`,
  multipleOf: (p) => `${num(p.multipleOf)} sayısının katı olmalıdır`,
  minLength: (p) => `en az ${num(p.limit)} karakter içermelidir`,
  maxLength: (p) => `en fazla ${num(p.limit)} karakter içermelidir`,
  pattern: '"{pattern}" desenine uymalıdır',
  additionalProperties: (p) => p.additionalProperty
    ? `ek '${p.additionalProperty}' özelliğini içermemelidir`
    : 'ek özellikler içermemelidir',
  minProperties: (p) => `en az ${num(p.limit)} özellik içermelidir`,
  maxProperties: (p) => `en fazla ${num(p.limit)} özellik içermelidir`,
  minItems: (p) => `en az ${num(p.limit)} öğe içermelidir`,
  maxItems: (p) => `en fazla ${num(p.limit)} öğe içermelidir`,
  uniqueItems: 'yinelenen öğeler içermemelidir',
  contains: 'en az bir geçerli öğe içermelidir',
  items: 'listedeki öğeler geçersiz',
  allOf: 'tüm alt şemalarla eşleşmelidir',
  anyOf: "anyOf içindeki bir alt şemayla eşleşmelidir",
  oneOf: "oneOf içindeki tam olarak bir alt şemayla eşleşmelidir",
  not: 'alt şemayla eşleşmemelidir',
  format: '"{format}" biçimine uymalıdır',
  if: '"if" şemasıyla eşleşmelidir',
  then: '"then" şemasıyla eşleşmelidir',
  else: '"else" şemasıyla eşleşmelidir',
  'false schema': 'false boole şeması her zaman geçersizdir',
  $query: (p) => p.code
    ? `'$query' doğrulaması '${p.docPath}' konumunda ${p.code} hatası verdi`
    : "'$query' doğrulamasını karşılamalıdır",
  JQ2001: (p) => `'$query' doğrulaması değerlendirilemedi ('${p.docPath}' konumunda ${p.code})`,
  JQ2003: (p) => `'$query' doğrulaması birden çok sonuç döndürdü ('${p.docPath}' konumunda ${p.code})`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Bu alan zorunludur',
  'form/type': (p) => `${typeName(p.type)} olmalıdır`,
  'form/const': (p) => `${formatMessageValue(p.constValue)} olmalıdır`,
  'form/enum': (p) => `${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} değerlerinden biri olmalıdır`,
  'form/minLength': (p) => `En az ${num(p.limit)} karakter içermelidir (şu an ${num(p.len)})`,
  'form/maxLength': (p) => `En fazla ${num(p.limit)} karakter içermelidir (şu an ${num(p.len)})`,
  'form/pattern': '{pattern} desenine uymalıdır',
  'form/format': (p) => `Geçerli bir ${p.format} değeri olmalıdır`,
  'form/minimum': (p) => `En az ${num(p.limit)} olmalıdır`,
  'form/maximum': (p) => `En fazla ${num(p.limit)} olmalıdır`,
  'form/exclusiveMinimum': (p) => `${num(p.limit)} değerinden büyük olmalıdır`,
  'form/exclusiveMaximum': (p) => `${num(p.limit)} değerinden küçük olmalıdır`,
  'form/multipleOf': (p) => `${num(p.multipleOf)} sayısının katı olmalıdır`,
  'form/minItems': (p) => `En az ${num(p.limit)} öğe içermelidir`,
  'form/maxItems': (p) => `En fazla ${num(p.limit)} öğe içermelidir`,
  'form/uniqueItems': 'Öğeler benzersiz olmalıdır',
  'form/minProperties': (p) => `En az ${num(p.limit)} özellik içermelidir`,
  'form/maxProperties': (p) => `En fazla ${num(p.limit)} özellik içermelidir`,
  'x-form/assert': 'Geçersiz değer',
  //#endregion
};
