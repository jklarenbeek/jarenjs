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
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn`.
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
  'contract/malformed-body': '{op} işleminin istek gövdesi geçerli UTF-8 metni değil',
  'contract/invalid-input': '{op} işleminin girdisi geçersiz',
  'contract/idempotency-key-required': '{op} işlemi bir Idempotency-Key üst bilgisi gerektirir',
  'contract/handler-failed': '{op} işlemi başarısız oldu',
  'contract/idempotency-conflict': '{op} işleminin Idempotency-Key değeri daha önceki bir istekle çakışıyor ({kind})',
  'contract/invalid-output': '{op} işlemi sözleşmesini ihlal eden bir yanıt üretti',
  'contract/malformed-path': 'istek yolu hatalı bir yüzde kaçış dizisi ya da . veya .. olan bir bölüm içeriyor',
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

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': '{count} öğeli dizi',
  'query/item/empty': 'boş dizi',
  'query/item/null': 'null',
  'query/item/array': 'liste',
  'query/item/object': 'nesne',
  'query/item/string': 'metin',
  'query/item/number': 'sayı',
  'query/item/boolean': 'boole değeri',
  'query/item/other': '{type} türünde değer',
  'query/mixed-keys': 'bir nesne $-prefixed anahtarlarla düz anahtarları karıştıramaz',
  'query/unknown-operator': "bilinmeyen '{key}' işleci",
  'query/unknown-operator-suggest': "bilinmeyen '{key}' işleci (şunu mu demek istediniz: '{suggestion}'?)",
  'query/unknown-operator-use': "bilinmeyen '{key}' işleci (şunu kullanın: {use})",
  'query/unknown-operator-none': "bilinmeyen '{key}' işleci (jaren-query içinde bunu yapan bir işleç yok)",
  'query/use/head-of-reverse': '$reverse sonucuna uygulanan $head',
  'query/use/jsonpath-filter': '$[?(@.x > 1)] gibi bir JSONPath filtresi ya da bir $for içinde $where',
  'query/use/for-return': '$return içeren bir $for öbeği',
  'query/use/for-phrase': 'bir $for öbeği',
  'query/use/sort-objects': '$sort (skalerleri sıralar; nesneler, sıralanmış bir anahtar üzerinde bir $for ile sıralanır)',
  'query/use/sort-scalars': '$sort (yalnızca skalerler)',
  'query/use/entries-get': '$entries, ardından $get',
  'query/use/geo-parse-text': 'okumak için $geo-parse, yazmak için $geo-text',
  'query/use/bbox-intersects': '$bbox-intersects (yalnızca sınırlayıcı kutular — gerçek çakıştırma bilerek dışarıda bırakıldı)',
  'query/use/renderer': 'haritayı çizen katman — dil hiçbir şekilde projeksiyonlu bir koordinat üretemez, bu yüzden bir ölçüm asla böyle bir koordinat üzerinde yapılamaz; buradaki ölçümler jeodeziktir',
  'query/use/renderer-project': "haritayı çizen katman, '$project' için olduğu gibi",
  'query/use/similarity': '$similarity (yüksek değer daha yakın demektir; uzaklık metriği yoktur)',
  'query/use/knn-desc': "$dir 'desc' ile bir $similarity anahtarı üzerinde $orderby, ardından ilk k öğe için $subsequence",
  'query/use/knn': 'bir $similarity anahtarı üzerinde $orderby, ardından $subsequence',
  'query/use/top-k': '$orderby, ardından $subsequence',
  'query/use/resample-fill': "'fill' içeren bir $resample",
  'query/use/resample-locf': "fill değeri 'locf' olan bir $resample",
  'query/use/resample-linear': "fill değeri 'linear' olan bir $resample",
  'query/use/rolling-mean': "aggregate değeri 'mean' olan bir $rolling",
  'query/phrase-keys': 'geçersiz öbek anahtarı birleşimi ({keys})',
  'query/phrase-alone': "'{key}' tek başına bir öbek oluşturamaz",
  'query/operands-array': "'{op}' bir ifade listesi alır",
  'query/operands-exactly': "'{op}' tam olarak {min} işlenen alır, gelen: {count}",
  'query/operands-at-least': "'{op}' en az {min} işlenen alır, gelen: {count}",
  'query/operands-range': "'{op}' {min} ile {max} arasında işlenen alır, gelen: {count}",
  'query/variable-name-expected': 'beklenen: değişken adı içeren bir metin',
  'query/variable-name-invalid': "'{name}' geçerli bir değişken adı değil",
  'query/variable-duplicate': "aynı öbek içinde '{name}' değişkeni için yinelenen bağlama",
  'query/bindings-object': "'{clause}' değişken bağlamalarından oluşan bir nesne alır",
  'query/bindings-empty': "'{clause}' en az bir bağlama gerektirir",
  'query/extended-let': "genişletilmiş bağlama biçimi '$let' içinde kullanılamaz",
  'query/extended-quantifier': 'genişletilmiş bağlama biçimi niceleyicilerde kullanılamaz',
  'query/window-kind': "'$window' 'tumbling' ya da 'sliding' olmalıdır",
  'query/window-size-required': "'$window' bağlaması '$size' gerektirir",
  'query/window-size': "'$size' pozitif bir tam sayı olmalıdır",
  'query/window-step': "'$step' pozitif bir tam sayı olmalıdır",
  'query/window-required': "'$size'/'$step' için '$window' gereklidir",
  'query/for-key': "'{key}', genişletilmiş bir '$for' bağlamasının geçerli bir anahtarı değil",
  'query/for-in-required': "genişletilmiş bir '$for' bağlaması '$in' gerektirir",
  'query/for-at': "'$at' değişken adı içeren bir metin alır",
  'query/for-allowing-empty': "'$allowing-empty' bir boole değeri alır",
  'query/orderby-spec': "'$orderby' bir anahtar belirtimi ya da boş olmayan bir anahtar belirtimi listesi alır",
  'query/orderby-spec-key': "'{key}', bir $orderby anahtar belirtiminin geçerli bir anahtarı değil",
  'query/orderby-spec-key-required': "açık bir $orderby anahtar belirtimi '$key' gerektirir",
  'query/orderby-dir': "'$dir' 'asc' ya da 'desc' olmalıdır",
  'query/orderby-empty': "'$empty' 'least' ya da 'greatest' olmalıdır",
  'query/collation-name': "'$collation' kayıtlı bir harmanlama adı olmalıdır",
  'query/collation-unregistered': "'$collation' kayıtlı olmayan '{name}' harmanlamasını adlandırıyor",
  'query/fold-binding': "'$fold' tam olarak bir biriktirici bağlaması alır",
  'query/as-object': "'$as', üyeleri değişken adlarını şemalarla eşleyen bir nesne alır",
  'query/as-empty': "'$as' en az bir üye gerektirir",
  'query/as-unbound': "'$as' içindeki '{name}', bu öbeğin '$for'/'$let' yan tümceleri tarafından bağlanmamış",
  'query/count-variable': "'$count' değişken adı içeren bir metin alır",
  'query/map-entry': 'bir $map girdisi tam olarak iki ifadeden oluşan bir liste olmalıdır',
  'query/call-arguments': "'$call' için ['name', ...bağımsız değişken ifadeleri] gereklidir",
  'query/call-unregistered': "'$call' kayıtlı olmayan '{name}' işlevini adlandırıyor",
  'query/apply-arguments': "'$apply' [seçici] ya da [seçici, mod] alır",
  'query/apply-mode': "'$apply' modu değişmez bir metin olmalıdır",
  'query/document-value': 'bir sorgu belgesi {type} türünde bir değer içeremez',
  'query/invalid-path': "'{path}' geçerli bir yol ya da kaçış dizisi değil",
  'query/invalid-path-detail': "'{path}' geçerli bir yol değil: {detail}",
  'query/unbound-variable': "'${name}' kapsayan bir öbek tarafından bağlanmamış ve bildirilmiş bir harici parametre de değil (bildirilmiş harici parametreler: {declared})",
  'query/unbound-variable-closed': "'${name}' kapsayan bir öbek tarafından bağlanmamış ve bildirilmiş bir harici parametre de değil (bu sorgu kapalı dünya modunda, hiçbir harici parametre bildirilmeden derlendi)",
  'query/version-unknown': 'bilinmeyen sorgu biçimi sürümü: {version}',
  'query/version-envelope': "sürüm zarfı tam olarak '$query' ve '$expr' anahtarlarını gerektirir",
  'query/schema-no-compiler': 'şema işleçleri bir tür testi derleyicisi gerektirir (options.compileTypeTest)',
  'query/schema-invalid': 'geçersiz şema değişmezi: {detail}',
  'query/schema-no-predicate': 'tür testi derleyicisi bir yüklem işlevi döndürmedi',
  'query/depth-limit': 'sorgu, ifadeleri {depth} düzey derinliğe kadar iç içe yerleştiriyor; bu, limits.depth ({limit}) sınırından fazla',
  'query/spec-member-required': "'{name}' için '{member}' belirtim üyesi gereklidir",
  'query/spec-invalid': "'{name}' belirtimi: {detail}",
  'query/date-pattern': "'$date-format' deseni: {detail}",
  'query/time-bucket-invalid': "geçersiz '$time-bucket': {detail}",
  'query/lexical-arguments': '$lexical için [sağlayıcı, metin ifadesi, değişmez istek] gereklidir',
  'query/lexical-unregistered': "'{name}' sözcüksel sağlayıcısı kayıtlı değil",
  'query/lexical-rejected': 'sözcüksel sağlayıcı isteği reddetti',
  'query/lexical-no-request': 'sözcüksel sağlayıcı bir istek derlemedi',
  'query/series-spec-object': "'{operator}' değişmez bir belirtim nesnesi alır, gelen: {got}",
  'query/series-spec-member': "'{operator}' için '{name}' adlı bir belirtim üyesi yok; kabul edilenler: {allowed}",
  'query/series-spec-member-suggest': "'{operator}' için '{name}' adlı bir belirtim üyesi yok (şunu mu demek istediniz: '{suggestion}'?); kabul edilenler: {allowed}",
  'query/series-member-enum': "'{member}', {allowed} değerlerinden biridir, gelen: {got}",
  'query/series-member-number': "'{member}' sonlu bir sayıdır, gelen: {got}",
  'query/series-member-instant': "'{member}' bir epoch milisaniye değeri ya da RFC 3339 metnidir, gelen: {got}",
  'query/series-member-duration': "'{member}' bir süre metni ya da milisaniye sayısıdır, gelen: {got}",
  'query/series-member-path': "'{member}' satır içinde tekil bir yoldur, gelen: {got}",
  'query/series-member-path-detail': "'{member}' üyesi: {detail}",
  'query/series-member-not-path': "'{member}': bir yol değil",
  'query/series-member-whole-row': "'{member}', satırın bir üyesi yerine satırın tamamını seçiyor",
  'query/series-member-singular': "'{member}' tekil bir yoldur — bölüm başına bir ad ya da dizin; joker karakter, alt öğe ya da filtre yok",
  'query/series-zone': "'zone' bir IANA saat dilimi adıdır, gelen: {got}",
  'query/series-zone-provider': "'{zone}' saat dilimi bir saat dilimi sağlayıcısı gerektirir: bu paket hiçbir tzdb içermez, bu yüzden adlandırılmış bir saat dilimi options.zoneProvider (toParts / toEpoch) ile derlenir. 'UTC' ve sayısal bir 'offset' için sağlayıcı gerekmez",
  'query/series-calendar': 'takvim bağlamı: {detail}',
  'query/expected-string': 'beklenen: metin, gelen: {got}',
  'query/expected-number': 'beklenen: sayı, gelen: {got}',
  'query/cast-string': '{got} metne dönüştürülemez',
  'query/cast-number': '{got} sayıya dönüştürülemez',
  'query/not-json-number': "'{value}' bir JSON sayısı değil",
  'query/arithmetic-operand': 'aritmetik işlemler sayısal bir işlenen gerektirir, gelen: {got}',
  'query/aggregate-not-number': 'toplanan öğeler sayı olmalıdır, gelen: {got}',
  'query/aggregate-null': 'bir toplama işlevi sayı ya da metin gerektirir, gelen: null',
  'query/minmax-mixed': "'$min'/'$max' öğelerinin tümü sayı ya da tümü metin olmalıdır, gelen: {got}",
  'query/sort-mixed': "'$sort' öğelerinin tümü sayı ya da tümü metin olmalıdır, gelen: {got}",
  'query/regex-invalid': "'{pattern}' geçerli bir I-Regexp deseni değil",
  'query/replace-empty-match': "'$replace' için '{pattern}' deseni sıfır uzunluklu metinle eşleşiyor",
  'query/range-bounds': "'$range' sınırları güvenli tam sayılar olmalıdır, gelen: {got}",
  'query/range-guard': "{count} öğelik '$range', {limit} öğelik kaynak korumasını aşıyor",
  'query/index-of-item': "'$index-of' tek bir arama öğesi alır, gelen: {got}",
  'query/expected-datetime': 'beklenen: RFC 3339 tarih, saat ya da tarih ve saat metni, gelen: {got}',
  'query/no-date-component': "'{value}' bir tarih bileşeni içermiyor",
  'query/no-time-component': "'{value}' bir saat bileşeni içermiyor",
  'query/calendar-unit': "beklenen: takvim birimi ('year', 'month', 'day', ...), gelen: {got}",
  'query/expected-duration': 'beklenen: ISO 8601 süresi, gelen: {got}',
  'query/expected-units': 'beklenen: birim sayısı, gelen: {got}',
  'query/expected-date-pattern': 'beklenen: tarih deseni, gelen: {got}',
  'query/datetime-epoch': "'$datetime' epoch milisaniye değeri alır, gelen: {got}",
  'query/datetime-range': '{value}, RFC 3339 ile yazılabilecek aralığın dışında',
  'query/span-no-date': 'tarihi olmayan bir değerden süre ölçülemez',
  'query/expected-bucket-width': 'beklenen: kova genişliği, gelen: {got}',
  'query/expected-geo': 'beklenen: GeoJSON değeri ya da [boylam, enlem] konumu, gelen: {got}',
  'query/expected-wkt': 'beklenen: Well-Known Text metni, gelen: {got}',
  'query/expected-geohash': 'beklenen: geohash hücresi metni, gelen: {got}',
  'query/geohash-precision': 'geohash duyarlığı 1 ile 12 arasında bir tam sayı olmalıdır, gelen: {got}',
  'query/simplify-tolerance': 'basitleştirme toleransı negatif olmayan bir derece sayısıdır, gelen: {got}',
  'query/expected-vector': 'beklenen: vektör (sayılardan oluşan bir liste), gelen: {got}',
  'query/expected-vector-item': 'beklenen: vektör (sayılardan oluşan bir liste), gelen: {got} (dizin {index})',
  'query/expected-series': 'beklenen: seri (bir zaman anı ve bir ölçüm değeri içeren kayıtlar), gelen: {got}',
  'query/expected-interval': 'beklenen: aralık kaydı {{ start, end }, gelen: {got}',
  'query/member-cardinality': "'{name}' üyesi {count} öğe üretti; bir nesne üyesi tam olarak bir öğe alır",
  'query/groupby-key': 'bir $groupby anahtarı boş dizi ya da tek bir öğe olmalıdır, gelen: {got}',
  'query/lexical-text': 'sözcüksel metin tek bir metin değeri olmalıdır',
  'query/idiv-zero': "'$idiv' ile sıfıra bölme",
  'query/mod-zero': "'$mod' ile sıfıra bölme",
  'query/ebv-sequence': 'iki ya da daha fazla öğeli bir dizinin etkin boole değeri tanımsızdır',
  'query/map-key': 'bir $map anahtarı tek bir metin üretmelidir, gelen: {got}',
  'query/orderby-key': 'bir $orderby anahtarı boş dizi, sayı ya da metin olmalıdır, gelen: {got}',
  'query/orderby-number-string': '$orderby içinde bir sayı bir metne göre sıralanamaz',
  'query/orderby-string-number': '$orderby içinde bir metin bir sayıya göre sıralanamaz',
  'query/external-unbound': "'{name}' harici parametresi bağlanmadı",
  'query/assert-failed': "'$assert' başarısız oldu: {got} şemayı karşılamıyor",
  'query/assert-failed-item': "'$assert' başarısız oldu: öğe {index} ({got}) şemayı karşılamıyor",
  'query/as-failed': "'{name}' değişkeni '$as' şemasını karşılamadı: {got} bu şemayı karşılamıyor",
  'query/as-failed-item': "'{name}' değişkeni '$as' şemasını karşılamadı: öğe {index} ({got}) bu şemayı karşılamıyor",
  'query/fold-limit': 'bir katlama biriktiricisi {limit} öğeyi aştı (limits.sequenceItems)',
  'query/phrase-limit': 'bir öbek {limit} öğeden fazlasını somutlaştırdı (limits.sequenceItems)',
  'query/steps-limit': 'sorgu limits.steps sınırını aştı ({limit} ifade değerlendirmesi)',
  'query/result-limit': 'sorgu sonucu {count} öğe içeriyor; bu, limits.resultItems ({limit}) sınırından fazla',
  'query/function-threw': "kayıtlı '{name}' işlevi bir özel durum oluşturdu: {detail}",
  'query/operator-threw': "kayıtlı '{name}' işleci başarısız oldu: {detail}",
  'query/input-undefined': 'girdi belgesi undefined; bu bir JSON değeri değil',
  'query/lexical-threw': 'sözcüksel sağlayıcı bir özel durum oluşturdu',
  'query/lexical-result': 'sözcüksel sağlayıcı geçersiz ya da eksik bir sonuç döndürdü',
  //#endregion
};
