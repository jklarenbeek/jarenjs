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
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn`.
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
  'form/jsonPlaceholder': 'JSON 値を入力してください',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'リクエストのメソッドとパスに一致する操作がありません',
  'contract/method-not-allowed': 'このパスは別のメソッドで提供されています: {allow}',
  'contract/body-too-large': '操作 {op} のリクエストボディが {limit} バイトの上限を超えています',
  'contract/unsupported-media': '操作 {op} は {media} のボディのみ受け付けます',
  'contract/malformed-json': '操作 {op} のリクエストボディは有効な JSON ではありません',
  'contract/malformed-body': '操作 {op} のリクエストボディは有効な UTF-8 テキストではありません',
  'contract/invalid-input': '操作 {op} の入力が無効です',
  'contract/idempotency-key-required': '操作 {op} には Idempotency-Key ヘッダーが必要です',
  'contract/handler-failed': '操作 {op} が失敗しました',
  'contract/idempotency-conflict': '操作 {op} の Idempotency-Key が以前のリクエストと競合しています ({kind})',
  'contract/invalid-output': '操作 {op} が契約に違反するレスポンスを生成しました',
  'contract/malformed-path': 'リクエストパスに不正なパーセントエスケープ、または . や .. のセグメントが含まれています',
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
  'contract/slow-consumer': '操作 {op} のストリームは終了しました: 消費側が有界キューに追いつけませんでした',
  'contract/reconnect-exhausted': '操作 {op} のストリームは {attempts} 回の試行後も再確立できませんでした（最後: {lastCode}）',
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

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': '{count} 個の項目からなるシーケンス',
  'query/item/empty': '空のシーケンス',
  'query/item/null': 'null 値',
  'query/item/array': '配列',
  'query/item/object': 'オブジェクト',
  'query/item/string': '文字列',
  'query/item/number': '数値',
  'query/item/boolean': '真偽値',
  'query/item/other': '{type} 型の値',
  'query/mixed-keys': 'オブジェクトでは $-prefixed のキーと通常のキーを混在させることはできません',
  'query/unknown-operator': "不明な演算子 '{key}'",
  'query/unknown-operator-suggest': "不明な演算子 '{key}'（'{suggestion}' のことですか？）",
  'query/unknown-operator-use': "不明な演算子 '{key}'（{use} を使用してください）",
  'query/unknown-operator-none': "不明な演算子 '{key}'（jaren-query にはこの処理を行う演算子はありません）",
  'query/use/head-of-reverse': '$reverse の結果に $head',
  'query/use/jsonpath-filter': '$[?(@.x > 1)] のような JSONPath フィルター、または $for 内の $where',
  'query/use/for-return': '$for フレーズと $return',
  'query/use/for-phrase': '$for フレーズ',
  'query/use/sort-objects': 'スカラーには $sort、オブジェクトには並べ替えたキーに対する $for',
  'query/use/sort-scalars': 'スカラーのみを並べ替える $sort',
  'query/use/entries-get': '$entries の後に $get',
  'query/use/geo-parse-text': '読み取りには $geo-parse、書き出しには $geo-text',
  'query/use/bbox-intersects': '実図形のオーバーレイは意図的に提供していないため、バウンディングボックスのみを扱う $bbox-intersects',
  'query/use/renderer': 'この言語は投影座標をまったく作れないため、計測が投影座標に対して行われることはなく、ここでの計測は楕円体上の測地線に基づきます。投影には地図を描画するレンダラー',
  'query/use/renderer-project': "'$project' と同様に、地図を描画するレンダラー",
  'query/use/similarity': '距離指標はないため、値が大きいほど近いことを表す $similarity',
  'query/use/knn-desc': "$dir 'desc' を指定した $similarity キーでの $orderby の後に、k 件を取り出す $subsequence",
  'query/use/knn': '$similarity キーでの $orderby の後に $subsequence',
  'query/use/top-k': '$orderby の後に $subsequence',
  'query/use/resample-fill': "'fill' を指定した $resample",
  'query/use/resample-locf': "fill に 'locf' を指定した $resample",
  'query/use/resample-linear': "fill に 'linear' を指定した $resample",
  'query/use/rolling-mean': "aggregate に 'mean' を指定した $rolling",
  'query/phrase-keys': '無効なフレーズキーの組み合わせ（{keys}）',
  'query/phrase-alone': "'{key}' は単独ではフレーズを構成できません",
  'query/operands-array': "'{op}' には式の配列が必要です",
  'query/operands-exactly': "'{op}' にはちょうど {min} 個のオペランドが必要ですが、{count} 個でした",
  'query/operands-at-least': "'{op}' には {min} 個以上のオペランドが必要ですが、{count} 個でした",
  'query/operands-range': "'{op}' には {min}～{max} 個のオペランドが必要ですが、{count} 個でした",
  'query/variable-name-expected': '変数名の文字列が必要です',
  'query/variable-name-invalid': "'{name}' は有効な変数名ではありません",
  'query/variable-duplicate': "1 つのフレーズ内で変数 '{name}' が重複して束縛されています",
  'query/bindings-object': "'{clause}' には変数束縛のオブジェクトが必要です",
  'query/bindings-empty': "'{clause}' には少なくとも 1 つの束縛が必要です",
  'query/extended-let': "拡張束縛形式は '$let' では使用できません",
  'query/extended-quantifier': '拡張束縛形式は量化子では使用できません',
  'query/window-kind': "'$window' は 'tumbling' または 'sliding' でなければなりません",
  'query/window-size-required': "'$window' 束縛には '$size' が必要です",
  'query/window-size': "'$size' は正の整数でなければなりません",
  'query/window-step': "'$step' は正の整数でなければなりません",
  'query/window-required': "'$size'/'$step' には '$window' が必要です",
  'query/for-key': "'{key}' は拡張 '$for' 束縛の有効なキーではありません",
  'query/for-in-required': "拡張 '$for' 束縛には '$in' が必要です",
  'query/for-at': "'$at' には変数名の文字列が必要です",
  'query/for-allowing-empty': "'$allowing-empty' には真偽値が必要です",
  'query/orderby-spec': "'$orderby' にはキー指定、またはキー指定の空でない配列が必要です",
  'query/orderby-spec-key': "'{key}' は $orderby キー指定の有効なキーではありません",
  'query/orderby-spec-key-required': "明示的な $orderby キー指定には '$key' が必要です",
  'query/orderby-dir': "'$dir' は 'asc' または 'desc' でなければなりません",
  'query/orderby-empty': "'$empty' は 'least' または 'greatest' でなければなりません",
  'query/collation-name': "'$collation' は登録された照合順序の名前でなければなりません",
  'query/collation-unregistered': "'$collation' が指定した照合順序 '{name}' は登録されていません",
  'query/fold-binding': "'$fold' にはアキュムレーター束縛がちょうど 1 つ必要です",
  'query/as-object': "'$as' には、変数名をスキーマに対応付けるメンバーからなるオブジェクトが必要です",
  'query/as-empty': "'$as' には少なくとも 1 つのメンバーが必要です",
  'query/as-unbound': "'$as' が指定した '{name}' は、このフレーズの '$for'/'$let' で束縛されていません",
  'query/count-variable': "'$count' には変数名の文字列が必要です",
  'query/map-entry': '$map のエントリはちょうど 2 つの式からなる配列でなければなりません',
  'query/call-arguments': "'$call' には ['name', ...引数の式] が必要です",
  'query/call-unregistered': "'$call' が指定した関数 '{name}' は登録されていません",
  'query/apply-arguments': "'$apply' には [セレクター] または [セレクター, モード] が必要です",
  'query/apply-mode': "'$apply' のモードは文字列リテラルでなければなりません",
  'query/document-value': 'クエリドキュメントに {type} 型の値を含めることはできません',
  'query/invalid-path': "'{path}' は有効なパスでもエスケープでもありません",
  'query/invalid-path-detail': "'{path}' は有効なパスではありません: {detail}",
  'query/unbound-variable': "'${name}' は外側のフレーズで束縛されておらず、宣言された外部パラメーターでもありません（宣言された外部パラメーター: {declared}）",
  'query/unbound-variable-closed': "'${name}' は外側のフレーズで束縛されておらず、宣言された外部パラメーターでもありません（このクエリはクローズドワールド方式でコンパイルされており、外部パラメーターを宣言していません）",
  'query/version-unknown': '不明なクエリ形式のバージョン {version}',
  'query/version-envelope': "バージョンエンベロープのキーは '$query' と '$expr' のちょうど 2 つでなければなりません",
  'query/schema-no-compiler': 'スキーマ演算子には型テストコンパイラー（options.compileTypeTest）が必要です',
  'query/schema-invalid': '無効なスキーマリテラル: {detail}',
  'query/schema-no-predicate': '型テストコンパイラーが述語関数を返しませんでした',
  'query/depth-limit': 'クエリの式が {depth} 段の深さまでネストしており、limits.depth（{limit}）を超えています',
  'query/spec-member-required': "'{name}' には仕様メンバー '{member}' が必要です",
  'query/spec-invalid': "'{name}' の仕様: {detail}",
  'query/date-pattern': "'$date-format' のパターン: {detail}",
  'query/time-bucket-invalid': "'$time-bucket' が無効です: {detail}",
  'query/lexical-arguments': '$lexical には [プロバイダー, テキスト式, リテラルリクエスト] が必要です',
  'query/lexical-unregistered': "レキシカル検索プロバイダー '{name}' は登録されていません",
  'query/lexical-rejected': 'レキシカル検索プロバイダーがリクエストを拒否しました',
  'query/lexical-no-request': 'レキシカル検索プロバイダーがリクエストをコンパイルしませんでした',
  'query/series-spec-object': "'{operator}' にはリテラルの仕様オブジェクトが必要ですが、{got}でした",
  'query/series-spec-member': "'{operator}' には仕様メンバー '{name}' がありません。使用できるのは {allowed} です",
  'query/series-spec-member-suggest': "'{operator}' には仕様メンバー '{name}' がありません（'{suggestion}' のことですか？）。使用できるのは {allowed} です",
  'query/series-member-enum': "'{member}' は {allowed} のいずれかでなければなりませんが、{got}でした",
  'query/series-member-number': "'{member}' は有限の数値でなければなりませんが、{got}でした",
  'query/series-member-instant': "'{member}' はエポックミリ秒または RFC 3339 文字列でなければなりませんが、{got}でした",
  'query/series-member-duration': "'{member}' は期間の文字列またはミリ秒数でなければなりませんが、{got}でした",
  'query/series-member-path': "'{member}' は行内を指す単一パスでなければなりませんが、{got}でした",
  'query/series-member-path-detail': "'{member}' のパスが無効です: {detail}",
  'query/series-member-not-path': "'{member}' はパスではありません",
  'query/series-member-whole-row': "'{member}' は行のメンバーではなく行全体を選択しています",
  'query/series-member-singular': "'{member}' は単一パスでなければなりません（セグメントごとに名前またはインデックスを 1 つだけ使い、ワイルドカード、子孫、フィルターは使用できません）",
  'query/series-zone': "'zone' は IANA タイムゾーン名でなければなりませんが、{got}でした",
  'query/series-zone-provider': "タイムゾーン '{zone}' にはタイムゾーンプロバイダーが必要です: このスイートは tzdb を同梱していないため、名前付きゾーンは options.zoneProvider（toParts / toEpoch）でコンパイルされます。'UTC' と数値の 'offset' には不要です",
  'query/series-calendar': 'カレンダーコンテキスト: {detail}',
  'query/expected-string': '文字列が必要ですが、{got}でした',
  'query/expected-number': '数値が必要ですが、{got}でした',
  'query/cast-string': '{got}を文字列にキャストできません',
  'query/cast-number': '{got}を数値にキャストできません',
  'query/not-json-number': "'{value}' は JSON の数値ではありません",
  'query/arithmetic-operand': '算術演算には数値のオペランドが必要ですが、{got}でした',
  'query/aggregate-not-number': '集計の項目は数値でなければなりませんが、{got}でした',
  'query/aggregate-null': '集計には数値または文字列が必要ですが、null 値でした',
  'query/minmax-mixed': "'$min'/'$max' の項目はすべて数値か、すべて文字列でなければなりませんが、{got}でした",
  'query/sort-mixed': "'$sort' の項目はすべて数値か、すべて文字列でなければなりませんが、{got}でした",
  'query/regex-invalid': "'{pattern}' は有効な I-Regexp パターンではありません",
  'query/replace-empty-match': "'$replace' のパターン '{pattern}' が長さ 0 の文字列に一致します",
  'query/range-bounds': "'$range' の境界は安全な整数でなければなりませんが、{got}でした",
  'query/range-guard': "'$range' の項目数 {count} が、リソース保護の上限である {limit} 個を超えています",
  'query/index-of-item': "'$index-of' には単一の検索項目が必要ですが、{got}でした",
  'query/expected-datetime': 'RFC 3339 の日付、時刻、または日時の文字列が必要ですが、{got}でした',
  'query/no-date-component': "'{value}' には日付の要素がありません",
  'query/no-time-component': "'{value}' には時刻の要素がありません",
  'query/calendar-unit': "カレンダー単位（'year'、'month'、'day' など）が必要ですが、{got}でした",
  'query/expected-duration': 'ISO 8601 の期間が必要ですが、{got}でした',
  'query/expected-units': '単位数が必要ですが、{got}でした',
  'query/expected-date-pattern': '日付パターンが必要ですが、{got}でした',
  'query/datetime-epoch': "'$datetime' にはエポックミリ秒が必要ですが、{got}でした",
  'query/datetime-range': '{value} は RFC 3339 で表記できる範囲外です',
  'query/span-no-date': '日付を持たない値からは期間を測定できません',
  'query/expected-bucket-width': 'バケット幅が必要ですが、{got}でした',
  'query/expected-geo': 'GeoJSON 値または [経度, 緯度] の位置が必要ですが、{got}でした',
  'query/expected-wkt': 'Well-Known Text 文字列が必要ですが、{got}でした',
  'query/expected-geohash': 'geohash セル文字列が必要ですが、{got}でした',
  'query/geohash-precision': 'geohash の精度は 1～12 の整数でなければなりませんが、{got}でした',
  'query/simplify-tolerance': '簡略化の許容誤差は 0 以上の度数でなければなりませんが、{got}でした',
  'query/expected-vector': 'ベクトル（数値の配列）が必要ですが、{got}でした',
  'query/expected-vector-item': 'ベクトル（数値の配列）が必要ですが、{got}でした（インデックス {index}）',
  'query/expected-series': '時系列（時点と測定値を持つレコード）が必要ですが、{got}でした',
  'query/expected-interval': '区間レコード {{ start, end } が必要ですが、{got}でした',
  'query/member-cardinality': "メンバー '{name}' の評価結果は {count} 個の項目でした。オブジェクトのメンバーには項目がちょうど 1 つ必要です",
  'query/groupby-key': '$groupby のキーは空のシーケンスまたは単一の項目でなければなりませんが、{got}でした',
  'query/lexical-text': 'レキシカル検索のテキストは 1 つの文字列でなければなりません',
  'query/idiv-zero': "'$idiv' のゼロ除算",
  'query/mod-zero': "'$mod' のゼロ除算",
  'query/ebv-sequence': '2 つ以上の項目からなるシーケンスの実効真偽値は未定義です',
  'query/map-key': '$map のキーは単一の文字列に評価されなければなりませんが、{got}でした',
  'query/orderby-key': '$orderby のキーは空のシーケンス、数値、または文字列でなければなりませんが、{got}でした',
  'query/orderby-number-string': '$orderby では数値を文字列と比較して並べ替えることはできません',
  'query/orderby-string-number': '$orderby では文字列を数値と比較して並べ替えることはできません',
  'query/external-unbound': "外部パラメーター '{name}' が束縛されていません",
  'query/assert-failed': "'$assert' が失敗しました: {got}はスキーマを満たしていません",
  'query/assert-failed-item': "'$assert' が失敗しました: 項目 {index}（{got}）はスキーマを満たしていません",
  'query/as-failed': "変数 '{name}' の '$as' スキーマ検査が失敗しました: {got}はスキーマを満たしていません",
  'query/as-failed-item': "変数 '{name}' の '$as' スキーマ検査が失敗しました: 項目 {index}（{got}）はスキーマを満たしていません",
  'query/fold-limit': '畳み込みのアキュムレーターが {limit} 個の項目を超えました（limits.sequenceItems）',
  'query/phrase-limit': 'フレーズが {limit} 個を超える項目を具体化しました（limits.sequenceItems）',
  'query/steps-limit': 'クエリが limits.steps（式の評価 {limit} 回）を超えました',
  'query/result-limit': 'クエリ結果の項目数は {count} 個で、limits.resultItems（{limit}）を超えています',
  'query/function-threw': "登録された関数 '{name}' が例外をスローしました: {detail}",
  'query/operator-threw': "登録された演算子 '{name}' が失敗しました: {detail}",
  'query/input-undefined': '入力ドキュメントが undefined です（undefined は JSON 値ではありません）',
  'query/lexical-threw': 'レキシカル検索プロバイダーが例外をスローしました',
  'query/lexical-result': 'レキシカル検索プロバイダーが無効または不完全な結果を返しました',
  //#endregion
};
