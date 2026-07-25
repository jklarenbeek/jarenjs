//@ts-check

/**
 * Forms message catalogs: structured field errors, rendered late.
 *
 * Every failure a form check produces is identified by a stable message
 * key (`msgid`, the `form/`-prefixed keyword or `x-form/assert`) plus raw
 * structured `params`; the human text comes from a catalog - a plain flat
 * object of closures (or template strings that compile into closures).
 * Forms keeps its second-person field voice ("This field is required"),
 * hence the separate `form/*` key space next to the validator's document
 * voice ("must have required property 'x'").
 *
 * Forms and the validator must serve one locale pack
 * (`@jarenjs/locales`) each from its own key space, without either
 * package depending on the other - so the catalog contract they share
 * (template syntax, compilation, value rendering) is kernel property in
 * `@jarenjs/core/message`. Both compilers are re-exported here so a form
 * consumer never has to reach past `@jarenjs/forms`.
 */

import {
  formatMessageValue,
  compileMessageCatalog,
} from '@jarenjs/core/message';

export {
  compileMessageTemplate,
  compileMessageCatalog,
} from '@jarenjs/core/message';

//#region English catalog

/**
 * The built-in English forms catalog. Key set = exactly the `form/*` keys
 * `validateField` emits, plus `x-form/assert` (the rules default). The
 * strings are byte-identical to the historical inline template literals.
 * @type {Record<string, string | ((params: object, error?: object) => string)>}
 */
export const formsMessagesEn = {
  'form/required': 'This field is required',
  'form/type': (p) => `Must be ${(p.type === 'integer' || p.type === 'array' || p.type === 'object') ? 'an' : 'a'} ${p.type}`,
  'form/const': (p) => `Must be ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Must be one of: ${p.enumValues?.map(formatMessageValue).join(', ')}`,
  'form/minLength': (p) => `Must be at least ${p.limit} character${p.limit === 1 ? '' : 's'} (currently ${p.len})`,
  'form/maxLength': (p) => `Must be at most ${p.limit} character${p.limit === 1 ? '' : 's'} (currently ${p.len})`,
  'form/pattern': 'Must match pattern {pattern}',
  'form/format': 'Must be a valid {format}',
  'form/minimum': 'Must be at least {limit}',
  'form/maximum': 'Must be at most {limit}',
  'form/exclusiveMinimum': 'Must be greater than {limit}',
  'form/exclusiveMaximum': 'Must be less than {limit}',
  'form/multipleOf': 'Must be a multiple of {multipleOf}',
  'form/minItems': (p) => `Must have at least ${p.limit} item${p.limit === 1 ? '' : 's'}`,
  'form/maxItems': (p) => `Must have at most ${p.limit} item${p.limit === 1 ? '' : 's'}`,
  'form/uniqueItems': 'Items must be unique',
  'form/minProperties': 'Must have at least {limit} properties',
  'form/maxProperties': 'Must have at most {limit} properties',
  'x-form/assert': 'Invalid value',
};

/** The compiled built-in English catalog (module-level singleton). */
export const formsMessages = compileMessageCatalog(formsMessagesEn);

/**
 * Resolve a message key through a caller catalog with built-in English
 * fallback and render it.
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - A compiled catalog, or undefined for English
 * @param {string} msgid - The message key
 * @param {object} params - The structured params
 * @returns {string} The rendered message
 */
export function renderFormsMessage(catalog, msgid, params) {
  let render = catalog !== undefined ? catalog[msgid] : undefined;
  if (render === undefined) render = formsMessages[msgid];
  if (render === undefined) return msgid;
  return render(params);
}

//#endregion
