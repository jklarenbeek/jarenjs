//@ts-check
/**
 * @file The JSON Schema runner a Play host injects as the `validate` seam
 * (PLAY-FORMAT §5): compile a schema text with its referenced schemas,
 * validate a data value, and hand back a plain-JSON report, localized to
 * the run's language. Compiled validators and form models stay inside the
 * runner, kept hot per (schema text, referenced schemas) pair.
 */

import { JarenValidator } from '@jarenjs/validate';

import { localizePlayErrors } from './catalogs.js';

const now = () => performance.now();

/**
 * Friendly draft name from a schema's `$schema` declaration.
 * @param {unknown} schema
 * @returns {string}
 */
export function detectDraftName(schema) {
  const url = (schema !== null && typeof schema === 'object' && /** @type {any} */ (schema).$schema) || '';
  if (url.includes('2020-12')) return '2020-12';
  if (url.includes('2019-09')) return '2019-09';
  if (url.includes('draft-07')) return 'draft-07';
  if (url.includes('draft-06')) return 'draft-06';
  return 'draft-07 (default)';
}

/**
 * The referenced-schemas pane's text as the list a run registers: the
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

/** The `$id` a `$ref` names: the reference without an empty trailing fragment. @param {string} id */
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
 * One validation error as a report carries it: plain JSON.
 * @typedef {object} PlayValidationError
 * @property {string} instancePath
 * @property {string} keyword
 * @property {string} [msgid]
 * @property {any} [params]
 * @property {string} message
 * @property {boolean | 'fallback'} [inlineMessage] - Set when the text is the
 *   schema's own (an inline message) or a `$msgid` fallback: it stays as
 *   written in every language.
 */

/**
 * The report of one run, the shape the `validate` engine reads.
 * @typedef {object} PlayValidationReport
 * @property {string | null} schemaError - Why the schema (or a referenced
 *   one) did not compile, or null.
 * @property {'schemas'} [schemaPane] - Set when the fault is in a referenced
 *   schema, so the engine locates it at that pane.
 * @property {string} [schemaJsonReason] - The parser's own words when the
 *   schema text is not JSON, for a host to word the refusal in its reader's
 *   language (`schemaError` then reads `Invalid JSON: <reason>`).
 * @property {string | null} draft
 * @property {number | null} compileMs
 * @property {number | null} validateMs
 * @property {boolean | null} valid
 * @property {PlayValidationError[]} errors
 */

/**
 * The `@jarenjs/forms` functions the runner builds the generated form with,
 * handed in by a host that renders one.
 * @typedef {object} PlayFormFunctions
 * @property {(schema: any) => any} buildFormModel
 * @property {(model: any, data: any, options?: any) => any} buildFormViewModel
 * @property {(catalog?: any) => {addItem: string, removeItem: string, jsonPlaceholder: string}} formChromeLabels
 */

/**
 * A JSON Schema runner for one host.
 * @typedef {object} PlayValidator
 * @property {(schemaText: string, data: any, schemas?: any[]) => PlayValidationReport} run -
 *   Compile (cached) and validate; the errors in English, as the validator
 *   wrote them.
 * @property {(schemaText: string, data: any, locale: string, schemas?: any[]) => PlayValidationReport} validate -
 *   The engine seam (`createPlayComponent({ validate })`): `run`, its errors
 *   in `locale` when that language's catalog is loaded.
 * @property {(schemaText: string, data: any, schemas?: any[], locale?: string) => any} formView -
 *   The generated form's render tree for the schema and data, its field
 *   alerts in `locale`; null without form functions or for a schema the
 *   generator cannot walk.
 * @property {(locale?: string) => {addItem: string, removeItem: string, jsonPlaceholder: string} | null} formLabels -
 *   The generated form's chrome (the array buttons' names and the JSON
 *   hint) in `locale`, English when no catalog has it; null without form
 *   functions.
 */

/**
 * A JSON Schema runner. Every compile uses a fresh validator with format
 * assertion on, `formats` added and the run's referenced schemas
 * registered, so registrations never collide between edits. The last
 * (schema text, referenced schemas) pair is kept hot: the run, the form and
 * the form's chrome read the same compile.
 * @param {{ catalogs?: { catalogFor: (code: string | null | undefined) => any }, formats?: any[],
 *   forms?: PlayFormFunctions }} [options] - `catalogs`: the host's loaded
 *   languages (English only without it); `formats`: the format sets to
 *   assert (`@jarenjs/formats`' `stringFormats`, … — none by default);
 *   `forms`: the `@jarenjs/forms` functions, for a host that renders the
 *   generated form
 * @returns {PlayValidator}
 */
export function createPlayValidator(options = {}) {
  const { catalogs, formats = [], forms } = options;
  const catalogFor = (/** @type {string | undefined} */ locale) => catalogs?.catalogFor(locale);

  /** @param {any[]} schemas */
  const createInstance = (schemas) => {
    const instance = new JarenValidator({ skipErrors: false, collectErrors: true, formatAssertion: true });
    for (const set of formats) instance.addFormats(set);
    for (const schema of schemas) instance.addSchema(schema);
    return instance;
  };

  /**
   * The compiled state of ONE (schema text, referenced documents) pair. The
   * referenced documents are part of what was compiled, so editing only one
   * of them must not answer from the previous compile; a pair compares on
   * both parts, never on a joined key.
   * @type {{ schemaText: string, listKey: string, entry: any } | null}
   */
  let hot = null;

  /** @param {string} schemaText @param {any[]} [schemas] */
  const compiled = (schemaText, schemas = []) => {
    const listKey = JSON.stringify(schemas);
    if (hot !== null && hot.schemaText === schemaText && hot.listKey === listKey) return hot.entry;
    const entry = { validate: /** @type {any} */ (null), formModel: null, schemaError: /** @type {string | null} */ (null),
      schemaJsonReason: /** @type {string | null} */ (null), schemaPane: /** @type {'schemas' | null} */ (null),
      compileMs: /** @type {number | null} */ (null), draft: /** @type {string | null} */ (null) };
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
      if (forms !== undefined) {
        try {
          const byId = new Map(schemas.map((doc) => [bareId(doc.$id), doc]));
          entry.formModel = forms.buildFormModel(byId.size === 0 ? schema : inlineReferences(schema, byId, new Set()));
        }
        catch {
          entry.formModel = null; // schemas the form generator cannot walk
        }
      }
    }
    hot = { schemaText, listKey, entry };
    return entry;
  };

  /** @type {PlayValidator['run']} */
  const run = (schemaText, data, schemas = []) => {
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
      errors: raw.map((/** @type {any} */ e) => ({
        instancePath: e.instancePath ?? '',
        keyword: e.keyword ?? '',
        msgid: e.msgid,
        params: e.params,
        message: e.message ?? '',
        // the text the schema wrote stays as written in every locale
        ...(e.inlineMessage === undefined ? {} : { inlineMessage: e.inlineMessage }),
      })),
    };
  };

  return {
    run,
    validate: (schemaText, data, locale, schemas = []) => {
      const report = run(schemaText, data, schemas);
      return { ...report, errors: localizePlayErrors(report.errors, catalogFor(locale)) };
    },
    formView: (schemaText, data, schemas = [], locale = 'en') => {
      const entry = compiled(schemaText, schemas);
      if (forms === undefined || entry.formModel === null) return null;
      const catalog = catalogFor(locale);
      try {
        return forms.buildFormViewModel(entry.formModel, data, catalog === undefined ? { validateFields: true } : { validateFields: true, catalog });
      }
      catch {
        return null;
      }
    },
    formLabels: (locale) => (forms === undefined ? null : forms.formChromeLabels(catalogFor(locale))),
  };
}

/**
 * The validate engine's generated form for the view model, mounted beside
 * the component's `ui.play`: its render tree at `dataForm` and its chrome at
 * `formLabels`, both in the language the slice runs in (pass the slice
 * through `withPlayLocale` first, so an example made to show one language
 * keeps it). Null unless the slice is the validate engine with its data pane
 * on the form.
 * @param {PlayValidator} validator
 * @param {any} slice - the play slice, as `withPlayLocale` answers it
 * @returns {{ dataForm: any, formLabels: {addItem: string, removeItem: string, jsonPlaceholder: string} | null } | null}
 */
export function playDataForm(validator, slice) {
  if (slice.engine !== 'validate' || slice.dataView !== 'form') return null;
  const locale = slice.config?.locale;
  return {
    dataForm: validator.formView(slice.source?.schema ?? '', slice.dataValue, referencedSchemas(slice.source?.schemas), locale),
    formLabels: validator.formLabels(locale),
  };
}
