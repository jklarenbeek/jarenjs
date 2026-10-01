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
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn`.
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
  'form/jsonPlaceholder': '請輸入 JSON 值',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': '沒有任何操作符合請求的方法與路徑',
  'contract/method-not-allowed': '此路徑由其他方法提供:{allow}',
  'contract/body-too-large': '操作 {op} 的請求主體超過其 {limit} 位元組上限',
  'contract/unsupported-media': '操作 {op} 僅接受 {media} 主體',
  'contract/malformed-json': '操作 {op} 的請求主體不是有效的 JSON',
  'contract/malformed-body': '操作 {op} 的請求主體不是有效的 UTF-8 文字',
  'contract/invalid-input': '操作 {op} 的輸入無效',
  'contract/idempotency-key-required': '操作 {op} 需要 Idempotency-Key 標頭',
  'contract/handler-failed': '操作 {op} 失敗',
  'contract/idempotency-conflict': '操作 {op} 的 Idempotency-Key 與先前的請求衝突({kind})',
  'contract/invalid-output': '操作 {op} 產生了違反其契約的回應',
  'contract/malformed-path': '請求路徑含有格式錯誤的百分比逸出序列，或為 . 或 .. 的路徑區段',
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
  'contract/slow-consumer': '操作 {op} 的串流已結束：消費端落後於其有界佇列',
  'contract/reconnect-exhausted': '操作 {op} 的串流在 {attempts} 次嘗試後仍無法重新建立（最後：{lastCode}）',
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

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': '包含 {count} 個項目的序列',
  'query/item/empty': '空序列',
  'query/item/null': '空值（null）',
  'query/item/array': '陣列',
  'query/item/object': '物件',
  'query/item/string': '字串',
  'query/item/number': '數字',
  'query/item/boolean': '布林值',
  'query/item/other': '型別為 {type} 的值',
  'query/mixed-keys': '物件不能混用 $-prefixed 鍵與一般鍵',
  'query/unknown-operator': "未知的運算子 '{key}'",
  'query/unknown-operator-suggest': "未知的運算子 '{key}'（您是指 '{suggestion}' 嗎？）",
  'query/unknown-operator-use': "未知的運算子 '{key}'（請使用 {use}）",
  'query/unknown-operator-none': "未知的運算子 '{key}'（jaren-query 中沒有任何運算子提供此功能）",
  'query/use/head-of-reverse': '$reverse 結果的 $head',
  'query/use/jsonpath-filter': 'JSONPath 篩選條件如 $[?(@.x > 1)]，或 $for 中的 $where',
  'query/use/for-return': '$for 片語搭配 $return',
  'query/use/for-phrase': '$for 片語',
  'query/use/sort-objects': '$sort 排序純量；物件則用 $for 走訪排序後的鍵',
  'query/use/sort-scalars': '$sort，僅適用於純量',
  'query/use/entries-get': '$entries，再接 $get',
  'query/use/geo-parse-text': '$geo-parse 讀取，$geo-text 寫出',
  'query/use/bbox-intersects': '$bbox-intersects，僅適用於邊界框；刻意不提供真正的幾何套疊',
  'query/use/renderer': '繪製地圖的轉譯器——本語言完全無法產生投影座標，因此量測絕不會在投影座標上進行；此處的量測一律是橢球面上的測地量測',
  'query/use/renderer-project': "繪製地圖的轉譯器，與 '$project' 相同",
  'query/use/similarity': '$similarity，值越高表示越接近；沒有距離度量',
  'query/use/knn-desc': "$orderby 搭配 $similarity 鍵與 $dir 'desc'，再接 $subsequence 取前 k 個",
  'query/use/knn': '$orderby 搭配 $similarity 鍵，再接 $subsequence',
  'query/use/top-k': '$orderby，再接 $subsequence',
  'query/use/resample-fill': "$resample 並指定 'fill'",
  'query/use/resample-locf': "$resample 並將 fill 設為 'locf'",
  'query/use/resample-linear': "$resample 並將 fill 設為 'linear'",
  'query/use/rolling-mean': "$rolling 並將 aggregate 設為 'mean'",
  'query/phrase-keys': '無效的片語鍵組合（{keys}）',
  'query/phrase-alone': "'{key}' 無法單獨構成片語",
  'query/operands-array': "'{op}' 需要運算式陣列",
  'query/operands-exactly': "'{op}' 恰好需要 {min} 個運算元，但得到 {count} 個",
  'query/operands-at-least': "'{op}' 至少需要 {min} 個運算元，但得到 {count} 個",
  'query/operands-range': "'{op}' 需要 {min} 到 {max} 個運算元，但得到 {count} 個",
  'query/variable-name-expected': '預期為變數名稱字串',
  'query/variable-name-invalid': "'{name}' 不是有效的變數名稱",
  'query/variable-duplicate': "同一片語中重複繫結了變數 '{name}'",
  'query/bindings-object': "'{clause}' 需要變數繫結物件",
  'query/bindings-empty': "'{clause}' 至少需要一個繫結",
  'query/extended-let': "'$let' 中無法使用延伸繫結形式",
  'query/extended-quantifier': '量詞中無法使用延伸繫結形式',
  'query/window-kind': "'$window' 必須是 'tumbling' 或 'sliding'",
  'query/window-size-required': "'$window' 繫結需要 '$size'",
  'query/window-size': "'$size' 必須是正整數",
  'query/window-step': "'$step' 必須是正整數",
  'query/window-required': "'$size'/'$step' 需要 '$window'",
  'query/for-key': "'{key}' 不是延伸 '$for' 繫結的有效鍵",
  'query/for-in-required': "延伸 '$for' 繫結需要 '$in'",
  'query/for-at': "'$at' 需要變數名稱字串",
  'query/for-allowing-empty': "'$allowing-empty' 需要布林值",
  'query/orderby-spec': "'$orderby' 需要鍵規格，或由鍵規格組成的非空陣列",
  'query/orderby-spec-key': "'{key}' 不是 $orderby 鍵規格的有效鍵",
  'query/orderby-spec-key-required': "明確的 $orderby 鍵規格需要 '$key'",
  'query/orderby-dir': "'$dir' 必須是 'asc' 或 'desc'",
  'query/orderby-empty': "'$empty' 必須是 'least' 或 'greatest'",
  'query/collation-name': "'$collation' 必須是已註冊的定序名稱",
  'query/collation-unregistered': "'$collation' 指定的定序 '{name}' 未註冊",
  'query/fold-binding': "'$fold' 恰好需要一個累加器繫結",
  'query/as-object': "'$as' 需要一個物件，其成員將變數名稱對應至綱要",
  'query/as-empty': "'$as' 至少需要一個成員",
  'query/as-unbound': "'$as' 指定的 '{name}' 未由此片語的 '$for'/'$let' 繫結",
  'query/count-variable': "'$count' 需要變數名稱字串",
  'query/map-entry': '$map 條目必須是恰好包含兩個運算式的陣列',
  'query/call-arguments': "'$call' 需要 ['name', ...引數運算式]",
  'query/call-unregistered': "'$call' 指定的函式 '{name}' 未註冊",
  'query/apply-arguments': "'$apply' 需要 [選取器] 或 [選取器, 模式]",
  'query/apply-mode': "'$apply' 的模式必須是字串常值",
  'query/document-value': '查詢文件不能包含型別為 {type} 的值',
  'query/invalid-path': "'{path}' 不是有效的路徑或逸出",
  'query/invalid-path-detail': "'{path}' 不是有效的路徑：{detail}",
  'query/unbound-variable': "'${name}' 既未由外層片語繫結，也不是已宣告的外部參數（已宣告的外部參數：{declared}）",
  'query/unbound-variable-closed': "'${name}' 既未由外層片語繫結，也不是已宣告的外部參數（此查詢以封閉世界方式編譯，未宣告任何外部參數）",
  'query/version-unknown': '未知的查詢格式版本 {version}',
  'query/version-envelope': "版本封套必須恰好只有 '$query' 與 '$expr' 這兩個鍵",
  'query/schema-no-compiler': '綱要運算子需要型別測試編譯器（options.compileTypeTest）',
  'query/schema-invalid': '無效的綱要常值：{detail}',
  'query/schema-no-predicate': '型別測試編譯器未傳回述詞函式',
  'query/depth-limit': '查詢的運算式巢狀深度達 {depth} 層，超過 limits.depth（{limit}）',
  'query/spec-member-required': "'{name}' 需要規格成員 '{member}'",
  'query/spec-invalid': "'{name}' 規格：{detail}",
  'query/date-pattern': "'$date-format' 模式：{detail}",
  'query/time-bucket-invalid': "'$time-bucket' 無效：{detail}",
  'query/lexical-arguments': '$lexical 需要 [提供者, 文字運算式, 常值請求]',
  'query/lexical-unregistered': "詞彙搜尋提供者 '{name}' 未註冊",
  'query/lexical-rejected': '詞彙搜尋提供者拒絕了請求',
  'query/lexical-no-request': '詞彙搜尋提供者未編譯請求',
  'query/series-spec-object': "'{operator}' 需要常值規格物件，但得到{got}",
  'query/series-spec-member': "'{operator}' 沒有規格成員 '{name}'；可用的成員為 {allowed}",
  'query/series-spec-member-suggest': "'{operator}' 沒有規格成員 '{name}'（您是指 '{suggestion}' 嗎？）；可用的成員為 {allowed}",
  'query/series-member-enum': "'{member}' 必須是 {allowed} 其中之一，但得到{got}",
  'query/series-member-number': "'{member}' 必須是有限數字，但得到{got}",
  'query/series-member-instant': "'{member}' 必須是紀元毫秒數或 RFC 3339 字串，但得到{got}",
  'query/series-member-duration': "'{member}' 必須是持續時間字串或毫秒數，但得到{got}",
  'query/series-member-path': "'{member}' 必須是指向資料列內部的單一路徑，但得到{got}",
  'query/series-member-path-detail': "'{member}' 的路徑無效：{detail}",
  'query/series-member-not-path': "'{member}' 不是路徑",
  'query/series-member-whole-row': "'{member}' 選取的是整個資料列，而非其中的成員",
  'query/series-member-singular': "'{member}' 必須是單一路徑（每個區段只能有一個名稱或索引，不可使用萬用字元、子代或篩選條件）",
  'query/series-zone': "'zone' 必須是 IANA 時區名稱，但得到{got}",
  'query/series-zone-provider': "時區 '{zone}' 需要時區提供者：此套件未內建 tzdb，因此具名時區須透過 options.zoneProvider（toParts / toEpoch）編譯。'UTC' 與數值 'offset' 則不需要",
  'query/series-calendar': '日曆情境：{detail}',
  'query/expected-string': '預期為字串，但得到{got}',
  'query/expected-number': '預期為數字，但得到{got}',
  'query/cast-string': '無法將{got}轉換為字串',
  'query/cast-number': '無法將{got}轉換為數字',
  'query/not-json-number': "'{value}' 不是 JSON 數字",
  'query/arithmetic-operand': '算術運算需要數字運算元，但得到{got}',
  'query/aggregate-not-number': '彙總項目必須是數字，但得到{got}',
  'query/aggregate-null': '彙總需要數字或字串，但得到空值（null）',
  'query/minmax-mixed': "'$min'/'$max' 的項目必須全為數字或全為字串，但得到{got}",
  'query/sort-mixed': "'$sort' 的項目必須全為數字或全為字串，但得到{got}",
  'query/regex-invalid': "'{pattern}' 不是有效的 I-Regexp 模式",
  'query/replace-empty-match': "'$replace' 的模式 '{pattern}' 符合長度為零的字串",
  'query/range-bounds': "'$range' 的邊界必須是安全整數，但得到{got}",
  'query/range-guard': "'$range' 的 {count} 個項目超過 {limit} 個項目的資源防護上限",
  'query/index-of-item': "'$index-of' 需要單一搜尋項目，但得到{got}",
  'query/expected-datetime': '預期為 RFC 3339 日期、時間或日期與時間字串，但得到{got}',
  'query/no-date-component': "'{value}' 不含日期部分",
  'query/no-time-component': "'{value}' 不含時間部分",
  'query/calendar-unit': "預期為日曆單位（'year'、'month'、'day' 等），但得到{got}",
  'query/expected-duration': '預期為 ISO 8601 持續時間，但得到{got}',
  'query/expected-units': '預期為單位數量，但得到{got}',
  'query/expected-date-pattern': '預期為日期模式，但得到{got}',
  'query/datetime-epoch': "'$datetime' 需要紀元毫秒數，但得到{got}",
  'query/datetime-range': '{value} 超出 RFC 3339 可表示的範圍',
  'query/span-no-date': '無法從沒有日期的值測量時間間隔',
  'query/expected-bucket-width': '預期為分桶寬度，但得到{got}',
  'query/expected-geo': '預期為 GeoJSON 值或 [經度, 緯度] 位置，但得到{got}',
  'query/expected-wkt': '預期為 Well-Known Text 字串，但得到{got}',
  'query/expected-geohash': '預期為 geohash 網格字串，但得到{got}',
  'query/geohash-precision': 'geohash 精確度必須是 1 到 12 的整數，但得到{got}',
  'query/simplify-tolerance': '簡化容許誤差必須是非負的度數，但得到{got}',
  'query/expected-vector': '預期為向量（數字陣列），但得到{got}',
  'query/expected-vector-item': '預期為向量（數字陣列），但索引 {index} 處得到{got}',
  'query/expected-series': '預期為時間序列（含時間點與讀數的記錄），但得到{got}',
  'query/expected-interval': '預期為區間記錄 {{ start, end }，但得到{got}',
  'query/member-cardinality': "成員 '{name}' 求值得到 {count} 個項目；物件成員必須恰好為一個項目",
  'query/groupby-key': '$groupby 的鍵必須是空序列或單一項目，但得到{got}',
  'query/lexical-text': '詞彙搜尋文字必須是單一字串',
  'query/idiv-zero': "'$idiv' 除以零",
  'query/mod-zero': "'$mod' 除以零",
  'query/ebv-sequence': '包含兩個以上項目的序列，其有效布林值未定義',
  'query/map-key': '$map 的鍵必須求值為單一字串，但得到{got}',
  'query/orderby-key': '$orderby 的鍵必須是空序列、數字或字串，但得到{got}',
  'query/orderby-number-string': '$orderby 中無法將數字與字串比較排序',
  'query/orderby-string-number': '$orderby 中無法將字串與數字比較排序',
  'query/external-unbound': "外部參數 '{name}' 未繫結",
  'query/assert-failed': "'$assert' 失敗：{got}不符合綱要",
  'query/assert-failed-item': "'$assert' 失敗：項目 {index} 為{got}，不符合綱要",
  'query/as-failed': "變數 '{name}' 未通過其 '$as' 綱要：{got}不符合該綱要",
  'query/as-failed-item': "變數 '{name}' 未通過其 '$as' 綱要：項目 {index} 為{got}，不符合該綱要",
  'query/fold-limit': '摺疊累加器超過 {limit} 個項目（limits.sequenceItems）',
  'query/phrase-limit': '片語具體化了超過 {limit} 個項目（limits.sequenceItems）',
  'query/steps-limit': '查詢超過 limits.steps（{limit} 次運算式求值）',
  'query/result-limit': '查詢結果有 {count} 個項目，超過 limits.resultItems（{limit}）',
  'query/function-threw': "已註冊的函式 '{name}' 擲回例外：{detail}",
  'query/operator-threw': "已註冊的運算子 '{name}' 失敗：{detail}",
  'query/input-undefined': '輸入文件為 undefined，而 undefined 不是 JSON 值',
  'query/lexical-threw': '詞彙搜尋提供者擲回例外',
  'query/lexical-result': '詞彙搜尋提供者傳回了無效或不完整的結果',
  //#endregion
};
