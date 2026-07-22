//@ts-check

/**
 * Preemptive per-field validation.
 *
 * These checks run synchronously on every keystroke, powered directly by
 * @jarenjs/core primitives (grapheme-aware string length, unicode regexes,
 * format testers, deep equality). They give the user immediate feedback
 * per field BEFORE the complete compiled schema validation runs - which
 * remains authoritative for cross-field rules (required combinations,
 * dependencies, unevaluatedProperties, ...). Cross-field feedback per
 * keystroke is rules.js territory (the `x-form` annotation).
 *
 * Every failure is structured: a stable `msgid`
 * (`form/<keyword>`) plus raw `params`, with `message` rendered eagerly -
 * failure-only, cheap - through a catalog (messages.js), so consumers can
 * re-render in another locale from `msgid` + `params`.
 */

import {
  getStringLength,
  createRegExp,
} from '@jarenjs/core/string';

import {
  equalsDeep,
  isUniqueDeepArray,
} from '@jarenjs/core/object';

import {
  encodeJSONPointerSegment,
} from '@jarenjs/json/pointer';

import {
  getFormatInfo,
} from './formats.js';

import {
  renderFormsMessage,
} from './messages.js';

/**
 * @typedef {object} FieldError
 * @property {string} keyword - The JSON Schema keyword that failed
 * @property {object} params - Structured, keyword-specific parameters
 * @property {string} msgid - Stable message key (`form/<keyword>` or `x-form/assert`)
 * @property {string} message - Human readable message (rendered through a catalog)
 */

const regexCache = new Map();
function getPattern(source) {
  let regex = regexCache.get(source);
  if (regex === undefined) {
    try {
      regex = createRegExp(source);
    }
    catch (_e) {
      regex = null;
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(source, regex);
  }
  return regex;
}

/**
 * Push one structured field error, rendering its message through the
 * catalog (built-in English fallback). Failure-only path.
 * @param {FieldError[]} errors - The output array
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>|undefined} catalog - Compiled catalog or undefined for English
 * @param {string} keyword - The failed keyword
 * @param {object} params - The structured params
 */
function pushError(errors, catalog, keyword, params) {
  const msgid = `form/${keyword}`;
  errors.push({
    keyword,
    params,
    msgid,
    message: renderFormsMessage(catalog, msgid, params),
  });
}

/**
 * Validate a single field value against its own constraints.
 *
 * @param {import('./model.js').FormField} field - Field from buildFormModel
 * @param {any} value - The TYPED value (see parseFieldInput); undefined = absent
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog (see messages.js), default English
 * @returns {FieldError[]} Empty when the value passes every per-field check
 * @example
 * const errors = validateField(emailField, 'not-an-email');
 * // [{ keyword: 'format', params: { format: 'email' },
 * //    msgid: 'form/format', message: 'Must be a valid email' }]
 */
export function validateField(field, value, catalog = undefined) {
  /** @type {FieldError[]} */
  const errors = [];
  if (field == null) return errors;

  // Absent value: only `required` applies
  if (value === undefined || value === null) {
    if (field.required && field.kind !== 'boolean') {
      pushError(errors, catalog, 'required', {});
    }
    return errors;
  }

  const c = field.constraints;

  switch (field.kind) {
    case 'const': {
      if (!equalsDeep(value, field.constValue)) {
        pushError(errors, catalog, 'const', { constValue: field.constValue });
      }
      return errors;
    }

    case 'enum': {
      if (!field.enumValues?.some((option) => equalsDeep(value, option))) {
        pushError(errors, catalog, 'enum', { enumValues: field.enumValues });
      }
      return errors;
    }

    case 'string': {
      if (typeof value !== 'string') {
        pushError(errors, catalog, 'type', { type: 'string' });
        return errors;
      }
      let len = -1;
      if (c.minLength !== undefined || c.maxLength !== undefined) {
        len = getStringLength(value, true); // grapheme-aware, like the validator
      }
      if (c.minLength !== undefined && len < c.minLength) {
        pushError(errors, catalog, 'minLength', { limit: c.minLength, len });
      }
      if (c.maxLength !== undefined && len > c.maxLength) {
        pushError(errors, catalog, 'maxLength', { limit: c.maxLength, len });
      }
      if (c.pattern !== undefined) {
        const regex = getPattern(c.pattern);
        if (regex != null && !regex.test(value)) {
          pushError(errors, catalog, 'pattern', { pattern: c.pattern });
        }
      }
      if (c.format !== undefined && value !== '') {
        const info = getFormatInfo(c.format);
        if (info != null && !info.test(value)) {
          pushError(errors, catalog, 'format', { format: c.format });
        }
      }
      return errors;
    }

    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(num)) {
        pushError(errors, catalog, 'type', { type: 'number' });
        return errors;
      }
      if (field.kind === 'integer' && !Number.isInteger(num)) {
        pushError(errors, catalog, 'type', { type: 'integer' });
      }
      if (c.minimum !== undefined && num < c.minimum) {
        pushError(errors, catalog, 'minimum', { limit: c.minimum });
      }
      if (c.maximum !== undefined && num > c.maximum) {
        pushError(errors, catalog, 'maximum', { limit: c.maximum });
      }
      if (c.exclusiveMinimum !== undefined && num <= c.exclusiveMinimum) {
        pushError(errors, catalog, 'exclusiveMinimum', { limit: c.exclusiveMinimum });
      }
      if (c.exclusiveMaximum !== undefined && num >= c.exclusiveMaximum) {
        pushError(errors, catalog, 'exclusiveMaximum', { limit: c.exclusiveMaximum });
      }
      if (c.multipleOf !== undefined) {
        const quotient = num / c.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) >= 1e-6) {
          pushError(errors, catalog, 'multipleOf', { multipleOf: c.multipleOf });
        }
      }
      return errors;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        pushError(errors, catalog, 'type', { type: 'boolean' });
      }
      return errors;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        pushError(errors, catalog, 'type', { type: 'array' });
        return errors;
      }
      if (c.minItems !== undefined && value.length < c.minItems) {
        pushError(errors, catalog, 'minItems', { limit: c.minItems });
      }
      if (c.maxItems !== undefined && value.length > c.maxItems) {
        pushError(errors, catalog, 'maxItems', { limit: c.maxItems });
      }
      if (c.uniqueItems === true && !isUniqueDeepArray(value)) {
        pushError(errors, catalog, 'uniqueItems', {});
      }
      return errors;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        pushError(errors, catalog, 'type', { type: 'object' });
        return errors;
      }
      const size = Object.keys(value).length;
      if (c.minProperties !== undefined && size < c.minProperties) {
        pushError(errors, catalog, 'minProperties', { limit: c.minProperties });
      }
      if (c.maxProperties !== undefined && size > c.maxProperties) {
        pushError(errors, catalog, 'maxProperties', { limit: c.maxProperties });
      }
      return errors;
    }

    default:
      return errors;
  }
}

/**
 * Validate every leaf field of a model against the current data.
 * Returns a map of data-pointer -> FieldError[] for fields that fail.
 * @param {import('./model.js').FormField} model - Root field from buildFormModel
 * @param {any} data - Current form data
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog, default English
 * @returns {Record<string, FieldError[]>}
 */
export function validateAllFields(model, data, catalog = undefined) {
  /** @type {Record<string, FieldError[]>} */
  const result = {};
  walkFields(model, data, '', result, catalog);
  return result;
}

function walkFields(field, value, pointer, result, catalog) {
  const errors = validateField(field, value, catalog);
  if (errors.length > 0) result[pointer] = errors;

  if (field.kind === 'object' && field.children && value != null && typeof value === 'object') {
    for (const child of field.children) {
      // RFC 6901-encoded, the walk convention shared with the model
      // and rule pointers — a member name containing '/' or '~' stays
      // addressable and never collides with a nested path
      walkFields(child, value[child.key], `${pointer}/${encodeJSONPointerSegment(child.key)}`, result, catalog);
    }
  }
  else if (field.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemField = field.tuple?.[i] ?? field.item;
      if (itemField) walkFields(itemField, value[i], `${pointer}/${i}`, result, catalog);
    }
  }
}
