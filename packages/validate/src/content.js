import {
  getStringType,
  isStringType,
} from '@jarenjs/core';
import { trueThat } from '@jarenjs/core/function';

import {
  isValidBase64,
} from '@jarenjs/core/text';

// Fast base64 validation - inline for performance
// Valid base64 chars: A-Z (65-90), a-z (97-122), 0-9 (48-57), + (43), / (47)
function isValidBase64Fast(str) {
  const len = str.length;
  if (len === 0 || len % 4 !== 0) return false;

  // Check all characters except padding
  const mainLen = len - 2;
  for (let i = 0; i < mainLen; i++) {
    const code = str.charCodeAt(i);
    // A-Z, a-z, 0-9, +, /
    if (!((code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          (code >= 48 && code <= 57) ||
          code === 43 || code === 47)) {
      return false;
    }
  }

  // Check last 2 characters (may include padding)
  const c1 = str.charCodeAt(len - 2);
  const c2 = str.charCodeAt(len - 1);

  // Last char can be =, A-Z, a-z, 0-9, +, /
  if (!(c2 === 61 || (c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122) ||
        (c2 >= 48 && c2 <= 57) || c2 === 43 || c2 === 47)) return false;

  // Second to last can be = (only if last is also =), A-Z, a-z, 0-9, +, /
  if (c1 === 61) return c2 === 61;
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122) ||
        (c1 >= 48 && c1 <= 57) || c1 === 43 || c1 === 47)) return false;

  return true;
}

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

// JSON whitespace characters: space, tab, newline, carriage return
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0A, 0x0D]);

function isValidJSONCheap(data) {
  const len = data.length;
  // Too short to be valid JSON object/array
  if (len < 2) return true;

  // Must start with { or [
  const first = data.charCodeAt(0);
  if (first !== 0x7B && first !== 0x5B) return true; // '{' or '['

  // Find last non-whitespace character (JSON allows trailing whitespace)
  let lastIdx = len - 1;
  while (lastIdx >= 0) {
    const code = data.charCodeAt(lastIdx);
    if (!JSON_WHITESPACE.has(code)) break;
    lastIdx--;
  }

  // Must end with } or ]
  const last = data.charCodeAt(lastIdx);
  if (last !== 0x7D && last !== 0x5D) return true; // '}' or ']'

  // Check matching brackets
  if (first === 0x7B && last !== 0x7D) return true; // {} must match
  if (first === 0x5B && last !== 0x5D) return true; // [] must match

  return false;
}

export function isValidJSON(data) {
  if (isValidJSONCheap(data)) return false;

  try {
    JSON.parse(data);
    return true;
  } catch {
    return false;
  }
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
