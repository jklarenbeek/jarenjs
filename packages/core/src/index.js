//@ts-check
export function isFn(data) {
  return typeof data === 'function';
}

//#region Scalar Tests
function isScalarTypeEx(typeName) {
  switch (typeName) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'integer':
    case 'bigint':
      return true;
    default:
      return false;
  }
}

export function isScalarType(data) {
  return data != null && isScalarTypeEx(typeof data);
}

export function isStringType(data) {
  return typeof data === 'string';
}

/**
 * Checks if the given data is of boolean type.
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is a boolean, otherwise false.
 */
export function isBooleanType(data) {
  return data === true || data === false;
}

/**
 * Checks if the given data is of number type.
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is a number, otherwise false.
 */
export function isNumberType(data) {
  return data != null && typeof data === 'number';
}

/**
 * Checks if the given data is an integer type.
 * @param {any} data - The data to check.
 * @returns {boolean} - True if the data is an integer, otherwise false.
 */
export function isIntegerType(data) {
  return Number.isInteger(data);
}

export function isBigIntType(data) {
  return typeof data === 'bigint';
}

//#endregion

//#region Scalar Getters
export function getScalarNormalised(value, defaultValue = undefined, nullable = false) {
  return value == null
    ? nullable
      ? value
      : defaultValue
    : isScalarType(value)
      ? value
      : defaultValue;
}

export function getStringType(obj, def = undefined) {
  return isStringType(obj) ? obj : def;
}

/**
 * Checks if the given object is a boolean type and returns it, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {boolean|undefined} [def=undefined] - The default value to return if the object is not a boolean.
 * @returns {boolean|undefined} - The boolean value or the default value.
 */
export function getBooleanType(obj, def = undefined) {
  return isBooleanType(obj) ? obj : def;
}

/**
 * Checks if the given object is a number type and returns it, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {number|undefined} [def=undefined] - The default value to return if the object is not a number.
 * @returns {number|undefined} - The number value or the default value.
 */
export function getNumberType(obj, def = undefined) {
  return isNumberType(obj) ? obj : def;
}

/**
 * Checks if the given object is an integer type and returns it, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {number|undefined} [def=undefined] - The default value to return if the object is not an integer.
 * @returns {number|undefined} - The integer value or the default value.
 */
export function getIntegerType(obj, def = undefined) {
  return isIntegerType(obj) ? obj : def;
}

/**
 * Checks if the given object is a bigint type and returns it, otherwise returns the default value.
 * @param {any} obj - The object to check.
 * @param {bigint|undefined} [def=undefined] - The default value to return if the object is not a bigint.
 * @returns {bigint|undefined} - The bigint value or the default value.
 */
export function getBigIntType(obj, def = undefined) {
  return isBigIntType(obj)
    ? obj
    : def;
}
//#endregion

//#region Object Tests
export function isNullValue(data) {
  return data === null;
}

export function isObjectOfClass(data, type) {
  return data != null && data.constructor === type;
}

/**
 * @brief test if data is object literal
 * @param {*} data the data to test
 * @returns boolean
 */
export function isObjectClass(data) {
  return isObjectOfClass(data, Object);
}

export function isMapClass(data) {
  return isObjectOfClass(data, Map);
}

/**
 * @brief test if data is typeof object but not an Array
 * @param {*} data the data to test
 * @returns boolean
 */
export function isObjectType(data) {
  return data != null
    && typeof data === 'object'
    && data.constructor !== Array;
}

export function isArrayClass(data) {
  return isObjectOfClass(data, Array);
}

export function isSetClass(data) {
  return isObjectOfClass(data, Set);
}

export const TypedArray = Object.getPrototypeOf(Uint8Array);
export function isTypedArray(data) {
  if (data == null)
    return false;
  const proto = data.__proto__.__proto__;
  return proto != null && proto.constructor === TypedArray;
}
//#endregion

//#region Object Getters
export function getObjectType(obj, def = undefined) {
  return isObjectClass(obj) ? obj : def;
}

export function getArrayClass(obj, def = undefined) {
  return isArrayClass(obj) ? obj : def;
}
//#endregion

export function getInclusiveExclusiveBounds(getType, inclusive, exclusive) {
  const includes = getType(inclusive);
  const excludes = exclusive === true
    ? includes
    : getType(exclusive);
  return (excludes === undefined)
    ? [includes, undefined]
    : [undefined, excludes];
}
