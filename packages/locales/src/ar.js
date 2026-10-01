//@ts-check

/**
 * Arabic (ar) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - Arabic pluralizes across six categories, so counted messages phrase
 *   around a fixed "عدد" (count-of) noun ("يجب ألا يقل عدد الأحرف عن 2")
 *   instead of agreeing the noun with the number - the standard
 *   software-string convention. The relative-time phrases are the
 *   exception, because there the counted noun IS the message, so they
 *   agree through `Intl.PluralRules`,
 * - `Intl.NumberFormat` is pinned to Latin digits (`numberingSystem:
 *   'latn'`): the limits describe JSON documents, which are written in
 *   Latin digits regardless of UI language,
 * - `Intl.ListFormat` renders enum alternatives ("a أو b أو c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralForms,
  makeTypeNamer,
  dateNameEntries,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('ar');
const numberFormat = new Intl.NumberFormat('ar', { numberingSystem: 'latn' });
const listFormat = new Intl.ListFormat('ar', { style: 'long', type: 'disjunction' });

/**
 * Render a numeric limit through the Arabic (Latin-digit) number
 * format; non-numbers (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Arabic names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'نص (string)',
  number: 'رقم',
  integer: 'عدد صحيح',
  boolean: 'قيمة منطقية',
  array: 'مصفوفة (array)',
  object: 'كائن',
  null: 'null',
};

/** Type keyword values under their Arabic display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

/** Pick the form a counted noun takes across Arabic's six categories. */
const plural = makePluralForms(pluralRules);

/**
 * Count a noun the Arabic way: one and two are carried by the noun's own
 * forms and take no numeral at all ("ثانية واحدة", "ثانيتين"), three to
 * ten take the broken plural after the numeral, eleven to ninety-nine
 * take the accusative singular ("21 يومًا") and a hundred or more the
 * bare singular. This is the one place the pack
 * cannot phrase around a fixed noun - a relative-time phrase IS the
 * counted noun.
 * @param {number} value - The absolute amount
 * @param {Record<string, string>} forms - The noun's forms by CLDR category
 * @returns {string}
 */
function counted(value, forms) {
  const category = pluralRules.select(value);
  return (category === 'one' || category === 'two')
    ? plural(value, forms)
    : `${num(value)} ${plural(value, forms)}`;
}

/**
 * The limit comparisons in words: an ASCII operator between RTL text
 * and a number falls to the bidi algorithm's neutral reordering and
 * displays flipped ("=<"), so the four operators validate emits render
 * as phrases instead.
 */
const COMPARISON_PHRASES = {
  '>=': 'يجب ألا تقل القيمة عن',
  '<=': 'يجب ألا تزيد القيمة عن',
  '>': 'يجب أن تكون القيمة أكبر من',
  '<': 'يجب أن تكون القيمة أصغر من',
};

/**
 * Render a limit comparison; an unexpected operator falls back to the
 * symbol wrapped in a left-to-right isolate (U+2066 LRI … U+2069 PDI) so
 * it still reads left-to-right inside the RTL sentence. LRI rather than
 * the first-strong FSI on purpose: an operator has no strong character
 * for FSI to sample, so the direction has to be stated outright.
 * @param {{ comparison: string, limit: unknown }} p - The message params
 * @returns {string}
 */
function compareLimit(p) {
  const phrase = COMPARISON_PHRASES[p.comparison];
  return phrase !== undefined
    ? `${phrase} ${num(p.limit)}`
    : `يجب أن تكون القيمة ⁦${p.comparison} ${num(p.limit)}⁩`;
}

//#endregion

/**
 * The Arabic catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn` — the
 * contract and query entries wrap their Latin values (operation ids,
 * media types, error codes, operator names, paths and quoted values) in
 * first-strong isolates (U+2068 FSI … U+2069 PDI) so a Latin run cannot
 * reorder the RTL sentence around it.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ar = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `يجب أن تكون القيمة من أحد الأنواع التالية: ${p.types.join(', ')}`
    : `يجب أن تكون القيمة من نوع ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `يجب أن تحتوي على الخاصية الإلزامية '${p.missingProperty}'`
    : 'يجب أن تحتوي على الخصائص الإلزامية',
  minimum: compareLimit,
  maximum: compareLimit,
  exclusiveMinimum: compareLimit,
  exclusiveMaximum: compareLimit,
  multipleOf: (p) => `يجب أن تكون القيمة من مضاعفات ${num(p.multipleOf)}`,
  minLength: (p) => `يجب ألا يقل عدد الأحرف عن ${num(p.limit)}`,
  maxLength: (p) => `يجب ألا يزيد عدد الأحرف عن ${num(p.limit)}`,
  pattern: 'يجب أن تطابق النمط "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `يجب ألا تحتوي على الخاصية الإضافية '${p.additionalProperty}'`
    : 'يجب ألا تحتوي على خصائص إضافية',
  minProperties: (p) => `يجب ألا يقل عدد الخصائص عن ${num(p.limit)}`,
  maxProperties: (p) => `يجب ألا يزيد عدد الخصائص عن ${num(p.limit)}`,
  minItems: (p) => `يجب ألا يقل عدد العناصر عن ${num(p.limit)}`,
  maxItems: (p) => `يجب ألا يزيد عدد العناصر عن ${num(p.limit)}`,
  uniqueItems: 'يجب ألا تحتوي على عناصر مكررة',
  contains: 'يجب أن تحتوي على عنصر صالح واحد على الأقل',
  items: 'عناصر المصفوفة غير صالحة',
  allOf: 'يجب أن تطابق جميع المخططات الفرعية',
  anyOf: 'يجب أن تطابق أحد المخططات الفرعية في anyOf',
  oneOf: 'يجب أن تطابق مخططًا فرعيًا واحدًا بالضبط في oneOf',
  not: 'يجب ألا تطابق المخطط الفرعي',
  format: 'يجب أن تطابق التنسيق "{format}"',
  if: 'يجب أن تطابق مخطط "if"',
  then: 'يجب أن تطابق مخطط "then"',
  else: 'يجب أن تطابق مخطط "else"',
  'false schema': 'المخطط المنطقي false غير صالح دائمًا',
  $query: (p) => p.code
    ? `أثار تأكيد '$query' الخطأ ${p.code} في '${p.docPath}'`
    : "يجب أن تحقق تأكيد '$query'",
  JQ2001: (p) => `تعذر تقييم تأكيد '$query' (${p.code} في '${p.docPath}')`,
  JQ2003: (p) => `أرجع تأكيد '$query' نتائج متعددة (${p.code} في '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'هذا الحقل إلزامي',
  'form/type': (p) => `يجب أن تكون القيمة من نوع ${typeName(p.type)}`,
  'form/const': (p) => `يجب أن تكون القيمة ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `يجب أن تكون القيمة ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `يجب ألا يقل عدد الأحرف عن ${num(p.limit)} (حاليًا ${num(p.len)})`,
  'form/maxLength': (p) => `يجب ألا يزيد عدد الأحرف عن ${num(p.limit)} (حاليًا ${num(p.len)})`,
  'form/pattern': 'يجب أن تطابق القيمة النمط {pattern}',
  'form/format': (p) => `يجب أن تكون القيمة بتنسيق ${p.format} صالح`,
  'form/minimum': (p) => `يجب ألا تقل القيمة عن ${num(p.limit)}`,
  'form/maximum': (p) => `يجب ألا تزيد القيمة عن ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `يجب أن تكون القيمة أكبر من ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `يجب أن تكون القيمة أصغر من ${num(p.limit)}`,
  'form/multipleOf': (p) => `يجب أن تكون القيمة من مضاعفات ${num(p.multipleOf)}`,
  'form/minItems': (p) => `يجب ألا يقل عدد العناصر عن ${num(p.limit)}`,
  'form/maxItems': (p) => `يجب ألا يزيد عدد العناصر عن ${num(p.limit)}`,
  'form/uniqueItems': 'يجب أن تكون العناصر فريدة',
  'form/minProperties': (p) => `يجب ألا يقل عدد الخصائص عن ${num(p.limit)}`,
  'form/maxProperties': (p) => `يجب ألا يزيد عدد الخصائص عن ${num(p.limit)}`,
  'x-form/assert': 'قيمة غير صالحة',
  'form/addItem': 'إضافة عنصر',
  'form/removeItem': 'إزالة عنصر',
  'form/jsonPlaceholder': 'أدخل قيمة JSON',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'لا توجد عملية تطابق طريقة الطلب ومساره',
  'contract/method-not-allowed': 'يُخدم هذا المسار بطرق أخرى: ⁨{allow}⁩',
  'contract/body-too-large': 'يتجاوز متن طلب العملية ⁨{op}⁩ حدّها البالغ {limit} بايت',
  'contract/unsupported-media': 'لا تقبل العملية ⁨{op}⁩ سوى متون ⁨{media}⁩',
  'contract/malformed-json': 'متن طلب العملية ⁨{op}⁩ ليس JSON صالحًا',
  'contract/malformed-body': 'متن طلب العملية ⁨{op}⁩ ليس نص UTF-8 صالحًا',
  'contract/invalid-input': 'مدخلات العملية ⁨{op}⁩ غير صالحة',
  'contract/idempotency-key-required': 'تتطلب العملية ⁨{op}⁩ ترويسة Idempotency-Key',
  'contract/handler-failed': 'فشلت العملية ⁨{op}⁩',
  'contract/idempotency-conflict': 'يتعارض Idempotency-Key الخاص بالعملية ⁨{op}⁩ مع طلب سابق (⁨{kind}⁩)',
  'contract/invalid-output': 'أنتجت العملية ⁨{op}⁩ استجابة تخالف عقدها',
  'contract/malformed-path': 'يحتوي مسار الطلب على تسلسل هروب نسبة مئوية مشوّه، أو على مقطع هو . أو ..',
  'contract/malformed-query': 'تعذر فك ترميز سلسلة الاستعلام',
  'contract/not-implemented': 'العملية ⁨{op}⁩ غير منفّذة على هذا الخادم',
  'contract/precondition-failed': 'أخفق الشرط المسبق If-Match للعملية ⁨{op}⁩',
  'contract/invalid-header': 'ترويسة ⁨{header}⁩ للعملية ⁨{op}⁩ غير صالحة',
  'contract/handler-error': 'فشلت العملية ⁨{op}⁩ بالخطأ ⁨{code}⁩',
  'contract/client-invalid-input': 'مدخلات العملية ⁨{op}⁩ غير صالحة؛ لم يُرسل أي شيء',
  'contract/network': 'لم يكتمل طلب ⁨{op}⁩ (⁨{name}⁩)',
  'contract/cancelled': 'أُلغي طلب العملية ⁨{op}⁩',
  'contract/invalid-response': 'استجابة العملية ⁨{op}⁩ تخالف عقدها',
  'contract/key-storage-failed': 'تعذر تخزين مفتاح تكرارية العملية ⁨{op}⁩؛ لم يُرسل أي شيء',
  'contract/undeclared-response': 'أجابت العملية ⁨{op}⁩ باستجابة غير معلنة (الحالة {status})',
  'contract/not-a-contract': 'لا يصف الخادم العقد ⁨{id}⁩ في مساره المعروف (well-known)',
  'contract/incompatible': 'يتحدث الخادم الإصدار ⁨{server}⁩ من العقد ⁨{id}⁩؛ ويتحدث هذا العميل ⁨{client}⁩، ولا يعلن أي طرف توافق الآخر',
  'contract/host-failed': 'فشلت العملية ⁨{op}⁩ في المضيف قبل إنتاج أي نتيجة',
  'contract/local-handler-failed': 'فشلت العملية ⁨{op}⁩ في المضيف المقدّم للخدمة',
  'contract/unknown-operation': 'لا يسمّي الطلب أي عملية مقدّمة على هذه القناة',
  'contract/port-timeout': 'لم تتلقَّ العملية ⁨{op}⁩ أي إجابة على القناة خلال {ms} مللي ثانية',
  'contract/malformed-frame': 'إطار استجابة العملية ⁨{op}⁩ مشوّه',
  'contract/channel-closed': 'قناة العملية ⁨{op}⁩ مغلقة',
  'contract/not-a-stream': 'أجاب الخادم على اشتراك العملية ⁨{op}⁩ باستجابة ليست دفقًا',
  'contract/invalid-snapshot': 'أنتجت العملية ⁨{op}⁩ لقطة تخالف عقدها',
  'contract/seq-regression': 'خالف دفق العملية ⁨{op}⁩ ترتيب seq الخاص به',
  'contract/stream-error': 'انتهى دفق العملية ⁨{op}⁩ بخطأ من الخادم (⁨{code}⁩)',
  'contract/heartbeat-missed': 'ظل دفق العملية ⁨{op}⁩ صامتًا لمدة {ms} مللي ثانية',
  'contract/slow-consumer': 'انتهى دفق العملية ⁨{op}⁩: تأخر المستهلك عن طابوره المحدود',
  'contract/reconnect-exhausted': 'تعذّر إعادة إنشاء دفق العملية ⁨{op}⁩ بعد {attempts} محاولات (الأخيرة: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // Arabic abbreviates neither month nor weekday names, so the wide and
  // short arrays hold the same strings - as CLDR has them.
  ...dateNameEntries({
    months: [
      'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
    ],
    monthsShort: [
      'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
    ],
    weekdays: [
      'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء',
      'الخميس', 'الجمعة', 'السبت',
    ],
    weekdaysShort: [
      'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت',
    ],
    meridiem: ['ص', 'م'],
  }),
  'date/relative/second/past': (p) => `قبل ${counted(p.value, { one: 'ثانية واحدة', two: 'ثانيتين', few: 'ثوانٍ', many: 'ثانيةً', other: 'ثانية' })}`,
  'date/relative/second/future': (p) => `خلال ${counted(p.value, { one: 'ثانية واحدة', two: 'ثانيتين', few: 'ثوانٍ', many: 'ثانيةً', other: 'ثانية' })}`,
  'date/relative/minute/past': (p) => `قبل ${counted(p.value, { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقةً', other: 'دقيقة' })}`,
  'date/relative/minute/future': (p) => `خلال ${counted(p.value, { one: 'دقيقة واحدة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقةً', other: 'دقيقة' })}`,
  'date/relative/hour/past': (p) => `قبل ${counted(p.value, { one: 'ساعة واحدة', two: 'ساعتين', few: 'ساعات', many: 'ساعةً', other: 'ساعة' })}`,
  'date/relative/hour/future': (p) => `خلال ${counted(p.value, { one: 'ساعة واحدة', two: 'ساعتين', few: 'ساعات', many: 'ساعةً', other: 'ساعة' })}`,
  'date/relative/day/past': (p) => `قبل ${counted(p.value, { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم' })}`,
  'date/relative/day/future': (p) => `خلال ${counted(p.value, { one: 'يوم واحد', two: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم' })}`,
  'date/relative/week/past': (p) => `قبل ${counted(p.value, { one: 'أسبوع واحد', two: 'أسبوعين', few: 'أسابيع', many: 'أسبوعًا', other: 'أسبوع' })}`,
  'date/relative/week/future': (p) => `خلال ${counted(p.value, { one: 'أسبوع واحد', two: 'أسبوعين', few: 'أسابيع', many: 'أسبوعًا', other: 'أسبوع' })}`,
  'date/relative/month/past': (p) => `قبل ${counted(p.value, { one: 'شهر واحد', two: 'شهرين', few: 'أشهر', many: 'شهرًا', other: 'شهر' })}`,
  'date/relative/month/future': (p) => `خلال ${counted(p.value, { one: 'شهر واحد', two: 'شهرين', few: 'أشهر', many: 'شهرًا', other: 'شهر' })}`,
  'date/relative/year/past': (p) => `قبل ${counted(p.value, { one: 'سنة واحدة', two: 'سنتين', few: 'سنوات', many: 'سنةً', other: 'سنة' })}`,
  'date/relative/year/future': (p) => `خلال ${counted(p.value, { one: 'سنة واحدة', two: 'سنتين', few: 'سنوات', many: 'سنةً', other: 'سنة' })}`,
  'date/relative/now': 'الآن',
  'date/relative/yesterday': 'أمس',
  'date/relative/today': 'اليوم',
  'date/relative/tomorrow': 'غدًا',
  'format/name/date': 'تاريخ',
  'format/name/time': 'وقت',
  'format/name/date-time': 'تاريخ ووقت',
  'format/name/iso-date': 'تاريخ ISO',
  'format/name/iso-time': 'وقت ISO',
  'format/name/iso-date-time': 'تاريخ ووقت ISO',
  //#endregion

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': 'تسلسل عدد عناصره {count}',
  'query/item/empty': 'التسلسل الفارغ',
  'query/item/null': 'null',
  'query/item/array': 'مصفوفة (array)',
  'query/item/object': 'كائن',
  'query/item/string': 'نص (string)',
  'query/item/number': 'رقم',
  'query/item/boolean': 'قيمة منطقية',
  'query/item/other': 'قيمة من نوع ⁨{type}⁩',
  'query/mixed-keys': 'لا يمكن للكائن أن يجمع بين مفاتيح مسبوقة بالرمز $ (⁨$-prefixed⁩) ومفاتيح عادية',
  'query/unknown-operator': "العامل ⁨'{key}'⁩ غير معروف",
  'query/unknown-operator-suggest': "العامل ⁨'{key}'⁩ غير معروف (هل تقصد ⁨'{suggestion}'⁩؟)",
  'query/unknown-operator-use': "العامل ⁨'{key}'⁩ غير معروف (استخدم ⁨{use}⁩)",
  'query/unknown-operator-none': "العامل ⁨'{key}'⁩ غير معروف (لا يوجد في ⁨jaren-query⁩ عامل يؤدي هذه الوظيفة)",
  'query/use/head-of-reverse': '⁨$head⁩ على نتيجة ⁨$reverse⁩',
  'query/use/jsonpath-filter': 'مرشح ⁨JSONPath⁩ مثل ⁨$[?(@.x > 1)]⁩ أو ⁨$where⁩ داخل ⁨$for⁩',
  'query/use/for-return': 'عبارة ⁨$for⁩ مع ⁨$return⁩',
  'query/use/for-phrase': 'عبارة ⁨$for⁩',
  'query/use/sort-objects': '⁨$sort⁩ (يفرز القيم البسيطة؛ أما الكائنات فرتّبها عبر ⁨$for⁩ على مفتاح مفروز)',
  'query/use/sort-scalars': '⁨$sort⁩ (للقيم البسيطة فقط)',
  'query/use/entries-get': '⁨$entries⁩ ثم ⁨$get⁩',
  'query/use/geo-parse-text': '⁨$geo-parse⁩ للقراءة و ⁨$geo-text⁩ للكتابة',
  'query/use/bbox-intersects': '⁨$bbox-intersects⁩ (للمستطيلات المحيطة فقط — التراكب الهندسي الحقيقي غير متاح عمدًا)',
  'query/use/renderer': 'طبقة عرض الخريطة — لا تستطيع لغة الاستعلام إنشاء إحداثيات مُسقطة أصلًا، لذا لا يمكن أن يُجرى عليها أي قياس؛ فالقياس هنا جيوديسي',
  'query/use/renderer-project': "طبقة عرض الخريطة، كما هو الحال مع ⁨'$project'⁩",
  'query/use/similarity': '⁨$similarity⁩ (القيمة الأعلى تعني الأقرب؛ ولا يوجد مقياس للمسافة)',
  'query/use/knn-desc': "⁨$orderby⁩ على مفتاح ⁨$similarity⁩ مع ⁨$dir⁩ ⁨'desc'⁩، ثم ⁨$subsequence⁩ لاختيار أقرب k من الجيران",
  'query/use/knn': '⁨$orderby⁩ على مفتاح ⁨$similarity⁩، ثم ⁨$subsequence⁩',
  'query/use/top-k': '⁨$orderby⁩ ثم ⁨$subsequence⁩',
  'query/use/resample-fill': "⁨$resample⁩ مع الخاصية ⁨'fill'⁩",
  'query/use/resample-locf': "⁨$resample⁩ مع طريقة التعبئة ⁨'locf'⁩",
  'query/use/resample-linear': "⁨$resample⁩ مع طريقة التعبئة ⁨'linear'⁩",
  'query/use/rolling-mean': "⁨$rolling⁩ مع دالة التجميع ⁨'mean'⁩",
  'query/phrase-keys': 'تركيبة مفاتيح عبارة غير صالحة (⁨{keys}⁩)',
  'query/phrase-alone': "لا يمكن أن يشكّل ⁨'{key}'⁩ عبارة بمفرده",
  'query/operands-array': "يأخذ ⁨'{op}'⁩ مصفوفة من التعابير",
  'query/operands-exactly': "يجب أن يكون عدد معاملات ⁨'{op}'⁩ {min} بالضبط، لكن عددها {count}",
  'query/operands-at-least': "يجب ألا يقل عدد معاملات ⁨'{op}'⁩ عن {min}، لكن عددها {count}",
  'query/operands-range': "يجب أن يكون عدد معاملات ⁨'{op}'⁩ من {min} إلى {max}، لكن عددها {count}",
  'query/variable-name-expected': 'كان المتوقع نصًا يمثل اسم متغير',
  'query/variable-name-invalid': "ليس ⁨'{name}'⁩ اسم متغير صالحًا",
  'query/variable-duplicate': "ربط مكرر للمتغير ⁨'{name}'⁩ داخل عبارة واحدة",
  'query/bindings-object': "يأخذ ⁨'{clause}'⁩ كائنًا من روابط المتغيرات",
  'query/bindings-empty': "يتطلب ⁨'{clause}'⁩ ربطًا واحدًا على الأقل",
  'query/extended-let': "صيغة الربط الموسّعة غير متاحة في ⁨'$let'⁩",
  'query/extended-quantifier': 'صيغة الربط الموسّعة غير متاحة في المُكمِّمات',
  'query/window-kind': "يجب أن تكون قيمة ⁨'$window'⁩ إما ⁨'tumbling'⁩ أو ⁨'sliding'⁩",
  'query/window-size-required': "يتطلب ربط ⁨'$window'⁩ وجود ⁨'$size'⁩",
  'query/window-size': "يجب أن تكون قيمة ⁨'$size'⁩ عددًا صحيحًا موجبًا",
  'query/window-step': "يجب أن تكون قيمة ⁨'$step'⁩ عددًا صحيحًا موجبًا",
  'query/window-required': "يتطلب ⁨'$size'⁩/⁨'$step'⁩ وجود ⁨'$window'⁩",
  'query/for-key': "ليس ⁨'{key}'⁩ مفتاحًا صالحًا لربط ⁨'$for'⁩ الموسّع",
  'query/for-in-required': "يتطلب ربط ⁨'$for'⁩ الموسّع وجود ⁨'$in'⁩",
  'query/for-at': "يأخذ ⁨'$at'⁩ نصًا يمثل اسم متغير",
  'query/for-allowing-empty': "يأخذ ⁨'$allowing-empty'⁩ قيمة منطقية",
  'query/orderby-spec': "يأخذ ⁨'$orderby'⁩ مواصفة مفتاح أو مصفوفة غير فارغة من مواصفات المفاتيح",
  'query/orderby-spec-key': "ليس ⁨'{key}'⁩ مفتاحًا صالحًا في مواصفة مفتاح ⁨$orderby⁩",
  'query/orderby-spec-key-required': "تتطلب مواصفة مفتاح ⁨$orderby⁩ الصريحة وجود ⁨'$key'⁩",
  'query/orderby-dir': "يجب أن تكون قيمة ⁨'$dir'⁩ إما ⁨'asc'⁩ أو ⁨'desc'⁩",
  'query/orderby-empty': "يجب أن تكون قيمة ⁨'$empty'⁩ إما ⁨'least'⁩ أو ⁨'greatest'⁩",
  'query/collation-name': "يجب أن تكون قيمة ⁨'$collation'⁩ اسم قاعدة ترتيب مسجّلة",
  'query/collation-unregistered': "يشير ⁨'$collation'⁩ إلى قاعدة ترتيب غير مسجّلة ⁨'{name}'⁩",
  'query/fold-binding': "يأخذ ⁨'$fold'⁩ ربطًا واحدًا بالضبط للمُجمِّع",
  'query/as-object': "يأخذ ⁨'$as'⁩ كائنًا تربط خصائصه أسماء المتغيرات بالمخططات",
  'query/as-empty': "يتطلب ⁨'$as'⁩ خاصية واحدة على الأقل",
  'query/as-unbound': "يشير ⁨'$as'⁩ إلى المتغير ⁨'{name}'⁩، وهو غير مربوط في ⁨'$for'⁩/⁨'$let'⁩ ضمن هذه العبارة",
  'query/count-variable': "يأخذ ⁨'$count'⁩ نصًا يمثل اسم متغير",
  'query/map-entry': 'يجب أن يكون مُدخل ⁨$map⁩ مصفوفة من تعبيرين بالضبط',
  'query/call-arguments': "يتطلب ⁨'$call'⁩ الصيغة [⁨'name'⁩, ...تعابير الوسيطات]",
  'query/call-unregistered': "يشير ⁨'$call'⁩ إلى دالة غير مسجّلة ⁨'{name}'⁩",
  'query/apply-arguments': "يأخذ ⁨'$apply'⁩ الصيغة [محدِّد] أو [محدِّد، وضع]",
  'query/apply-mode': "يجب أن يكون وضع ⁨'$apply'⁩ نصًا حرفيًا",
  'query/document-value': 'لا يمكن أن يحتوي مستند الاستعلام على قيمة من نوع ⁨{type}⁩',
  'query/invalid-path': "ليس ⁨'{path}'⁩ مسارًا صالحًا ولا تسلسل هروب صالحًا",
  'query/invalid-path-detail': "ليس ⁨'{path}'⁩ مسارًا صالحًا: ⁨{detail}⁩",
  'query/unbound-variable': "المتغير ⁨'${name}'⁩ غير مربوط بعبارة محيطة وليس معلمة خارجية معلنة (المعلمات الخارجية المعلنة: ⁨{declared}⁩)",
  'query/unbound-variable-closed': "المتغير ⁨'${name}'⁩ غير مربوط بعبارة محيطة وليس معلمة خارجية معلنة (صُرِّف هذا الاستعلام بافتراض العالم المغلق، فلا يعلن أي معلمات خارجية)",
  'query/version-unknown': 'إصدار تنسيق الاستعلام ⁨{version}⁩ غير معروف',
  'query/version-envelope': "يتطلب مغلّف الإصدار المفتاحين ⁨'$query'⁩ و ⁨'$expr'⁩ دون غيرهما",
  'query/schema-no-compiler': 'تتطلب عوامل المخطط مُصرِّف اختبارات نوع (⁨options.compileTypeTest⁩)',
  'query/schema-invalid': 'قيمة مخطط حرفية غير صالحة: ⁨{detail}⁩',
  'query/schema-no-predicate': 'لم يُرجع مُصرِّف اختبارات النوع دالة شرطية',
  'query/depth-limit': 'يتجاوز عمق تداخل التعابير في الاستعلام ({depth}) قيمة ⁨limits.depth⁩ ({limit})',
  'query/spec-member-required': "يتطلب ⁨'{name}'⁩ الخاصية ⁨'{member}'⁩ في مواصفاته",
  'query/spec-invalid': "مواصفات ⁨'{name}'⁩: ⁨{detail}⁩",
  'query/date-pattern': "نمط ⁨'$date-format'⁩: ⁨{detail}⁩",
  'query/time-bucket-invalid': "العامل ⁨'$time-bucket'⁩: ⁨{detail}⁩",
  'query/lexical-arguments': 'يتطلب ⁨$lexical⁩ الصيغة [موفّر، تعبير نصي، طلب حرفي]',
  'query/lexical-unregistered': "الموفّر المعجمي ⁨'{name}'⁩ غير مسجّل",
  'query/lexical-rejected': 'رفض الموفّر المعجمي الطلب',
  'query/lexical-no-request': 'لم يُصرِّف الموفّر المعجمي أي طلب',
  'query/series-spec-object': "يأخذ ⁨'{operator}'⁩ كائن مواصفات حرفيًا، لكن تم الحصول على ⁨{got}⁩",
  'query/series-spec-member': "لا توجد في مواصفات ⁨'{operator}'⁩ خاصية باسم ⁨'{name}'⁩؛ الخصائص المقبولة: ⁨{allowed}⁩",
  'query/series-spec-member-suggest': "لا توجد في مواصفات ⁨'{operator}'⁩ خاصية باسم ⁨'{name}'⁩ (هل تقصد ⁨'{suggestion}'⁩؟)؛ الخصائص المقبولة: ⁨{allowed}⁩",
  'query/series-member-enum': "القيم المقبولة للخاصية ⁨'{member}'⁩: ⁨{allowed}⁩؛ لكن تم الحصول على ⁨{got}⁩",
  'query/series-member-number': "يجب أن تكون الخاصية ⁨'{member}'⁩ عددًا منتهيًا، لكن تم الحصول على ⁨{got}⁩",
  'query/series-member-instant': "يجب أن تكون الخاصية ⁨'{member}'⁩ قيمة بالمللي ثانية منذ بداية الحقبة أو نصًا بصيغة ⁨RFC 3339⁩، لكن تم الحصول على ⁨{got}⁩",
  'query/series-member-duration': "يجب أن تكون الخاصية ⁨'{member}'⁩ نص مدة أو عددًا من المللي ثانية، لكن تم الحصول على ⁨{got}⁩",
  'query/series-member-path': "يجب أن تكون الخاصية ⁨'{member}'⁩ مسارًا مفردًا داخل الصف، لكن تم الحصول على ⁨{got}⁩",
  'query/series-member-path-detail': "الخاصية ⁨'{member}'⁩: ⁨{detail}⁩",
  'query/series-member-not-path': "الخاصية ⁨'{member}'⁩ ليست مسارًا",
  'query/series-member-whole-row': "تحدد الخاصية ⁨'{member}'⁩ الصف بأكمله بدلًا من إحدى خصائصه",
  'query/series-member-singular': "يجب أن تكون الخاصية ⁨'{member}'⁩ مسارًا مفردًا — اسم أو فهرس واحد لكل مقطع، دون حرف بدل أو أحفاد أو مرشح",
  'query/series-zone': "يجب أن تكون الخاصية ⁨'zone'⁩ اسم منطقة زمنية من ⁨IANA⁩، لكن تم الحصول على ⁨{got}⁩",
  'query/series-zone-provider': "تحتاج المنطقة الزمنية ⁨'{zone}'⁩ إلى موفّر مناطق زمنية: لا تتضمن هذه المجموعة ⁨tzdb⁩، لذا تُصرَّف المنطقة المسمّاة باستخدام ⁨options.zoneProvider⁩ (⁨toParts / toEpoch⁩). لا يحتاج ⁨'UTC'⁩ ولا ⁨'offset'⁩ الرقمي إلى موفّر",
  'query/series-calendar': 'سياق التقويم: ⁨{detail}⁩',
  'query/expected-string': 'كان المتوقع نصًا، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-number': 'كان المتوقع رقمًا، لكن تم الحصول على ⁨{got}⁩',
  'query/cast-string': 'تعذر تحويل ⁨{got}⁩ إلى نص',
  'query/cast-number': 'تعذر تحويل ⁨{got}⁩ إلى رقم',
  'query/not-json-number': "ليس ⁨'{value}'⁩ رقمًا بصيغة ⁨JSON⁩",
  'query/arithmetic-operand': 'تتطلب العمليات الحسابية معاملًا رقميًا، لكن تم الحصول على ⁨{got}⁩',
  'query/aggregate-not-number': 'يجب أن تكون عناصر التجميع أرقامًا، لكن تم الحصول على ⁨{got}⁩',
  'query/aggregate-null': 'تتطلب دالة التجميع أرقامًا أو نصوصًا، لكن تم الحصول على null',
  'query/minmax-mixed': "يجب أن تكون عناصر ⁨'$min'⁩/⁨'$max'⁩ كلها أرقامًا أو كلها نصوصًا، لكن تم الحصول على ⁨{got}⁩",
  'query/sort-mixed': "يجب أن تكون عناصر ⁨'$sort'⁩ كلها أرقامًا أو كلها نصوصًا، لكن تم الحصول على ⁨{got}⁩",
  'query/regex-invalid': "ليس ⁨'{pattern}'⁩ نمط ⁨I-Regexp⁩ صالحًا",
  'query/replace-empty-match': "يطابق النمط ⁨'{pattern}'⁩ في ⁨'$replace'⁩ النص ذا الطول الصفري",
  'query/range-bounds': "يجب أن تكون حدود ⁨'$range'⁩ أعدادًا صحيحة آمنة، لكن تم الحصول على ⁨{got}⁩",
  'query/range-guard': "يتجاوز عدد عناصر ⁨'$range'⁩ ({count}) حد حماية الموارد البالغ {limit}",
  'query/index-of-item': "يأخذ ⁨'$index-of'⁩ عنصر بحث واحدًا، لكن تم الحصول على ⁨{got}⁩",
  'query/expected-datetime': 'كان المتوقع نص تاريخ أو وقت أو تاريخ ووقت بصيغة ⁨RFC 3339⁩، لكن تم الحصول على ⁨{got}⁩',
  'query/no-date-component': "لا يحمل ⁨'{value}'⁩ أي مكوّن تاريخ",
  'query/no-time-component': "لا يحمل ⁨'{value}'⁩ أي مكوّن وقت",
  'query/calendar-unit': "كان المتوقع وحدة تقويم (⁨'year'⁩, ⁨'month'⁩, ⁨'day'⁩, ...)، لكن تم الحصول على ⁨{got}⁩",
  'query/expected-duration': 'كان المتوقع مدة بصيغة ⁨ISO 8601⁩، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-units': 'كان المتوقع عددًا من الوحدات، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-date-pattern': 'كان المتوقع نمط تاريخ، لكن تم الحصول على ⁨{got}⁩',
  'query/datetime-epoch': "يأخذ ⁨'$datetime'⁩ قيمة بالمللي ثانية منذ بداية الحقبة، لكن تم الحصول على ⁨{got}⁩",
  'query/datetime-range': 'القيمة ⁨{value}⁩ خارج النطاق الذي يمكن تمثيله بصيغة ⁨RFC 3339⁩',
  'query/span-no-date': 'تعذر قياس فترة انطلاقًا من قيمة لا تحمل تاريخًا',
  'query/expected-bucket-width': 'كان المتوقع عرض فاصل تجميع، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-geo': 'كان المتوقع قيمة ⁨GeoJSON⁩ أو موضعًا [خط الطول، خط العرض]، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-wkt': 'كان المتوقع نص ⁨Well-Known Text⁩، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-geohash': 'كان المتوقع نص خلية geohash، لكن تم الحصول على ⁨{got}⁩',
  'query/geohash-precision': 'يجب أن تكون دقة geohash عددًا صحيحًا من 1 إلى 12، لكن تم الحصول على ⁨{got}⁩',
  'query/simplify-tolerance': 'يجب أن تكون سماحية التبسيط عددًا غير سالب من الدرجات، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-vector': 'كان المتوقع متجهًا (مصفوفة أرقام)، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-vector-item': 'كان المتوقع متجهًا (مصفوفة أرقام)، لكن تم الحصول على ⁨{got}⁩ عند الفهرس {index}',
  'query/expected-series': 'كان المتوقع سلسلة زمنية (سجلات تحمل لحظة زمنية وقراءة)، لكن تم الحصول على ⁨{got}⁩',
  'query/expected-interval': 'كان المتوقع سجل فاصل زمني {{ start, end }، لكن تم الحصول على ⁨{got}⁩',
  'query/member-cardinality': "أنتجت الخاصية ⁨'{name}'⁩ تسلسلًا عدد عناصره {count}؛ وتأخذ خاصية الكائن عنصرًا واحدًا بالضبط",
  'query/groupby-key': 'يجب أن يكون مفتاح ⁨$groupby⁩ التسلسل الفارغ أو عنصرًا واحدًا، لكن تم الحصول على ⁨{got}⁩',
  'query/lexical-text': 'يجب أن يكون النص المعجمي قيمة نصية واحدة',
  'query/idiv-zero': "قسمة على صفر في ⁨'$idiv'⁩",
  'query/mod-zero': "قسمة على صفر في ⁨'$mod'⁩",
  'query/ebv-sequence': 'القيمة المنطقية الفعلية لتسلسل من عنصرين أو أكثر غير معرّفة',
  'query/map-key': 'يجب أن يُقيَّم مفتاح ⁨$map⁩ إلى نص واحد، لكن تم الحصول على ⁨{got}⁩',
  'query/orderby-key': 'يجب أن يكون مفتاح ⁨$orderby⁩ التسلسل الفارغ أو رقمًا أو نصًا، لكن تم الحصول على ⁨{got}⁩',
  'query/orderby-number-string': 'تعذر مقارنة رقم بنص في ⁨$orderby⁩',
  'query/orderby-string-number': 'تعذر مقارنة نص برقم في ⁨$orderby⁩',
  'query/external-unbound': "لم تُربط المعلمة الخارجية ⁨'{name}'⁩",
  'query/assert-failed': "فشل ⁨'$assert'⁩ لعدم مطابقة ⁨{got}⁩ للمخطط",
  'query/assert-failed-item': "فشل ⁨'$assert'⁩ لعدم مطابقة العنصر {index}، وهو ⁨{got}⁩، للمخطط",
  'query/as-failed': "لم يجتز المتغير ⁨'{name}'⁩ مخطط ⁨'$as'⁩ الخاص به لعدم مطابقة ⁨{got}⁩ له",
  'query/as-failed-item': "لم يجتز المتغير ⁨'{name}'⁩ مخطط ⁨'$as'⁩ الخاص به لعدم مطابقة العنصر {index}، وهو ⁨{got}⁩، له",
  'query/fold-limit': 'تجاوز عدد عناصر مُجمِّع الطي {limit} (⁨limits.sequenceItems⁩)',
  'query/phrase-limit': 'تجاوز عدد العناصر التي جسّدتها عبارة {limit} (⁨limits.sequenceItems⁩)',
  'query/steps-limit': 'تجاوز الاستعلام ⁨limits.steps⁩ ({limit} عملية تقييم للتعابير)',
  'query/result-limit': 'يتجاوز عدد عناصر نتيجة الاستعلام ({count}) قيمة ⁨limits.resultItems⁩ ({limit})',
  'query/function-threw': "طرحت الدالة المسجّلة ⁨'{name}'⁩ استثناءً: ⁨{detail}⁩",
  'query/operator-threw': "فشل العامل المسجّل ⁨'{name}'⁩: ⁨{detail}⁩",
  'query/input-undefined': 'قيمة مستند الإدخال undefined، وهي ليست قيمة ⁨JSON⁩',
  'query/lexical-threw': 'طرح الموفّر المعجمي استثناءً',
  'query/lexical-result': 'أرجع الموفّر المعجمي نتيجة غير صالحة أو غير مكتملة',
  //#endregion
};
