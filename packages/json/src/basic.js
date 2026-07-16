import {
  CC_SLASH,
  CC_HASH,
  CC_PERCENT,
  CC_TILDE,
  CC_0,
  CC_1,
  isDigitCode,
  isHexDigitCode,
} from '@jarenjs/core/scan';

//#region JSON validation
// JSON whitespace characters: space, tab, newline, carriage return
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0A, 0x0D]);

export function isValidJSONCheap(data) {
  const len = data.length;
  // Too short to be valid JSON (minimum is 2 for {} or [])
  if (len < 2) return true; // Definitely NOT valid JSON

  // Check first char
  const first = data.charCodeAt(0);

  // Objects and arrays - check matching brackets
  if (first === 0x7B || first === 0x5B) { // '{' or '['
    // Find last non-whitespace character (JSON allows trailing whitespace)
    let lastIdx = len - 1;
    while (lastIdx >= 0) {
      const code = data.charCodeAt(lastIdx);
      if (!JSON_WHITESPACE.has(code)) break;
      lastIdx--;
    }

    // Must end with matching bracket
    const last = data.charCodeAt(lastIdx);
    if (first === 0x7B && last !== 0x7D) return true; // {} must match - definitely NOT valid
    if (first === 0x5B && last !== 0x5D) return true; // [] must match - definitely NOT valid

    // Looks like JSON object/array, might be valid
    return false;
  }

  // Check if first char is a valid JSON starting character:
  // '"' (0x22) for strings, '-' (0x2D) or digit (0x30-0x39) for numbers,
  // 't' (0x74) for true, 'f' (0x66) for false, 'n' (0x6E) for null
  const isValidStart = (
    first === 0x22 || // '"'
    first === 0x2D || // '-'
    (first >= 0x30 && first <= 0x39) || // '0'-'9'
    first === 0x74 || // 't' (true)
    first === 0x66 || // 'f' (false)
    first === 0x6E    // 'n' (null)
  );

  // If it starts with a valid JSON character, it might be valid JSON
  // Return false to indicate "might be JSON, need to parse"
  if (isValidStart) return false;

  // Doesn't start with valid JSON character - definitely NOT valid JSON
  return true;
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
// Single-pass char-code scanners (no regex, no allocation), shared by the
// `json-pointer`/`relative-json-pointer` string formats.

// scan the pointer body `str[pos..)`: '/'-delimited segments where every
// '~' must be followed by '0' or '1' (RFC 6901 section 3)
function isValidPointerBody(str, pos) {
  const len = str.length;
  for (; pos < len; pos++) {
    if (str.charCodeAt(pos) === CC_TILDE) {
      const d = pos + 1 < len ? str.charCodeAt(pos + 1) : -1;
      if (d !== CC_0 && d !== CC_1)
        return false;
      pos++;
    }
  }
  return true;
}

// JSON-pointer: https://tools.ietf.org/html/rfc6901
export function isValidJSONPointer(str) {
  if (typeof str !== 'string')
    return false;
  if (str.length === 0)
    return true;
  if (str.charCodeAt(0) !== CC_SLASH)
    return false;
  return isValidPointerBody(str, 1);
}

// unreserved / sub-delims / ':' / '@' per RFC 3986 pchar, minus the
// pointer-significant '~' and '/' handled by the caller
function isFragmentPointerCode(c) {
  return (c >= 0x61 && c <= 0x7A) // a-z
    || (c >= 0x41 && c <= 0x5A) // A-Z
    || isDigitCode(c)
    || (c >= 0x26 && c <= 0x2E) // & ' ( ) * + , - .
    || c === 0x21 // !
    || c === 0x24 // $
    || c === 0x3A // :
    || c === 0x3B // ;
    || c === 0x3D // =
    || c === 0x40 // @
    || c === 0x5F; // _
}

// uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
export function isValidJSONPointerUriFragment(str) {
  if (typeof str !== 'string')
    return false;
  const len = str.length;
  if (len === 0 || str.charCodeAt(0) !== CC_HASH)
    return false;
  if (len > 1 && str.charCodeAt(1) !== CC_SLASH)
    return false;
  for (let pos = 1; pos < len; pos++) {
    const c = str.charCodeAt(pos);
    if (c === CC_SLASH || isFragmentPointerCode(c))
      continue;
    if (c === CC_PERCENT) { // percent-encoded octet
      if (pos + 2 >= len
        || !isHexDigitCode(str.charCodeAt(pos + 1))
        || !isHexDigitCode(str.charCodeAt(pos + 2)))
        return false;
      pos += 2;
      continue;
    }
    if (c === CC_TILDE) {
      const d = pos + 1 < len ? str.charCodeAt(pos + 1) : -1;
      if (d !== CC_0 && d !== CC_1)
        return false;
      pos++;
      continue;
    }
    return false;
  }
  return true;
}

// relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
export function isValidRelativeJSONPointer(str) {
  if (typeof str !== 'string')
    return false;
  const len = str.length;
  if (len === 0)
    return false;
  const first = str.charCodeAt(0);
  if (!isDigitCode(first))
    return false;
  let pos = 1;
  if (first !== CC_0) {
    while (pos < len && isDigitCode(str.charCodeAt(pos)))
      pos++;
  }
  if (pos === len)
    return true;
  const c = str.charCodeAt(pos);
  if (c === CC_HASH)
    return pos + 1 === len;
  if (c !== CC_SLASH)
    return false;
  return isValidPointerBody(str, pos + 1);
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
const CONST_REGEXP_JSONPATH = /^(\$|@)(?:\.\.[a-zA-Z_][a-zA-Z0-9_]*|\.\.|\.[a-zA-Z_][a-zA-Z0-9_]*|\.[*]|\[\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\d+|\*|\?[^\]]*|\d*:\d*(?::\d*)?|\d+(?:\s*,\s*\d+)*|'(?:[^'\\]|\\.)*'(?:\s*,\s*'(?:[^'\\]|\\.)*')*|\"(?:[^"\\]|\\.)*\"(?:\s*,\s*\"(?:[^"\\]|\\.)*\")*)\s*\])*$/;

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
