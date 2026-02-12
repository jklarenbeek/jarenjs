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
