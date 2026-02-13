import {
  getStringType,
  isStringType,
} from '@jarenjs/core';

import {
  isValidBase64Fast,
} from '@jarenjs/core/text';

import {
  isValidJSON,
} from '@jarenjs/core/json';

export function compileContentEncoding(schemaObj, jsonSchema) {
  const encoding = getStringType(jsonSchema.contentEncoding);
  if (encoding == null) return undefined;

  const addError = schemaObj.createErrorHandler(encoding, 'contentEncoding');

  if (encoding === 'base64') {
    return function validateBase64(data, dataPath) {
      // contentEncoding only applies to strings - ignore non-strings
      if (!isStringType(data)) return true;
      return isValidBase64Fast(data)
        || addError(data, dataPath);
    };
  }

  // Unknown encoding - treat as valid (per JSON Schema spec)
  return undefined;
}

export function compileContentMediaType(schemaObj, jsonSchema) {
  const mediaType = getStringType(jsonSchema.contentMediaType);
  if (mediaType == null) return undefined;

  // Check if contentEncoding is also specified
  const encoding = getStringType(jsonSchema.contentEncoding);

  const addError = schemaObj.createErrorHandler(mediaType, 'contentMediaType');

  if (mediaType === 'application/json') {
    if (encoding == null) {
      return function validateJsonContent(data, dataPath) {
        if (!isStringType(data)) return true;
        return isValidJSON(data) || addError(data, dataPath);
      };
    }
    else {
      return function validateBase64JsonContent(data, dataPath) {
        if (!isStringType(data)) return true;
        // Check valid base64 first before decoding
        if (!isValidBase64Fast(data)) return addError(data, dataPath);
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        return isValidJSON(decoded) || addError(data, dataPath);
      }
    }
  }

  // Unknown media type - treat as valid (per JSON Schema spec)
  return undefined;
}

export function compileContentSchema(schemaObj, jsonSchema) {
  const encoding = getStringType(jsonSchema.contentEncoding);
  const mediaType = getStringType(jsonSchema.contentMediaType);

  if (encoding == null && mediaType == null) return undefined;

  const contentEncodingValidator = compileContentEncoding(schemaObj, jsonSchema);
  const contentMediaTypeValidator = compileContentMediaType(schemaObj, jsonSchema);

  if (!contentEncodingValidator && !contentMediaTypeValidator) return undefined;

  return contentMediaTypeValidator || contentEncodingValidator;
}
