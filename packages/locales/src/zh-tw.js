//@ts-check

/**
 * Traditional Chinese, Taiwan (zh-TW) message catalog for
 * @jarenjs/validate and @jarenjs/forms.
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
 * - Chinese has no grammatical plural, so there is no plural helper
 *   here; counts read through measure words ("2 個字元", "3 個項目"),
 *   and the vocabulary is Taiwan's (字串/陣列/物件/欄位, not the
 *   mainland variants),
 * - `Intl.NumberFormat` renders numeric limits the zh-TW way,
 * - `Intl.ListFormat` renders enum alternatives ("a、b或c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('zh-TW');
const listFormat = new Intl.ListFormat('zh-TW', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the zh-TW number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Taiwan names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: '字串 (string)',
  number: '數字',
  integer: '整數',
  boolean: '布林值',
  array: '陣列 (array)',
  object: '物件',
  null: 'null',
};

/** Type keyword values under their zh-TW display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The zh-TW catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const zhTW = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `必須是下列型別之一: ${p.types.join(', ')}`
    : `必須是${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `必須包含必要屬性 '${p.missingProperty}'`
    : '必須包含必要屬性',
  minimum: (p) => `必須 ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `必須 ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `必須 ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `必須 ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `必須是 ${num(p.multipleOf)} 的倍數`,
  minLength: (p) => `不得少於 ${num(p.limit)} 個字元`,
  maxLength: (p) => `不得多於 ${num(p.limit)} 個字元`,
  pattern: '必須符合模式 "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `不得包含額外屬性 '${p.additionalProperty}'`
    : '不得包含額外屬性',
  minProperties: (p) => `屬性不得少於 ${num(p.limit)} 個`,
  maxProperties: (p) => `屬性不得多於 ${num(p.limit)} 個`,
  minItems: (p) => `項目不得少於 ${num(p.limit)} 個`,
  maxItems: (p) => `項目不得多於 ${num(p.limit)} 個`,
  uniqueItems: '不得包含重複的項目',
  contains: '必須至少包含一個有效項目',
  items: '陣列的項目無效',
  allOf: '必須符合所有子綱要',
  anyOf: '必須符合 anyOf 中的一個子綱要',
  oneOf: '必須恰好符合 oneOf 中的一個子綱要',
  not: '不得符合子綱要',
  format: '必須符合格式 "{format}"',
  if: '必須符合 "if" 綱要',
  then: '必須符合 "then" 綱要',
  else: '必須符合 "else" 綱要',
  'false schema': '布林綱要 false 永遠無效',
  $query: (p) => p.code
    ? `'$query' 斷言在 '${p.docPath}' 產生了 ${p.code}`
    : "必須滿足 '$query' 斷言",
  JQ2001: (p) => `'$query' 斷言無法求值（${p.code}，位於 '${p.docPath}'）`,
  JQ2003: (p) => `'$query' 斷言傳回了多個結果（${p.code}，位於 '${p.docPath}'）`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': '此欄位為必填',
  'form/type': (p) => `必須是${typeName(p.type)}`,
  'form/const': (p) => `必須是 ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `必須是 ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} 其中之一`,
  'form/minLength': (p) => `至少需要 ${num(p.limit)} 個字元（目前 ${num(p.len)} 個）`,
  'form/maxLength': (p) => `最多 ${num(p.limit)} 個字元（目前 ${num(p.len)} 個）`,
  'form/pattern': '必須符合模式 {pattern}',
  'form/format': (p) => `必須是有效的 ${p.format} 格式`,
  'form/minimum': (p) => `必須至少為 ${num(p.limit)}`,
  'form/maximum': (p) => `不得超過 ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `必須大於 ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `必須小於 ${num(p.limit)}`,
  'form/multipleOf': (p) => `必須是 ${num(p.multipleOf)} 的倍數`,
  'form/minItems': (p) => `至少需要 ${num(p.limit)} 個項目`,
  'form/maxItems': (p) => `最多 ${num(p.limit)} 個項目`,
  'form/uniqueItems': '項目不得重複',
  'form/minProperties': (p) => `至少需要 ${num(p.limit)} 個屬性`,
  'form/maxProperties': (p) => `最多 ${num(p.limit)} 個屬性`,
  'x-form/assert': '無效的值',
  //#endregion
};
