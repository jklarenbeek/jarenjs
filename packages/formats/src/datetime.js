//@ts-check

import {
  isStringType,
  getInclusiveExclusiveBounds,
} from '@jarenjs/core';

import {
  isDateType,
  isDateTimeRFC3339,
  isDateOnlyRFC3339,
  isTimeOnlyRFC3339,
  getDateTypeOfDateTimeRFC3339,
  getDateTypeOfDateOnlyRFC3339,
  getDateTypeOfTimeOnlyRFC3339,
  getEpochOfDateTimeRFC3339,
  getEpochOfDateOnlyRFC3339,
  getEpochOfTimeOnlyRFC3339,
  isValidDuration,
  getDateTypeOfISODateTime,
  getDateTypeOfISOTime,
  getEpochOfISODateTime,
  getEpochOfISOTime,
} from '@jarenjs/core/dates';

/**
 * @typedef {{format?: string, formatMinimum?: string, formatExclusiveMinimum?: string, formatMaximum?: string, formatExclusiveMaximum?: string}} JSONSchema
 * @typedef {{
 *   options: {skipErrors: boolean},
 *   createErrorHandler: (expected: any, key: string, ...details: any[]) => (data: any, dataPath?: string) => boolean
 * }} ValidationObject
 */

// The bound validators compare epoch milliseconds: the bound is folded
// to a number at compile time and the value arrives as either an epoch
// number (the string path, which then allocates nothing) or a raw Date
// instance (which the relational operators coerce numerically, keeping
// that door open). Only the error path materializes a Date, so the
// reported error value stays what it always was.
function asDateValue(value) {
  return typeof value === 'number' ? new Date(value) : value;
}

/**
 * Compiles a format minimum validator function for date/time types.
 * Supports both inclusive (formatMinimum) and exclusive (formatExclusiveMinimum) bounds.
 *
 * @param {(value: string) => Date | undefined} parseType - Function to parse string into Date
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing format constraints
 * @returns {((date: number | Date, dataPath?: string) => boolean) | undefined} A validator function or undefined if no minimum constraint
 */
function compileFormatMinimumByType(parseType, schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    parseType,
    jsonSchema.formatMinimum,
    jsonSchema.formatExclusiveMinimum,
  );

  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'formatExclusiveMinimum');
    const bound = emin.valueOf();

    return function isFormatExclusiveMinimum(date, dataPath) {
      return date > bound
        || addError(asDateValue(date), dataPath);
    };
  }
  else if (min) {
    const addError = schemaObj.createErrorHandler(min, 'formatMinimum');
    const bound = min.valueOf();

    return function isFormatMinimum(date, dataPath) {
      return date >= bound
        || addError(asDateValue(date), dataPath);
    };
  }

  return undefined;
}

/**
 * Compiles a format maximum validator function for date/time types.
 * Supports both inclusive (formatMaximum) and exclusive (formatExclusiveMaximum) bounds.
 *
 * @param {(value: string) => Date | undefined} parseType - Function to parse string into Date
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing format constraints
 * @returns {((date: number | Date, dataPath?: string) => boolean) | undefined} A validator function or undefined if no maximum constraint
 */
function compileFormatMaximumByType(parseType, schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    parseType,
    jsonSchema.formatMaximum,
    jsonSchema.formatExclusiveMaximum,
  );

  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'formatExclusiveMaximum');
    const bound = emax.valueOf();

    return function isFormatExclusiveMaximum(date, dataPath) {
      return date < bound
        || addError(asDateValue(date), dataPath);
    };
  }
  else if (max) {
    const addError = schemaObj.createErrorHandler(max, 'formatMaximum');
    const bound = max.valueOf();

    return function isFormatMaximum(date, dataPath) {
      return date <= bound
        || addError(asDateValue(date), dataPath);
    };
  }

  return undefined;
}

/**
 * Creates a date/time format compiler with range validation support.
 * Combines format validation with optional minimum and maximum bounds.
 *
 * @param {string} name - The name of the format (e.g., 'date-time', 'date', 'time')
 * @param {(value: string) => Date | undefined} parseType - Function to parse string into Date
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @param {(value: string) => boolean} [isType] - Boolean tester matching parseType's
 *   accepted grammar; used on the boundless path so no Date is constructed
 * @param {(value: string) => number | undefined} [parseEpoch] - Epoch twin of
 *   parseType; used on the bounded path so string values compare as numbers
 *   without constructing a Date
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * // Basic format validation
 * compileFormatByType('date', getDateTypeOfDateOnlyRFC3339, schemaObj, { format: 'date' })('2024-01-15'); // true
 *
 * // With range constraints
 * compileFormatByType('date-time', getDateTypeOfDateTimeRFC3339, schemaObj, {
 *   format: 'date-time',
 *   formatMinimum: '2024-01-01T00:00:00Z'
 * })('2024-06-15T12:00:00Z'); // true
 */
function compileFormatByType(name, parseType, schemaObj, jsonSchema, isType = undefined, parseEpoch = undefined) {
  if (jsonSchema.format !== name)
    throw new Error('ERROR: This should not happen!');

  const addError = schemaObj.createErrorHandler(jsonSchema.format, 'format');

  const validateMin = compileFormatMinimumByType(
    parseType,
    schemaObj,
    jsonSchema,
  );

  const validateMax = compileFormatMaximumByType(
    parseType,
    schemaObj,
    jsonSchema,
  );

  // the bounded paths parse string values with the epoch twin where one
  // exists, so a passing validation allocates nothing
  const parseValue = parseEpoch != null ? parseEpoch : parseType;

  if (validateMin != null && validateMax != null) {
    return function validateFormatBetween(data, dataPath) {
      if (isStringType(data)) {
        const date = parseValue(data);
        return date == null
          ? addError(data, dataPath)
          : validateMin(date, dataPath)
            && validateMax(date, dataPath);
      }
      else if (isDateType(data))
        // @ts-ignore
        return validateMin(data, dataPath)
          // @ts-ignore
          && validateMax(data, dataPath);
      else
        return true;
    };
  }
  if (validateMin != null) {
    return function validateFormatMinimum(data, dataPath) {
      if (isStringType(data)) {
        const date = parseValue(data);
        return date == null
          ? addError(data, dataPath)
          : validateMin(date, dataPath);
      }
      else if (isDateType(data))
        // @ts-ignore
        return validateMin(data, dataPath);
      else
        return true;
    };
  }
  if (validateMax != null) {
    return function validateFormatMaximum(data, dataPath) {
      if (isStringType(data)) {
        const date = parseValue(data);
        return date == null
          ? addError(data, dataPath)
          : validateMax(date, dataPath);
      }
      else if (isDateType(data))
        // @ts-ignore
        return validateMax(data, dataPath);
      else
        return true;
    };
  }

  // Without bounds only the format assertion remains; the boolean tester
  // avoids parsing the string into a Date that would be discarded.
  if (isType != null) {
    return function validateDateTimeFormatOnly(data, dataPath) {
      return isStringType(data)
        ? isType(data) || addError(data, dataPath)
        : true;
    };
  }

  return function validateDateTime(data, dataPath) {
    if (isStringType(data)) {
      const date = parseType(data);
      return date == null
        ? addError(data, dataPath)
        : true;
    }
    else
      return true;
  };
}

// =============================================================================
// Date-Time Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'date-time' format.
 * Validates date-time strings per RFC 3339 (ISO 8601 profile).
 * Supports formatMinimum, formatMaximum, formatExclusiveMinimum, formatExclusiveMaximum.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileDateTimeFormat(schemaObj, { format: 'date-time' })('2024-01-15T12:30:00Z'); // true
 * compileDateTimeFormat(schemaObj, { format: 'date-time' })('2024-01-15T12:30:00+01:00'); // true
 * compileDateTimeFormat(schemaObj, { format: 'date-time' })('invalid'); // false (with error)
 */
export function compileDateTimeFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'date-time',
    getDateTypeOfDateTimeRFC3339,
    schemaObj,
    jsonSchema,
    isDateTimeRFC3339,
    getEpochOfDateTimeRFC3339,
  );
}

/**
 * Compiles a validator for the 'date' format.
 * Validates date-only strings (YYYY-MM-DD) per RFC 3339.
 * Supports formatMinimum, formatMaximum, formatExclusiveMinimum, formatExclusiveMaximum.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileDateOnlyFormat(schemaObj, { format: 'date' })('2024-01-15'); // true
 * compileDateOnlyFormat(schemaObj, { format: 'date' })('2024-13-45'); // false (with error)
 */
export function compileDateOnlyFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'date',
    getDateTypeOfDateOnlyRFC3339,
    schemaObj,
    jsonSchema,
    isDateOnlyRFC3339,
    getEpochOfDateOnlyRFC3339,
  );
}

/**
 * Compiles a validator for the 'time' format.
 * Validates time-only strings (HH:MM:SS or HH:MM:SS.sss) per RFC 3339.
 * Supports formatMinimum, formatMaximum, formatExclusiveMinimum, formatExclusiveMaximum.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileTimeOnlyFormat(schemaObj, { format: 'time' })('12:30:00'); // true
 * compileTimeOnlyFormat(schemaObj, { format: 'time' })('12:30:00.123'); // true
 * compileTimeOnlyFormat(schemaObj, { format: 'time' })('25:00:00'); // false (with error)
 */
export function compileTimeOnlyFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'time',
    getDateTypeOfTimeOnlyRFC3339,
    schemaObj,
    jsonSchema,
    isTimeOnlyRFC3339,
    getEpochOfTimeOnlyRFC3339,
  );
}

// =============================================================================
// Duration Format Compiler (RFC 3339)
// =============================================================================

/**
 * Compiles a validator for the 'duration' format.
 * Validates duration strings per RFC 3339.
 * Format: P[n]Y[n]M[n]DT[n]H[n]M[n]S or P[n]W
 * Examples: P1Y2M3DT4H5M6S, P1W, PT1H
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileDurationFormat(schemaObj, { format: 'duration' })('P1Y2M3DT4H5M6S'); // true
 * compileDurationFormat(schemaObj, { format: 'duration' })('P1W'); // true
 * compileDurationFormat(schemaObj, { format: 'duration' })('PT1H30M'); // true
 * compileDurationFormat(schemaObj, { format: 'duration' })('P'); // false (with error)
 */
export function compileDurationFormat(schemaObj, jsonSchema) {
  if (jsonSchema.format !== 'duration')
    throw new Error('ERROR: This should not happen!');

  // when skipErrors is true, we don't need to create error objects
  if (schemaObj.options.skipErrors) {
    return function validateDurationFast(data, _dataPath) {
      return isStringType(data)
        ? isValidDuration(data)
        : true;
    };
  }

  const addError = schemaObj.createErrorHandler('duration', 'format');

  return function validateDuration(data, dataPath) {
    return isStringType(data)
      ? isValidDuration(data) || addError(data, dataPath)
      : true;
  };
}

// =============================================================================
// ISO Date-Time and ISO Time Format Compilers
// =============================================================================

/**
 * Compiles a validator for the 'iso-date-time' format.
 * Validates ISO 8601 date-time strings with optional timezone.
 * Unlike RFC 3339 date-time, the timezone is optional.
 * Supports formatMinimum, formatMaximum, formatExclusiveMinimum, formatExclusiveMaximum.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileISODateTimeFormat(schemaObj, { format: 'iso-date-time' })('2024-01-15T12:30:00Z'); // true
 * compileISODateTimeFormat(schemaObj, { format: 'iso-date-time' })('2024-01-15T12:30:00+01:00'); // true
 * compileISODateTimeFormat(schemaObj, { format: 'iso-date-time' })('2024-01-15T12:30:00'); // true (no timezone)
 * compileISODateTimeFormat(schemaObj, { format: 'iso-date-time' })('2024-13-15T12:30:00'); // false (with error)
 */
export function compileISODateTimeFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'iso-date-time',
    getDateTypeOfISODateTime,
    schemaObj,
    jsonSchema,
    undefined,
    getEpochOfISODateTime,
  );
}

/**
 * Compiles a validator for the 'iso-time' format.
 * Validates ISO 8601 time strings with optional timezone.
 * Unlike RFC 3339 time, the timezone is optional.
 * Supports formatMinimum, formatMaximum, formatExclusiveMinimum, formatExclusiveMaximum.
 *
 * @param {ValidationObject} schemaObj - The validation object for error handling and options
 * @param {JSONSchema} jsonSchema - The JSON schema containing the format definition
 * @returns {(data: unknown, dataPath?: string) => boolean} A validator function
 * @example
 * compileISOTimeFormat(schemaObj, { format: 'iso-time' })('12:30:00Z'); // true
 * compileISOTimeFormat(schemaObj, { format: 'iso-time' })('12:30:00+01:00'); // true
 * compileISOTimeFormat(schemaObj, { format: 'iso-time' })('12:30:00'); // true (no timezone)
 * compileISOTimeFormat(schemaObj, { format: 'iso-time' })('25:00:00'); // false (with error)
 */
export function compileISOTimeFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'iso-time',
    getDateTypeOfISOTime,
    schemaObj,
    jsonSchema,
    undefined,
    getEpochOfISOTime,
  );
}

/**
 * Object mapping date/time format names to their compiler functions.
 * Used for backward compatibility and aggregate imports.
 *
 * @type {Record<string, (schemaObj: ValidationObject, jsonSchema: JSONSchema) => (data: unknown, dataPath?: string) => boolean>}
 */
export const formatValidators = {
  'date-time': compileDateTimeFormat,
  date: compileDateOnlyFormat,
  time: compileTimeOnlyFormat,
  duration: compileDurationFormat,
  'iso-date-time': compileISODateTimeFormat,
  'iso-time': compileISOTimeFormat,
};
