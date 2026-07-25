//@ts-check

/**
 * Japanese (ja) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - Japanese has no grammatical plural, so there is no plural helper
 *   here; counts read through counters ("2 文字", "3 個"),
 * - `Intl.NumberFormat` renders numeric limits the Japanese way,
 * - `Intl.ListFormat` renders enum alternatives ("a、b、または c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const numberFormat = new Intl.NumberFormat('ja-JP');
const listFormat = new Intl.ListFormat('ja', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Japanese number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Japanese names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: '文字列 (string)',
  number: '数値',
  integer: '整数',
  boolean: '真偽値',
  array: '配列 (array)',
  object: 'オブジェクト',
  null: 'null',
};

/** Type keyword values under their Japanese display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Japanese catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and
 * the `JQ2xxx` codes reachable through `$query`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ja = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `次のいずれかの型でなければなりません: ${p.types.join(', ')}`
    : `${typeName(p.type)}でなければなりません`,
  required: (p) => p.missingProperty
    ? `必須プロパティ '${p.missingProperty}' が必要です`
    : '必須プロパティが必要です',
  minimum: (p) => `${p.comparison} ${num(p.limit)} でなければなりません`,
  maximum: (p) => `${p.comparison} ${num(p.limit)} でなければなりません`,
  exclusiveMinimum: (p) => `${p.comparison} ${num(p.limit)} でなければなりません`,
  exclusiveMaximum: (p) => `${p.comparison} ${num(p.limit)} でなければなりません`,
  multipleOf: (p) => `${num(p.multipleOf)} の倍数でなければなりません`,
  minLength: (p) => `${num(p.limit)} 文字以上でなければなりません`,
  maxLength: (p) => `${num(p.limit)} 文字以下でなければなりません`,
  pattern: 'パターン "{pattern}" に一致しなければなりません',
  additionalProperties: (p) => p.additionalProperty
    ? `追加のプロパティ '${p.additionalProperty}' は使用できません`
    : '追加のプロパティは使用できません',
  minProperties: (p) => `プロパティは ${num(p.limit)} 個以上でなければなりません`,
  maxProperties: (p) => `プロパティは ${num(p.limit)} 個以下でなければなりません`,
  minItems: (p) => `項目は ${num(p.limit)} 個以上でなければなりません`,
  maxItems: (p) => `項目は ${num(p.limit)} 個以下でなければなりません`,
  uniqueItems: '重複する項目は使用できません',
  contains: '有効な項目を少なくとも 1 つ含まなければなりません',
  items: '配列の項目が無効です',
  allOf: 'すべてのサブスキーマに一致しなければなりません',
  anyOf: 'anyOf のいずれかのサブスキーマに一致しなければなりません',
  oneOf: 'oneOf のちょうど 1 つのサブスキーマに一致しなければなりません',
  not: 'サブスキーマに一致してはいけません',
  format: '形式 "{format}" に一致しなければなりません',
  if: '"if" スキーマに一致しなければなりません',
  then: '"then" スキーマに一致しなければなりません',
  else: '"else" スキーマに一致しなければなりません',
  'false schema': 'ブールスキーマ false は常に無効です',
  $query: (p) => p.code
    ? `'$query' アサーションが '${p.docPath}' で ${p.code} を発生させました`
    : "'$query' アサーションを満たさなければなりません",
  JQ2001: (p) => `'$query' アサーションを評価できませんでした（'${p.docPath}' で ${p.code}）`,
  JQ2003: (p) => `'$query' アサーションが複数の結果を返しました（'${p.docPath}' で ${p.code}）`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'この項目は必須です',
  'form/type': (p) => `${typeName(p.type)}でなければなりません`,
  'form/const': (p) => `${formatMessageValue(p.constValue)} でなければなりません`,
  'form/enum': (p) => `${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} のいずれかでなければなりません`,
  'form/minLength': (p) => `${num(p.limit)} 文字以上で入力してください（現在 ${num(p.len)} 文字）`,
  'form/maxLength': (p) => `${num(p.limit)} 文字以下で入力してください（現在 ${num(p.len)} 文字）`,
  'form/pattern': 'パターン {pattern} に一致しなければなりません',
  'form/format': (p) => `有効な ${p.format} 形式で入力してください`,
  'form/minimum': (p) => `${num(p.limit)} 以上でなければなりません`,
  'form/maximum': (p) => `${num(p.limit)} 以下でなければなりません`,
  'form/exclusiveMinimum': (p) => `${num(p.limit)} より大きくなければなりません`,
  'form/exclusiveMaximum': (p) => `${num(p.limit)} より小さくなければなりません`,
  'form/multipleOf': (p) => `${num(p.multipleOf)} の倍数でなければなりません`,
  'form/minItems': (p) => `項目は ${num(p.limit)} 個以上必要です`,
  'form/maxItems': (p) => `項目は ${num(p.limit)} 個以下にしてください`,
  'form/uniqueItems': '項目は一意でなければなりません',
  'form/minProperties': (p) => `プロパティは ${num(p.limit)} 個以上必要です`,
  'form/maxProperties': (p) => `プロパティは ${num(p.limit)} 個以下にしてください`,
  'x-form/assert': '無効な値です',
  //#endregion
};
