//@ts-check
/**
 * The validator boundary: the one place the playground touches
 * compiled artifacts. Everything returned is plain JSON, fit for the
 * app state; compiled validators and form models live in module-local
 * memo caches keyed by schema text.
 */

import { JarenValidator, localizeErrors as localizeValidationErrors, compileMessageCatalog } from '@jarenjs/validate';
import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel, formChromeLabels } from '@jarenjs/forms';
import { LOCALE_NAMES } from '@jarenjs/locales/names';

import { now } from '../lib/format.js';

/** Friendly draft name from a schema's $schema declaration. */
export function detectDraftName(schema) {
  const url = (schema !== null && typeof schema === 'object' && schema.$schema) || '';
  if (url.includes('2020-12')) return '2020-12';
  if (url.includes('2019-09')) return '2019-09';
  if (url.includes('draft-07')) return 'draft-07';
  if (url.includes('draft-06')) return 'draft-06';
  return 'draft-07 (default)';
}

/**
 * @param {any[]} schemas referenced documents, registered so the compiled
 *   schema can `$ref` them by `$id`
 */
function createInstance(schemas) {
  // a fresh validator per compile keeps schema registrations from
  // colliding between edits
  const instance = new JarenValidator({ skipErrors: false, collectErrors: true, formatAssertion: true })
    .addFormats(stringFormats)
    .addFormats(numberFormats)
    .addFormats(dateTimeFormats)
    .addFormats(jsonFormats);
  for (const schema of schemas) instance.addSchema(schema);
  return instance;
}

/**
 * The referenced-schemas pane's text as the list the form registers: the
 * array's members that are objects with a non-empty string `$id`, or none
 * when the pane is empty or unreadable (the run reports that pane's fault;
 * the form just goes without).
 * @param {unknown} text
 * @returns {any[]}
 */
export function referencedSchemas(text) {
  let parsed;
  try { parsed = JSON.parse(typeof text === 'string' && text.trim() !== '' ? text : '[]'); }
  catch { return []; }
  return Array.isArray(parsed)
    ? parsed.filter((doc) => doc !== null && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.$id === 'string' && doc.$id !== '')
    : [];
}

/** The `$id` a `$ref` names: the reference without an empty trailing fragment. */
const bareId = (id) => (id.endsWith('#') ? id.slice(0, -1) : id);

/**
 * The schema with every `$ref` that names a referenced document replaced by
 * that document, for the form generator (which reads the schema tree and
 * resolves no reference). A reference that would enter a document already
 * being inlined (a cycle) is left as it is.
 * @param {any} node
 * @param {Map<string, any>} byId referenced documents by bare `$id`
 * @param {Set<string>} open the `$id`s being inlined on this path
 * @returns {any}
 */
function inlineReferences(node, byId, open) {
  if (Array.isArray(node)) return node.map((item) => inlineReferences(item, byId, open));
  if (node === null || typeof node !== 'object') return node;
  const target = typeof node.$ref === 'string' ? bareId(node.$ref) : undefined;
  if (target !== undefined && byId.has(target) && !open.has(target)) {
    const { $ref: _reference, ...siblings } = node;
    const { $id: _name, $schema: _draft, ...document } = byId.get(target);
    const nested = new Set(open).add(target);
    return { ...inlineReferences(document, byId, nested), ...inlineReferences(siblings, byId, nested) };
  }
  /** @type {any} */
  const copy = {};
  for (const [key, value] of Object.entries(node)) copy[key] = inlineReferences(value, byId, open);
  return copy;
}

/**
 * The compiled state of ONE (schema text, referenced documents) pair, kept
 * hot: the run, the generated form and the studio all compile through
 * {@link compiled}, so the same pair never compiles twice in a row.
 * @type {{ schemaText: string, listKey: string, entry: any } | null}
 */
let hot = null;

/**
 * The cached compile of `schemaText` with `schemas` registered. The
 * referenced documents are part of what was compiled, so editing only one
 * of them must not answer from the previous compile; a pair compares on
 * both parts, never on a joined key.
 * @param {string} schemaText
 * @param {any[]} [schemas]
 */
function compiled(schemaText, schemas = []) {
  const listKey = JSON.stringify(schemas);
  if (hot !== null && hot.schemaText === schemaText && hot.listKey === listKey) return hot.entry;
  const entry = { validate: null, formModel: null, schemaError: null, schemaJsonReason: null, schemaPane: null, compileMs: null, draft: null };
  let schema;
  try {
    schema = JSON.parse(schemaText);
  }
  catch (err) {
    entry.schemaJsonReason = /** @type {Error} */ (err).message;
    entry.schemaError = `Invalid JSON: ${entry.schemaJsonReason}`;
  }
  if (entry.schemaError === null) {
    entry.draft = detectDraftName(schema);
    try {
      const instance = createInstance(schemas);
      // a referenced document compiles lazily when a reference reaches it:
      // compile each one now so a broken document is reported with its
      // position, whether or not the main schema uses it
      for (let i = 0; i < schemas.length; i++) {
        try { instance.compile(schemas[i]); }
        catch (err) {
          entry.schemaPane = 'schemas';
          throw new Error(`schemas[${i}] (${schemas[i].$id}): ${/** @type {Error} */ (err).message}`, { cause: err });
        }
      }
      const start = now();
      entry.validate = instance.compile(schema);
      entry.compileMs = now() - start;
    }
    catch (err) {
      entry.schemaError = /** @type {Error} */ (err).message;
    }
    try {
      const byId = new Map(schemas.map((doc) => [bareId(doc.$id), doc]));
      entry.formModel = buildFormModel(byId.size === 0 ? schema : inlineReferences(schema, byId, new Set()));
    }
    catch {
      entry.formModel = null; // schemas the form generator cannot walk
    }
  }
  hot = { schemaText, listKey, entry };
  return entry;
}

/**
 * Compile (cached) and validate: the wire() subscriber calls this on
 * every schema/data change and dispatches the JSON result.
 * @param {string} schemaText
 * @param {any} data
 * @param {any[]} [schemas] referenced schema documents the schema may `$ref` by `$id`
 * @returns {any} `{ schemaError, draft, compileMs, validateMs, valid, errors }`
 */
export function runValidation(schemaText, data, schemas = []) {
  const entry = compiled(schemaText, schemas);
  if (entry.validate === null) {
    return {
      schemaError: entry.schemaError, schemaPane: entry.schemaPane, draft: entry.draft,
      // the parser's own words, when the schema text is not JSON: a host
      // renders the refusal around them in its reader's language
      ...(entry.schemaJsonReason === null ? {} : { schemaJsonReason: entry.schemaJsonReason }),
      compileMs: null, validateMs: null, valid: null, errors: [],
    };
  }
  const start = now();
  // with collectErrors the compiled validator returns { valid, errors }
  const outcome = entry.validate(data);
  const validateMs = now() - start;
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  const raw = typeof outcome === 'object' && outcome !== null ? outcome.errors ?? [] : [];
  return {
    schemaError: null,
    draft: entry.draft,
    compileMs: entry.compileMs,
    validateMs,
    valid,
    errors: raw.map((e) => ({
      instancePath: e.instancePath ?? '',
      keyword: e.keyword ?? '',
      msgid: e.msgid,
      params: e.params,
      message: e.message ?? '',
      // the text the schema wrote stays as written in every locale
      ...(e.inlineMessage === undefined ? {} : { inlineMessage: e.inlineMessage }),
    })),
  };
}

/**
 * The generated form's render tree for the current schema + data. The
 * referenced documents are the ones the run registered, so the form reads
 * the same compile and shows the fields a `$ref` by `$id` brings in. The
 * field alerts speak `locale`, the language the errors table speaks: each
 * pack carries the forms' `form/*` messages beside the validator's.
 * @param {string} schemaText
 * @param {any} data
 * @param {any[]} [schemas]
 * @param {string} [locale] - a {@link LOCALES} code; English when no pack has it
 */
export function formViewFor(schemaText, data, schemas = [], locale = 'en') {
  const entry = compiled(schemaText, schemas);
  if (entry.formModel === null) return null;
  const catalog = catalogFor(locale);
  try {
    return buildFormViewModel(entry.formModel, data, catalog === undefined ? { validateFields: true } : { validateFields: true, catalog });
  }
  catch {
    return null;
  }
}

/**
 * The `@jarenjs/locales` packs this page has loaded, compiled once each:
 * a language's pack arrives only when that language is needed (the site
 * language, or an example made to show one), so English readers download
 * none; `boundaries/lang.js` loads it, `addLocalePack` keeps it.
 * @type {Map<string, Readonly<Record<string, (params: object, error?: object) => string>>>}
 */
const CATALOGS = new Map();

/**
 * Keep a loaded `@jarenjs/locales` pack, compiled, under its locale code.
 * @param {string} code @param {Record<string, any>} pack
 */
export function addLocalePack(code, pack) {
  if (!CATALOGS.has(code)) CATALOGS.set(code, compileMessageCatalog(pack));
}

/**
 * The site's locale codes, in display order: the built-in English first,
 * then every `@jarenjs/locales` pack in `LOCALE_NAMES` order (derived, so a
 * pack added there cannot end up without a button).
 */
export const LOCALES = ['en', ...LOCALE_NAMES.map(({ code }) => code)];

/**
 * The compiled pack of a language — validate's, forms', play's and every
 * other published package's words — once loaded; undefined for English and
 * for a pack not loaded yet (which renders English).
 * @param {string | null | undefined} code
 */
export const catalogFor = (code) => (typeof code === 'string' ? CATALOGS.get(code) : undefined);

/**
 * Report-time localization: raw errors carry msgid + params; text
 * renders per locale without re-validating.
 */
export function localizeErrors(errors, locale) {
  const catalog = catalogFor(locale);
  if (catalog === undefined) return errors;
  // validate's own localizer, over copies (the report is cached per run):
  // it keeps the text a schema wrote, as the error's `inlineMessage` says
  return localizeValidationErrors(errors.map((error) => ({ ...error })), catalog);
}

/**
 * The generated form's chrome (the array buttons' names and the JSON
 * hint) in `locale`, English when no pack has it.
 * @param {string} [locale] - a {@link LOCALES} code
 * @returns {{addItem: string, removeItem: string, jsonPlaceholder: string}}
 */
export function formLabelsFor(locale) {
  return formChromeLabels(catalogFor(locale));
}
