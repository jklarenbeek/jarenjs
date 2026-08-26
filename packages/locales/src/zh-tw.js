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
  dateNameEntries,
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
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
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
  'form/addItem': '新增項目',
  'form/removeItem': '移除項目',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': '沒有任何操作符合請求的方法與路徑',
  'contract/method-not-allowed': '此路徑由其他方法提供:{allow}',
  'contract/body-too-large': '操作 {op} 的請求主體超過其 {limit} 位元組上限',
  'contract/unsupported-media': '操作 {op} 僅接受 {media} 主體',
  'contract/malformed-json': '操作 {op} 的請求主體不是有效的 JSON',
  'contract/invalid-input': '操作 {op} 的輸入無效',
  'contract/idempotency-key-required': '操作 {op} 需要 Idempotency-Key 標頭',
  'contract/handler-failed': '操作 {op} 失敗',
  'contract/idempotency-conflict': '操作 {op} 的 Idempotency-Key 與先前的請求衝突({kind})',
  'contract/invalid-output': '操作 {op} 產生了違反其契約的回應',
  'contract/malformed-path': '請求路徑含有格式錯誤的百分比逸出序列',
  'contract/malformed-query': '查詢字串無法解碼',
  'contract/not-implemented': '操作 {op} 未在此伺服器上實作',
  'contract/precondition-failed': '操作 {op} 的 If-Match 前置條件失敗',
  'contract/invalid-header': '操作 {op} 的 {header} 標頭無效',
  'contract/handler-error': '操作 {op} 以 {code} 失敗',
  'contract/client-invalid-input': '操作 {op} 的輸入無效;未傳送任何內容',
  'contract/network': '{op} 的請求未完成({name})',
  'contract/cancelled': '操作 {op} 的請求已取消',
  'contract/invalid-response': '操作 {op} 的回應違反其契約',
  'contract/key-storage-failed': '操作 {op} 的冪等鍵無法儲存;未傳送任何內容',
  'contract/undeclared-response': '操作 {op} 回覆了未宣告的回應(狀態 {status})',
  'contract/not-a-contract': '伺服器未在其 well-known 路徑描述契約 {id}',
  'contract/incompatible': '伺服器使用契約 {id} 的版本 {server},此用戶端使用 {client},且雙方都未宣告對方相容',
  'contract/host-failed': '操作 {op} 在產生結果之前於主機中失敗',
  'contract/local-handler-failed': '操作 {op} 在提供服務的主機中失敗',
  'contract/unknown-operation': '請求未指名此通道上提供的任何操作',
  'contract/port-timeout': '操作 {op} 在 {ms} 毫秒內未在通道上獲得回應',
  'contract/malformed-frame': '操作 {op} 的回應框架格式錯誤',
  'contract/channel-closed': '操作 {op} 的通道已關閉',
  'contract/not-a-stream': '伺服器以非串流回應回覆操作 {op} 的訂閱',
  'contract/invalid-snapshot': '操作 {op} 產生了違反其契約的快照',
  'contract/seq-regression': '操作 {op} 的串流違反了其 seq 順序',
  'contract/stream-error': '操作 {op} 的串流以伺服器錯誤結束({code})',
  'contract/heartbeat-missed': '操作 {op} 的串流沉默了 {ms} 毫秒',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // No plural, and the wide and abbreviated month names are the same
  // string - as CLDR has them.
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
      '星期日', '星期一', '星期二', '星期三',
      '星期四', '星期五', '星期六',
    ],
    weekdaysShort: [
      '週日', '週一', '週二', '週三', '週四', '週五', '週六',
    ],
    meridiem: ['上午', '下午'],
  }),
  'date/relative/second/past': (p) => `${num(p.value)} 秒前`,
  'date/relative/second/future': (p) => `${num(p.value)} 秒後`,
  'date/relative/minute/past': (p) => `${num(p.value)} 分鐘前`,
  'date/relative/minute/future': (p) => `${num(p.value)} 分鐘後`,
  'date/relative/hour/past': (p) => `${num(p.value)} 小時前`,
  'date/relative/hour/future': (p) => `${num(p.value)} 小時後`,
  'date/relative/day/past': (p) => `${num(p.value)} 天前`,
  'date/relative/day/future': (p) => `${num(p.value)} 天後`,
  'date/relative/week/past': (p) => `${num(p.value)} 週前`,
  'date/relative/week/future': (p) => `${num(p.value)} 週後`,
  'date/relative/month/past': (p) => `${num(p.value)} 個月前`,
  'date/relative/month/future': (p) => `${num(p.value)} 個月後`,
  'date/relative/year/past': (p) => `${num(p.value)} 年前`,
  'date/relative/year/future': (p) => `${num(p.value)} 年後`,
  'date/relative/now': '現在',
  'date/relative/yesterday': '昨天',
  'date/relative/today': '今天',
  'date/relative/tomorrow': '明天',
  'format/name/date': '日期',
  'format/name/time': '時間',
  'format/name/date-time': '日期與時間',
  'format/name/iso-date': 'ISO 日期',
  'format/name/iso-time': 'ISO 時間',
  'format/name/iso-date-time': 'ISO 日期與時間',
  //#endregion
};
