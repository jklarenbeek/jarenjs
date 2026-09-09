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
  // Form CHROME, not validation: the accessible names of the array
  // buttons. A symbol-only button ('+', '×') is unreadable to a screen
  // reader and untranslatable as a glyph, so the name travels as a
  // message like every other string an operator can hear.
  'form/addItem': 'Add item',
  'form/removeItem': 'Remove item',
  'form/jsonPlaceholder': 'Enter a JSON value',
};

/** The compiled built-in English catalog (module-level singleton). */
export const formsMessages = compileMessageCatalog(formsMessagesEn);

/** Shared empty params for the entries that interpolate nothing. */
const NO_PARAMS = Object.freeze({});

/**
 * The display name of a format, as the catalog in hand spells it.
 *
 * A format's name is its wire name - `date-time`, `iso-time` - which is
 * English by construction and reads as gibberish inside a translated
 * sentence ("Moet een geldige date-time zijn"). A catalog that carries
 * `format/name/<format>` says how that format is called in its own
 * language; the date catalog of `@jarenjs/locales` carries the six date
 * and time ones. A format the catalog has no name for keeps its own,
 * which is the readable answer for the format names that are already
 * words ("email", "hostname") and the only possible one for a format
 * this repository has never heard of.
 *
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - A compiled catalog, or undefined for English
 * @param {string} format - The format name
 * @returns {string} The display name, or the format name itself
 * @example
 * formatDisplayName(dutch, 'date-time'); // 'datum en tijd'
 * formatDisplayName(dutch, 'email');     // 'email'
 */
export function formatDisplayName(catalog, format) {
  if (typeof format !== 'string' || catalog === undefined) return format;
  const render = catalog[`format/name/${format}`];
  if (render === undefined) return format;
  const name = render(NO_PARAMS);
  return typeof name === 'string' && name !== '' ? name : format;
}

/**
 * Resolve a message key through a caller catalog with built-in English
 * fallback and render it.
 *
 * A format failure is the one message whose params are prepared here
 * rather than at the call site: the error's own `params.format` stays
 * the raw wire name, so re-rendering the same error through a second
 * catalog answers in that catalog's language instead of repeating the
 * first one's noun.
 *
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - A compiled catalog, or undefined for English
 * @param {string} msgid - The message key
 * @param {object} params - The structured params
 * @returns {string} The rendered message
 */
export function renderFormsMessage(catalog, msgid, params) {
  let render = catalog !== undefined ? catalog[msgid] : undefined;
  if (render === undefined) render = formsMessages[msgid];
  if (render === undefined) return msgid;
  if (msgid === 'form/format') {
    const format = formatDisplayName(catalog, /** @type {any} */ (params).format);
    return render({ ...params, format });
  }
  return render(params);
}

/**
 * The localized chrome strings a form renderer needs: the accessible
 * names of the array add/remove buttons and the JSON editor's hint.
 *
 * The stylesheet that renders a form is plain JSON built once, so it
 * cannot look anything up at render time — the host resolves these and
 * hands them to `createFormView`. Kept next to the error catalog on
 * purpose: one keyspace, one parity gate across every locale pack.
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - A compiled catalog, or undefined for English
 * @returns {{addItem: string, removeItem: string, jsonPlaceholder: string}}
 * @example
 * createFormView({ labels: formChromeLabels(catalogs[locale]) });
 */
export function formChromeLabels(catalog = undefined) {
  return {
    addItem: renderFormsMessage(catalog, 'form/addItem', {}),
    removeItem: renderFormsMessage(catalog, 'form/removeItem', {}),
    jsonPlaceholder: renderFormsMessage(catalog, 'form/jsonPlaceholder', {}),
  };
}

//#endregion
