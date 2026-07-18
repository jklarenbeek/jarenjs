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

export { nl } from './nl.js';
