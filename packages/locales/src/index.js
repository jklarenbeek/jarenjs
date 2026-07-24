//@ts-check

/**
 * @jarenjs/locales - locale packs (message catalogs) for the error
 * messages of @jarenjs/validate and @jarenjs/forms.
 *
 * Each pack is a plain flat object of message-key -> closure/template
 * entries (the catalog contract of
 * packages/validate/docs/ERROR-MESSAGES.md). Packs are zero-dependency;
 * compile them with `compileMessageCatalog` from the consuming package.
 */

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
