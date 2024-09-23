//@ts-check

import {
  isValidInt8,
  isValidInt16,
  isValidInt32,
  isValidInt64,
  isValidUInt8,
  isValidUInt16,
  isValidUInt32,
  isValidUInt64,
} from '@jarenjs/core/integer';

import {
  isValidFloat16,
  isValidFloat32,
  isValidFloat64,
} from '@jarenjs/core/float';

function createNumberFormatCompiler(formatName, isNumberTest, strictFormat = false) {
  return function compileNumberFormat(schemaObj, jsonSchema) {
    if (jsonSchema.format !== formatName)
      throw new Error('Format is not equal to jsonSchema (should not happen!)');

    const addError = schemaObj.createErrorHandler(formatName, 'format');

    if (strictFormat === true)
      return function validateNumberStrictFormat(data, dataPath) {
        return data == null
          || isNumberTest(data)
          || addError(data, dataPath);
      };
    else
      return function validateNumberFormat(data, dataPath) {
        return (data == null
          || isNumberTest(Number(data))
          || addError(data, dataPath));
      };
  };
}

export const formatValidators = {
  // integer types
  int8: createNumberFormatCompiler('int8', isValidInt8),
  uint8: createNumberFormatCompiler('uint8', isValidUInt8),
  int16: createNumberFormatCompiler('int16', isValidInt16),
  uint16: createNumberFormatCompiler('uint16', isValidUInt16),
  int32: createNumberFormatCompiler('int32', isValidInt32),
  uint32: createNumberFormatCompiler('uint32', isValidUInt32),
  int64: createNumberFormatCompiler('int64', isValidInt64),
  uint64: createNumberFormatCompiler('uint64', isValidUInt64),
  // floating point types
  float16: createNumberFormatCompiler('float16', isValidFloat16),
  float32: createNumberFormatCompiler('float32', isValidFloat32),
  float64: createNumberFormatCompiler('float64', isValidFloat64),
  float: createNumberFormatCompiler('float', isValidFloat32),
  double: createNumberFormatCompiler('double', isValidFloat64),
};
