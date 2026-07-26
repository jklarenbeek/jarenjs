//@ts-check

// Base64 (RFC 4648 section 4): groups of four characters from the
// standard alphabet, with the final group optionally padded to four by
// one or two "=". Three padding characters, or padding anywhere but at
// the end, are not Base64 - which is what separates this from the
// length-and-charset approximations it is easy to reach for.
const CONST_REGEXP_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/;

/**
 * Validate a Base64-encoded string (RFC 4648).
 * @param {string} str - The candidate encoding
 * @returns {boolean} True when the string is well-formed Base64
 */
export function isValidBase64(str) {
  return CONST_REGEXP_BASE64.test(str);
}
