const CONST_REGEXP_BASE64 = /^(?:[a-zA-Z0-9+\/]{4})*(?:|(?:[a-zA-Z0-9+\/]{3}=)|(?:[a-zA-Z0-9+\/]{2}==)|(?:[a-zA-Z0-9+\/]{1}===))$/;
export function isValidBase64Full(str) {
  return CONST_REGEXP_BASE64.test(str);
}

// Base64 validation regex (RFC 4648)
const BASE64_REGEX_SHORT = /^[A-Za-z0-9+/]*={0,2}$/;

export function isValidBase64Old(str) {
  // Check length is valid for base64 (multiple of 4)
  if (str.length % 4 !== 0) return false;
  // Check characters are valid base64
  if (!BASE64_REGEX_SHORT.test(str)) return false;
  return true;
}

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

export function isValidBase64(str) {
  return BASE64_REGEX.test(str);
}

// Fast base64 validation - inline for performance
// Valid base64 chars: A-Z (65-90), a-z (97-122), 0-9 (48-57), + (43), / (47)
export function isValidBase64Fast(str) {
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

