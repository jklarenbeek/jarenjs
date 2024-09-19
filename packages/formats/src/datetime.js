//@ts-check

import {
  isStringType,
  getInclusiveExclusiveBounds,
} from '@jarenjs/core';

import {
  isDateType,
  getDateTypeOfDateTimeRFC3339,
  getDateTypeOfDateOnlyRFC3339,
  getDateTypeOfTimeOnlyRFC3339,
} from '@jarenjs/core/dates';

//#region generalized
function compileFormatMinimumByType(parseType, schemaObj, jsonSchema) {
  const [min, emin] = getInclusiveExclusiveBounds(
    parseType,
    jsonSchema.formatMinimum,
    jsonSchema.formatExclusiveMinimum,
  );

  if (emin != null) {
    const addError = schemaObj.createErrorHandler(emin, 'formatExclusiveMinimum');

    return function isFormatExclusiveMinimum(date, dataPath) {
      return date > emin
        || addError(date, dataPath);
    };
  }
  else if (min) {
    const addError = schemaObj.createErrorHandler(min, 'formatMinimum');

    return function isFormatMinimum(date, dataPath) {
      return date >= min
        || addError(date, dataPath);
    };
  }

  return undefined;
}

function compileFormatMaximumByType(parseType, schemaObj, jsonSchema) {
  const [max, emax] = getInclusiveExclusiveBounds(
    parseType,
    jsonSchema.formatMaximum,
    jsonSchema.formatExclusiveMaximum,
  );

  if (emax != null) {
    const addError = schemaObj.createErrorHandler(emax, 'formatExclusiveMaximum');

    return function isFormatExclusiveMaximum(date, dataPath) {
      return date < emax
        || addError(date, dataPath);
    };
  }
  else if (max != null) {
    const addError = schemaObj.createErrorHandler(max, 'formatMaximum');

    return function isFormatMaximum(date, dataPath) {
      return date <= max
        || addError(date, dataPath);
    };
  }

  return undefined;
}

function compileFormatByType(name, parseType, schemaObj, jsonSchema) {
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

  if (validateMin != null && validateMax != null) {
    return function validateFormatBetween(data, dataPath) {
      if (isStringType(data)) {
        const date = parseType(data);
        return date == null
          ? addError(data, dataPath)
          : validateMin(date, dataPath)
            && validateMax(date, dataPath);
      }
      else if (isDateType(data))
        return validateMin(data, dataPath)
          && validateMax(data, dataPath);
      else
        return true;
    };
  }
  if (validateMin != null) {
    return function validateFormatMinimum(data, dataPath) {
      if (isStringType(data)) {
        const date = parseType(data);
        return date == null
          ? addError(data, dataPath)
          : validateMin(date, dataPath);
      }
      else if (isDateType(data))
        return validateMin(data, dataPath);
      else
        return true;
    };
  }
  if (validateMax != null) {
    return function validateFormatMaximum(data, dataPath) {
      if (isStringType(data)) {
        const date = parseType(data);
        return date == null
          ? addError(data, dataPath)
          : validateMax(date);
      }
      else if (isDateType(data))
        return validateMax(data, dataPath);
      else
        return true;
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
//#endregion

function compileDateTimeFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'date-time',
    getDateTypeOfDateTimeRFC3339,
    schemaObj,
    jsonSchema,
  );
}

function compileDateOnlyFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'date',
    getDateTypeOfDateOnlyRFC3339,
    schemaObj,
    jsonSchema,
  );
}

function compileTimeOnlyFormat(schemaObj, jsonSchema) {
  return compileFormatByType(
    'time',
    getDateTypeOfTimeOnlyRFC3339,
    schemaObj,
    jsonSchema,
  );
}

export const formatValidators = {
  'date-time': compileDateTimeFormat,
  date: compileDateOnlyFormat,
  time: compileTimeOnlyFormat,
};
