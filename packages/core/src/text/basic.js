const CONST_REGEXP_ALPHA = /^[a-zA-Z]+$/;
export function isValidAlpha(str) {
  return CONST_REGEXP_ALPHA.test(str);
}
const CONST_REGEXP_ALPHANUMERIC = /^[a-zA-Z0-9]+$/;
export function isValidAlphaNumeric(str) {
  return CONST_REGEXP_ALPHANUMERIC.test(str);
}

const CONST_REGEXP_NUMERIC = /^[0-9]+$/;
export function isValidNumeric(str) {
  return CONST_REGEXP_NUMERIC.test(str);
}

const CONST_REGEXP_HEXADECIMAL = /^[a-fA-F0-9]+$/;
export function isValidHexaDecimal(str) {
  return CONST_REGEXP_HEXADECIMAL.test(str);
}

const CONST_REGEXP_HEXCOLOR = /^#(?:[0-9a-f]{3}){1,2}\b$/i;
export function isValidHexColor(str) {
  return CONST_REGEXP_HEXCOLOR.test(str);
}
