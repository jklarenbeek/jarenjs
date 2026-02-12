// file: ./packages/core/src/text/identifiers.js

const CONST_REGEXP_UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isValidUUID(str) {
  // uuid: http://tools.ietf.org/html/rfc4122
  return CONST_REGEXP_UUID.test(str);
}

const CONST_REGEXP_GUID = /^({)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isValidGUID(str) {
  return CONST_REGEXP_GUID.test(str);
}

const CONST_REGEXP_IDENTIFIER = /^[_a-zA-Z]+\w{0,30}$/;
export function isValidIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_IDENTIFIER.test(str);
}

const CONST_REGEXP_HTML_IDENTIFIER = /^[A-Za-z]+[\w\-\:\.]{0,30}$/;
export function isValidHtmlIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_HTML_IDENTIFIER.test(str);
}

const CONST_REGEXP_CSS_IDENTIFIER = /^-?[_a-zA-Z]+[\w-]{0,30}$/;
export function isValidCssIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_CSS_IDENTIFIER.test(str);
}
