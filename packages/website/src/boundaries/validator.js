//@ts-check
/**
 * The validator boundary: the one place the playground touches
 * compiled artifacts. Everything returned is plain JSON, fit for the
 * app state; compiled validators and form models live in module-local
 * memo caches keyed by schema text.
 */

import { JarenValidator, renderErrorMessage, compileMessageCatalog } from '@jarenjs/validate';
import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { nl } from '@jarenjs/locales';

const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

/** Friendly draft name from a schema's $schema declaration. */
export function detectDraftName(schema) {
  const url = (schema !== null && typeof schema === 'object' && schema.$schema) || '';
  if (url.includes('2020-12')) return '2020-12';
  if (url.includes('2019-09')) return '2019-09';
  if (url.includes('draft-07')) return 'draft-07';
  if (url.includes('draft-06')) return 'draft-06';
  return 'draft-07 (default)';
}

function createInstance() {
  // a fresh validator per compile keeps schema registrations from
  // colliding between edits
  return new JarenValidator({ skipErrors: false, collectErrors: true, formatAssertion: true })
    .addFormats(stringFormats)
    .addFormats(numberFormats)
    .addFormats(dateTimeFormats)
    .addFormats(jsonFormats);
}

/** schemaText -> { validate, formModel, schemaError, compileMs, draft } */
const compileCache = new Map();

function compiled(schemaText) {
  let entry = compileCache.get(schemaText);
  if (entry !== undefined) return entry;
  entry = { validate: null, formModel: null, schemaError: null, compileMs: null, draft: null };
  let schema;
  try {
    schema = JSON.parse(schemaText);
  }
  catch (err) {
    entry.schemaError = `Invalid JSON: ${/** @type {Error} */ (err).message}`;
  }
  if (entry.schemaError === null) {
    entry.draft = detectDraftName(schema);
    try {
      const start = now();
      entry.validate = createInstance().compile(schema);
      entry.compileMs = now() - start;
    }
    catch (err) {
      entry.schemaError = /** @type {Error} */ (err).message;
    }
    try {
      entry.formModel = buildFormModel(schema);
    }
    catch {
      entry.formModel = null; // schemas the form generator cannot walk
    }
  }
  compileCache.clear(); // keep exactly the current schema hot
  compileCache.set(schemaText, entry);
  return entry;
}

/**
 * Compile (cached) and validate: the wire() subscriber calls this on
 * every schema/data change and dispatches the JSON result.
 * @returns {any} `{ schemaError, draft, compileMs, validateMs, valid, errors }`
 */
export function runValidation(schemaText, data) {
  const entry = compiled(schemaText);
  if (entry.validate === null) {
    return {
      schemaError: entry.schemaError, draft: entry.draft,
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
    })),
  };
}

/** The generated form's render tree for the current schema + data. */
export function formViewFor(schemaText, data) {
  const entry = compiled(schemaText);
  if (entry.formModel === null) return null;
  try {
    return buildFormViewModel(entry.formModel, data, { validateFields: true });
  }
  catch {
    return null;
  }
}

const nlCatalog = compileMessageCatalog(nl);

/**
 * Report-time localization: raw errors carry msgid + params; text
 * renders per locale without re-validating.
 */
export function localizeErrors(errors, locale) {
  if (locale !== 'nl') return errors;
  return errors.map((error) => {
    if (error.msgid === undefined) return error;
    return { ...error, message: renderErrorMessage(error, nlCatalog) };
  });
}
