//@ts-check

const JSON_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/**
 * Whether a string is exactly one JSON number (RFC 8259 section 6), with
 * no surrounding whitespace. This checks spelling only: `1e999` is valid
 * even though converting it to a JavaScript number overflows. Callers
 * choose their own conversion, finiteness and safe-integer policies.
 * @param {unknown} value - The value to check, without coercion
 * @returns {boolean} True for a string matching the complete number grammar
 */
export function isJsonNumberString(value) {
  return typeof value === 'string' && JSON_NUMBER_RE.test(value);
}

/**
 * Checks if the given data is of boolean type or boolean-like (the strings 'true' or 'false').
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is boolean or boolean-like, otherwise false.
 */
export function isBoolishType(data) {
  return data === true
    || data === false
    || data === 'true'
    || data === 'false';
}

/**
 * Checks if the given object is a boolean type or a boolean-like string ('true' or 'false') and returns it, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {boolean|undefined} [def=undefined] - The default value to return if the object is not a boolean or boolean-like string.
 * @returns {boolean|undefined} - The boolean/boolean-like value or the default value.
 */
export function getBoolishType(obj, def = undefined) {
  return isBoolishType(obj) || obj === 'true' || obj === 'false'
    ? obj
    : def;
}

/**
 * Checks if the given data is number-like (can be converted to a number).
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is number-like, otherwise false.
 */
export function isNumbishType(data) {
  return typeof data !== 'bigint' && !Number.isNaN(Number(data));
}

/**
 * Checks if the given data is an integer-like type.
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is an integer-like type, otherwise false.
 */
export function isIntishType(data) {
  return Number.isInteger(Number(data));
}

/**
 * Checks if the given object is a number-like type and returns it as a number, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {number|undefined} [def=undefined] - The default value to return if the object is not a number-like type.
 * @returns {number|undefined} - The number value or the default value.
 */
export function getNumbishType(obj, def = undefined) {
  return isNumbishType(obj) ? Number(obj) : def;
}

/**
 * Checks if the given object is an integer-like type and returns it as a number, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {number|undefined} [def=undefined] - The default value to return if the object is not an integer-like type.
 * @returns {number|undefined} - The integer value or the default value.
 */
export function getIntishType(obj, def = undefined) {
  return isIntishType(obj) ? Number(obj) : def;
}
