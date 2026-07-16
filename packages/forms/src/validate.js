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
  getFormatInfo,
} from './formats.js';

/**
 * @typedef {object} FieldError
 * @property {string} keyword - The JSON Schema keyword that failed
 * @property {string} message - Human readable message
 */

const regexCache = new Map();
function getPattern(source) {
  let regex = regexCache.get(source);
  if (regex === undefined) {
    try {
      regex = createRegExp(source);
    }
    catch (e) {
      regex = null;
    }
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(source, regex);
  }
  return regex;
}

function formatValue(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/**
 * Validate a single field value against its own constraints.
 *
 * @param {import('./model.js').FormField} field - Field from buildFormModel
 * @param {any} value - The TYPED value (see parseFieldInput); undefined = absent
 * @returns {FieldError[]} Empty when the value passes every per-field check
 * @example
 * const errors = validateField(emailField, 'not-an-email');
 * // [{ keyword: 'format', message: 'Must be a valid email' }]
 */
export function validateField(field, value) {
  /** @type {FieldError[]} */
  const errors = [];
  if (field == null) return errors;

  // Absent value: only `required` applies
  if (value === undefined || value === null) {
    if (field.required && field.kind !== 'boolean') {
      errors.push({ keyword: 'required', message: 'This field is required' });
    }
    return errors;
  }

  const c = field.constraints;

  switch (field.kind) {
    case 'const': {
      if (!equalsDeep(value, field.constValue)) {
        errors.push({ keyword: 'const', message: `Must be ${formatValue(field.constValue)}` });
      }
      return errors;
    }

    case 'enum': {
      if (!field.enumValues?.some((option) => equalsDeep(value, option))) {
        errors.push({
          keyword: 'enum',
          message: `Must be one of: ${field.enumValues?.map(formatValue).join(', ')}`,
        });
      }
      return errors;
    }

    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ keyword: 'type', message: 'Must be a string' });
        return errors;
      }
      let len = -1;
      if (c.minLength !== undefined || c.maxLength !== undefined) {
        len = getStringLength(value, true); // grapheme-aware, like the validator
      }
      if (c.minLength !== undefined && len < c.minLength) {
        errors.push({
          keyword: 'minLength',
          message: `Must be at least ${c.minLength} character${c.minLength === 1 ? '' : 's'} (currently ${len})`,
        });
      }
      if (c.maxLength !== undefined && len > c.maxLength) {
        errors.push({
          keyword: 'maxLength',
          message: `Must be at most ${c.maxLength} character${c.maxLength === 1 ? '' : 's'} (currently ${len})`,
        });
      }
      if (c.pattern !== undefined) {
        const regex = getPattern(c.pattern);
        if (regex != null && !regex.test(value)) {
          errors.push({ keyword: 'pattern', message: `Must match pattern ${c.pattern}` });
        }
      }
      if (c.format !== undefined && value !== '') {
        const info = getFormatInfo(c.format);
        if (info != null && !info.test(value)) {
          errors.push({ keyword: 'format', message: `Must be a valid ${c.format}` });
        }
      }
      return errors;
    }

    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(num)) {
        errors.push({ keyword: 'type', message: 'Must be a number' });
        return errors;
      }
      if (field.kind === 'integer' && !Number.isInteger(num)) {
        errors.push({ keyword: 'type', message: 'Must be an integer' });
      }
      if (c.minimum !== undefined && num < c.minimum) {
        errors.push({ keyword: 'minimum', message: `Must be at least ${c.minimum}` });
      }
      if (c.maximum !== undefined && num > c.maximum) {
        errors.push({ keyword: 'maximum', message: `Must be at most ${c.maximum}` });
      }
      if (c.exclusiveMinimum !== undefined && num <= c.exclusiveMinimum) {
        errors.push({ keyword: 'exclusiveMinimum', message: `Must be greater than ${c.exclusiveMinimum}` });
      }
      if (c.exclusiveMaximum !== undefined && num >= c.exclusiveMaximum) {
        errors.push({ keyword: 'exclusiveMaximum', message: `Must be less than ${c.exclusiveMaximum}` });
      }
      if (c.multipleOf !== undefined) {
        const quotient = num / c.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) >= 1e-6) {
          errors.push({ keyword: 'multipleOf', message: `Must be a multiple of ${c.multipleOf}` });
        }
      }
      return errors;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ keyword: 'type', message: 'Must be a boolean' });
      }
      return errors;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ keyword: 'type', message: 'Must be an array' });
        return errors;
      }
      if (c.minItems !== undefined && value.length < c.minItems) {
        errors.push({
          keyword: 'minItems',
          message: `Must have at least ${c.minItems} item${c.minItems === 1 ? '' : 's'}`,
        });
      }
      if (c.maxItems !== undefined && value.length > c.maxItems) {
        errors.push({
          keyword: 'maxItems',
          message: `Must have at most ${c.maxItems} item${c.maxItems === 1 ? '' : 's'}`,
        });
      }
      if (c.uniqueItems === true && !isUniqueDeepArray(value)) {
        errors.push({ keyword: 'uniqueItems', message: 'Items must be unique' });
      }
      return errors;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ keyword: 'type', message: 'Must be an object' });
        return errors;
      }
      const size = Object.keys(value).length;
      if (c.minProperties !== undefined && size < c.minProperties) {
        errors.push({ keyword: 'minProperties', message: `Must have at least ${c.minProperties} properties` });
      }
      if (c.maxProperties !== undefined && size > c.maxProperties) {
        errors.push({ keyword: 'maxProperties', message: `Must have at most ${c.maxProperties} properties` });
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
 * @returns {Record<string, FieldError[]>}
 */
export function validateAllFields(model, data) {
  /** @type {Record<string, FieldError[]>} */
  const result = {};
  walkFields(model, data, '', result);
  return result;
}

function walkFields(field, value, pointer, result) {
  const errors = validateField(field, value);
  if (errors.length > 0) result[pointer] = errors;

  if (field.kind === 'object' && field.children && value != null && typeof value === 'object') {
    for (const child of field.children) {
      walkFields(child, value[child.key], `${pointer}/${child.key}`, result);
    }
  }
  else if (field.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemField = field.tuple?.[i] ?? field.item;
      if (itemField) walkFields(itemField, value[i], `${pointer}/${i}`, result);
    }
  }
}
