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
  dateNameEntries,
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
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
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
  'form/addItem': 'Öğe ekle',
  'form/removeItem': 'Öğeyi kaldır',
  'form/jsonPlaceholder': 'Bir JSON değeri girin',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'isteğin yöntemi ve yoluyla eşleşen bir işlem yok',
  'contract/method-not-allowed': 'bu yol başka yöntemler altında sunuluyor: {allow}',
  'contract/body-too-large': '{op} işleminin istek gövdesi {limit} baytlık sınırını aşıyor',
  'contract/unsupported-media': '{op} işlemi yalnızca {media} gövdeleri kabul eder',
  'contract/malformed-json': '{op} işleminin istek gövdesi geçerli JSON değil',
  'contract/invalid-input': '{op} işleminin girdisi geçersiz',
  'contract/idempotency-key-required': '{op} işlemi bir Idempotency-Key üst bilgisi gerektirir',
  'contract/handler-failed': '{op} işlemi başarısız oldu',
  'contract/idempotency-conflict': '{op} işleminin Idempotency-Key değeri daha önceki bir istekle çakışıyor ({kind})',
  'contract/invalid-output': '{op} işlemi sözleşmesini ihlal eden bir yanıt üretti',
  'contract/malformed-path': 'istek yolu hatalı bir yüzde kaçış dizisi içeriyor',
  'contract/malformed-query': 'sorgu dizesi çözümlenemiyor',
  'contract/not-implemented': '{op} işlemi bu sunucuda uygulanmamış',
  'contract/precondition-failed': '{op} işleminin If-Match ön koşulu sağlanamadı',
  'contract/invalid-header': '{op} işleminin {header} üst bilgisi geçersiz',
  'contract/handler-error': '{op} işlemi {code} ile başarısız oldu',
  'contract/client-invalid-input': '{op} işleminin girdisi geçersiz; hiçbir şey gönderilmedi',
  'contract/network': '{op} isteği tamamlanmadı ({name})',
  'contract/cancelled': '{op} işleminin isteği iptal edildi',
  'contract/invalid-response': '{op} işleminin yanıtı sözleşmesini ihlal ediyor',
  'contract/key-storage-failed': '{op} işleminin idempotens anahtarı saklanamadı; hiçbir şey gönderilmedi',
  'contract/undeclared-response': '{op} işlemi bildirilmemiş bir yanıt döndürdü (durum {status})',
  'contract/not-a-contract': 'sunucu, well-known yolunda {id} sözleşmesini tanımlamıyor',
  'contract/incompatible': 'sunucu {id} sözleşmesinin {server} sürümünü, bu istemci {client} sürümünü konuşuyor ve iki taraf da diğerini uyumlu ilan etmiyor',
  'contract/host-failed': '{op} işlemi bir sonuç üretilmeden önce ana bilgisayarda başarısız oldu',
  'contract/local-handler-failed': '{op} işlemi sunan ana bilgisayarda başarısız oldu',
  'contract/unknown-operation': 'istek bu kanalda sunulan hiçbir işlemi adlandırmıyor',
  'contract/port-timeout': '{op} işlemi kanalda {ms} ms içinde yanıt alamadı',
  'contract/malformed-frame': '{op} işleminin yanıt çerçevesi hatalı',
  'contract/channel-closed': '{op} işleminin kanalı kapalı',
  'contract/not-a-stream': 'sunucu {op} işleminin aboneliğine akış olmayan bir yanıtla karşılık verdi',
  'contract/invalid-snapshot': '{op} işlemi sözleşmesini ihlal eden bir anlık görüntü üretti',
  'contract/seq-regression': '{op} işleminin akışı seq sırasını ihlal etti',
  'contract/stream-error': '{op} işleminin akışı bir sunucu hatasıyla sona erdi ({code})',
  'contract/heartbeat-missed': '{op} işleminin akışı {ms} ms boyunca sessiz kaldı',
  'contract/slow-consumer': '{op} işleminin akışı sona erdi: tüketici sınırlı kuyruğunun gerisinde kaldı',
  'contract/reconnect-exhausted': '{op} işleminin akışı {attempts} denemeden sonra yeniden kurulamadı (son: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // Turkish nouns stay singular after a numeral, and 'once'/'sonra'
  // follow the noun, so no suffix ever attaches to interpolated text.
  ...dateNameEntries({
    months: [
      'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
      'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
    ],
    monthsShort: [
      'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz',
      'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
    ],
    weekdays: [
      'Pazar', 'Pazartesi', 'Salı', 'Çarşamba',
      'Perşembe', 'Cuma', 'Cumartesi',
    ],
    weekdaysShort: [
      'Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt',
    ],
    meridiem: ['ÖÖ', 'ÖS'],
  }),
  'date/relative/second/past': (p) => `${num(p.value)} saniye önce`,
  'date/relative/second/future': (p) => `${num(p.value)} saniye sonra`,
  'date/relative/minute/past': (p) => `${num(p.value)} dakika önce`,
  'date/relative/minute/future': (p) => `${num(p.value)} dakika sonra`,
  'date/relative/hour/past': (p) => `${num(p.value)} saat önce`,
  'date/relative/hour/future': (p) => `${num(p.value)} saat sonra`,
  'date/relative/day/past': (p) => `${num(p.value)} gün önce`,
  'date/relative/day/future': (p) => `${num(p.value)} gün sonra`,
  'date/relative/week/past': (p) => `${num(p.value)} hafta önce`,
  'date/relative/week/future': (p) => `${num(p.value)} hafta sonra`,
  'date/relative/month/past': (p) => `${num(p.value)} ay önce`,
  'date/relative/month/future': (p) => `${num(p.value)} ay sonra`,
  'date/relative/year/past': (p) => `${num(p.value)} yıl önce`,
  'date/relative/year/future': (p) => `${num(p.value)} yıl sonra`,
  'date/relative/now': 'şimdi',
  'date/relative/yesterday': 'dün',
  'date/relative/today': 'bugün',
  'date/relative/tomorrow': 'yarın',
  'format/name/date': 'tarih',
  'format/name/time': 'saat',
  'format/name/date-time': 'tarih ve saat',
  'format/name/iso-date': 'ISO tarih',
  'format/name/iso-time': 'ISO saat',
  'format/name/iso-date-time': 'ISO tarih ve saat',
  //#endregion
};
