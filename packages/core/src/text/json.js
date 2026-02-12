//#region JSON validation
// JSON whitespace characters: space, tab, newline, carriage return
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0A, 0x0D]);

export function isValidJSONCheap(data) {
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
//#endregion

//#region JPtr Tests
// JSON-pointer: https://tools.ietf.org/html/rfc6901
const CONST_REGEXP_JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
export function isValidJSONPointer(str) {
  return CONST_REGEXP_JSON_POINTER.test(str);
}

// uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
const CONST_REGEXP_JSON_POINTER_URI_FRAGMENT = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
export function isValidJSONPointerUriFragment(str) {
  return CONST_REGEXP_JSON_POINTER_URI_FRAGMENT.test(str);
}

// relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
const CONST_REGEXP_RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
export function isValidRelativeJSONPointer(str) {
  return CONST_REGEXP_RELATIVE_JSON_POINTER.test(str);
}
//#endregion

//#region JSONPath Tests (RFC 9535)
// JSONPath syntax: https://www.rfc-editor.org/rfc/rfc9535.html

// Basic JSONPath structure:
// $                         - root
// $.store.book[0].title     - dot notation with array index
// $['store']['book'][0]     - bracket notation  
// $..name                   - recursive descent
// $.*                       - wildcard
// $[?(@.price < 10)]        - filter expression
// $[0:5:2]                  - slice
// $[0,1,2]                  - multiple indices

// Simplified regex that covers common JSONPath patterns
// This validates the structure without fully parsing filter expressions
// Pattern breakdown:
//   (\$|@) - starts with $ or @
//   (?:\.\.[a-zA-Z_][a-zA-Z0-9_]*| - recursive descent with name (e.g., $..name)
//   \.\.| - recursive descent (e.g., $..)
//   \.[a-zA-Z_][a-zA-Z0-9_]*| - dot notation (e.g., $.store)
//   \.[*]| - dot wildcard (e.g., $.*)
//   \[\s*(?:'[^']*'|"[^"]*"|\d+|\*|\?[^\]]*|\d*:\d*(?::\d*)?)\s*\] - bracket notation
const CONST_REGEXP_JSONPATH = /^(\$|@)(?:\.\.[a-zA-Z_][a-zA-Z0-9_]*|\.\.|\.[a-zA-Z_][a-zA-Z0-9_]*|\.[*]|\[\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\d+|\*|\?[^\]]*|\d*:\d*(?::\d*)?|\d+(?:\s*,\s*\d+)*\s*)\s*\])*$/;

/**
 * Validates a JSONPath expression string per RFC 9535.
 * 
 * JSONPath syntax includes:
 * - $ - root node selector
 * - @ - current node selector (used in filter expressions)
 * - .name - dot notation for child member
 * - ['name'] or ["name"] - bracket notation for child member
 * - [index] - array index
 * - [*] - wildcard selector
 * - [start:end:step] - array slice
 * - [?expression] - filter expression
 * - .. - recursive descent
 * 
 * @param {string} str - The JSONPath expression to validate
 * @returns {boolean} - True if the string is a valid JSONPath expression
 * @example
 * isValidJSONPath('$.store.book[0].title'); // true
 * isValidJSONPath('$..name'); // true
 * isValidJSONPath('$[*]'); // true
 * isValidJSONPath('$[?(@.price < 10)]'); // true
 * isValidJSONPath('$.store.book[0:5]'); // true
 * isValidJSONPath('@.name'); // true (current node selector)
 * isValidJSONPath('store'); // false (must start with $ or @)
 * isValidJSONPath(''); // false (empty string)
 */
export function isValidJSONPath(str) {
  if (typeof str !== 'string')
    return false;

  // Must start with $ (root) or @ (current node in filters)
  if (!str || (str[0] !== '$' && str[0] !== '@'))
    return false;

  // Single $ or @ is valid
  if (str.length === 1)
    return true;

  // Use the regex for basic validation
  if (!CONST_REGEXP_JSONPATH.test(str))
    return false;

  // Additional validation for bracket contents
  return validateJSONPathBrackets(str);
}

/**
 * Validates that brackets in JSONPath are balanced and well-formed
 * @param {string} str - The JSONPath string to validate
 * @returns {boolean} - True if brackets are valid
 * @private
 */
function validateJSONPathBrackets(str) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (inString) {
      if (char === stringChar) {
        inString = false;
        stringChar = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      inString = char;
      stringChar = char;
      continue;
    }

    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth < 0)
        return false; // Unbalanced brackets
    }
  }

  return depth === 0 && !inString;
}
//#endregion
