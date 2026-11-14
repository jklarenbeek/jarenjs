//@ts-check
/**
 * The website's own words in Arabic (العربية): the ids of `siteMessagesEn`
 * (../messages.js). Loaded on demand, when a reader picks the language;
 * a published package's words travel in `@jarenjs/locales` instead.
 */

/** @type {Readonly<Record<string, string>>} */
export default Object.freeze({
  'site/lang/label': 'اللغة',
  'site/play/downloaded': 'تم تنزيل الجلسة',
  'site/play/download-unavailable': 'التنزيل غير متاح هنا',
  'site/play/open-unavailable': 'فتح ملف غير متاح هنا',
  'site/play/not-a-session': 'ليس {name} جلسة Play',
  'site/play/not-a-session-unnamed': 'هذا الملف ليس جلسة Play',
  'site/play/imported': 'تم استيراد {name}',
  'site/play/imported-unnamed': 'تم استيراد جلسة',
  'site/play/unreadable': 'تعذرت قراءة هذا الملف',
  'site/play/too-large': 'كبير جدًا على رابط مشاركة (عدد الأحرف {length}، والحد الأقصى {limit}) — استخدم "تنزيل" بدلًا من ذلك',
  'site/play/link-ready': 'الرابط جاهز',
  'site/play/link-copied': 'تم نسخ الرابط',
  'site/schema/invalid-json': 'JSON غير صالح: {reason}',
});
