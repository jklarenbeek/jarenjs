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
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn` — the
 * contract entries wrap their Latin protocol values (operation ids,
 * media types, error codes) in first-strong isolates (U+2068 FSI …
 * U+2069 PDI) so a Latin run cannot reorder the RTL sentence around it.
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
  'contract/invalid-input': 'مدخلات العملية ⁨{op}⁩ غير صالحة',
  'contract/idempotency-key-required': 'تتطلب العملية ⁨{op}⁩ ترويسة Idempotency-Key',
  'contract/handler-failed': 'فشلت العملية ⁨{op}⁩',
  'contract/idempotency-conflict': 'يتعارض Idempotency-Key الخاص بالعملية ⁨{op}⁩ مع طلب سابق (⁨{kind}⁩)',
  'contract/invalid-output': 'أنتجت العملية ⁨{op}⁩ استجابة تخالف عقدها',
  'contract/malformed-path': 'يحتوي مسار الطلب على تسلسل هروب نسبة مئوية مشوّه',
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
};
