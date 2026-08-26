//@ts-check

/**
 * @jarenjs/locales - locale packs (message catalogs) for the error
 * messages of @jarenjs/validate and @jarenjs/forms.
 *
 * Each pack is a plain flat object of message-key -> closure/template
 * entries (the catalog contract of
 * packages/validate/docs/ERROR-MESSAGES.md); compile them with
 * `compileMessageCatalog` from the consuming package. A pack holds its
 * own translations and `Intl` singletons, and imports nothing but the
 * rendering helpers of `./helpers.js` - never a consumer package, so
 * either consumer can serve any pack.
 *
 * Beside the error messages, every pack carries the calendar language
 * `@jarenjs/core/dates` refuses to invent: month, weekday and meridiem
 * names, relative-time phrases and date-format display names.
 * `compileDateLocale` (`./dates`) turns a pack into the frozen record a
 * formatter and a UI read; importing that subpath directly costs no
 * `Intl` construction at all, which is what keeps server-rendered output
 * byte-stable. `createIntlDateLocale` (`./intl-dates`) is the opt-in
 * provider for hosts that want the platform's locales instead.
 */

export { dateMessagesEn, compileDateLocale, RELATIVE_UNITS } from './dates.js';
export { createIntlDateLocale } from './intl-dates.js';

export { ar } from './ar.js';
export { de } from './de.js';
export { es } from './es.js';
export { fr } from './fr.js';
export { ja } from './ja.js';
export { ko } from './ko.js';
export { nl } from './nl.js';
export { pt } from './pt.js';
export { ru } from './ru.js';
export { tr } from './tr.js';
export { zhTW } from './zh-tw.js';
