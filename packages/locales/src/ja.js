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
  dateNameEntries,
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
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
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
  'form/addItem': '項目を追加',
  'form/removeItem': '項目を削除',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'リクエストのメソッドとパスに一致する操作がありません',
  'contract/method-not-allowed': 'このパスは別のメソッドで提供されています: {allow}',
  'contract/body-too-large': '操作 {op} のリクエストボディが {limit} バイトの上限を超えています',
  'contract/unsupported-media': '操作 {op} は {media} のボディのみ受け付けます',
  'contract/malformed-json': '操作 {op} のリクエストボディは有効な JSON ではありません',
  'contract/invalid-input': '操作 {op} の入力が無効です',
  'contract/idempotency-key-required': '操作 {op} には Idempotency-Key ヘッダーが必要です',
  'contract/handler-failed': '操作 {op} が失敗しました',
  'contract/idempotency-conflict': '操作 {op} の Idempotency-Key が以前のリクエストと競合しています ({kind})',
  'contract/invalid-output': '操作 {op} が契約に違反するレスポンスを生成しました',
  'contract/malformed-path': 'リクエストパスに不正なパーセントエスケープが含まれています',
  'contract/malformed-query': 'クエリ文字列をデコードできません',
  'contract/not-implemented': '操作 {op} はこのサーバーでは実装されていません',
  'contract/precondition-failed': '操作 {op} の If-Match 前提条件が満たされませんでした',
  'contract/invalid-header': '操作 {op} の {header} ヘッダーが無効です',
  'contract/handler-error': '操作 {op} が {code} で失敗しました',
  'contract/client-invalid-input': '操作 {op} の入力が無効です。何も送信されませんでした',
  'contract/network': '{op} のリクエストは完了しませんでした ({name})',
  'contract/cancelled': '操作 {op} のリクエストはキャンセルされました',
  'contract/invalid-response': '操作 {op} のレスポンスは契約に違反しています',
  'contract/key-storage-failed': '操作 {op} の冪等キーを保存できませんでした。何も送信されませんでした',
  'contract/undeclared-response': '操作 {op} が宣言されていないレスポンスを返しました (ステータス {status})',
  'contract/not-a-contract': 'サーバーは well-known パスで契約 {id} を記述していません',
  'contract/incompatible': 'サーバーは契約 {id} のバージョン {server} を話し、このクライアントは {client} を話しますが、どちらの側も相手を互換と宣言していません',
  'contract/host-failed': '操作 {op} は結果が生成される前にホスト内で失敗しました',
  'contract/local-handler-failed': '操作 {op} は提供側ホスト内で失敗しました',
  'contract/unknown-operation': 'リクエストはこのチャネルで提供されている操作を指名していません',
  'contract/port-timeout': '操作 {op} は {ms} ミリ秒以内にチャネル上で応答を得られませんでした',
  'contract/malformed-frame': '操作 {op} のレスポンスフレームが不正です',
  'contract/channel-closed': '操作 {op} のチャネルは閉じられています',
  'contract/not-a-stream': 'サーバーは操作 {op} の購読にストリームでないレスポンスで応答しました',
  'contract/invalid-snapshot': '操作 {op} が契約に違反するスナップショットを生成しました',
  'contract/seq-regression': '操作 {op} のストリームが seq の順序に違反しました',
  'contract/stream-error': '操作 {op} のストリームはサーバーエラーで終了しました ({code})',
  'contract/heartbeat-missed': '操作 {op} のストリームが {ms} ミリ秒間沈黙しました',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // Japanese counts through counters and has no plural, so the wide and
  // abbreviated month names are the same string - as CLDR has them.
  ...dateNameEntries({
    months: [
      '1月', '2月', '3月', '4月', '5月', '6月',
      '7月', '8月', '9月', '10月', '11月', '12月',
    ],
    monthsShort: [
      '1月', '2月', '3月', '4月', '5月', '6月',
      '7月', '8月', '9月', '10月', '11月', '12月',
    ],
    weekdays: [
      '日曜日', '月曜日', '火曜日', '水曜日',
      '木曜日', '金曜日', '土曜日',
    ],
    weekdaysShort: [
      '日', '月', '火', '水', '木', '金', '土',
    ],
    meridiem: ['午前', '午後'],
  }),
  'date/relative/second/past': (p) => `${num(p.value)} 秒前`,
  'date/relative/second/future': (p) => `${num(p.value)} 秒後`,
  'date/relative/minute/past': (p) => `${num(p.value)} 分前`,
  'date/relative/minute/future': (p) => `${num(p.value)} 分後`,
  'date/relative/hour/past': (p) => `${num(p.value)} 時間前`,
  'date/relative/hour/future': (p) => `${num(p.value)} 時間後`,
  'date/relative/day/past': (p) => `${num(p.value)} 日前`,
  'date/relative/day/future': (p) => `${num(p.value)} 日後`,
  'date/relative/week/past': (p) => `${num(p.value)} 週間前`,
  'date/relative/week/future': (p) => `${num(p.value)} 週間後`,
  'date/relative/month/past': (p) => `${num(p.value)} か月前`,
  'date/relative/month/future': (p) => `${num(p.value)} か月後`,
  'date/relative/year/past': (p) => `${num(p.value)} 年前`,
  'date/relative/year/future': (p) => `${num(p.value)} 年後`,
  'date/relative/now': '今',
  'date/relative/yesterday': '昨日',
  'date/relative/today': '今日',
  'date/relative/tomorrow': '明日',
  'format/name/date': '日付',
  'format/name/time': '時刻',
  'format/name/date-time': '日時',
  'format/name/iso-date': 'ISO 日付',
  'format/name/iso-time': 'ISO 時刻',
  'format/name/iso-date-time': 'ISO 日時',
  //#endregion
};
