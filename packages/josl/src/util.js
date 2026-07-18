//#region internal helpers shared by the JOSL and JSONX readers

/**
 * Assign an own enumerable property without ever touching the prototype
 * chain. LLM-produced documents may legitimately contain a `__proto__`
 * key; plain assignment would silently poison the object.
 * @param {object} obj - Target object
 * @param {string} key - Member name (any string)
 * @param {*} value - Value to assign
 */
export function setKey(obj, key, value) {
  if (key === '__proto__')
    Object.defineProperty(obj, key, {
      value, writable: true, enumerable: true, configurable: true,
    });
  else
    obj[key] = value;
}

/**
 * Read an own property, ignoring the prototype chain.
 * @param {object} obj - Source object
 * @param {string} key - Member name
 * @returns {*} The own value or undefined
 */
export function getOwn(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Count '\n' occurrences in a string.
 * @param {string} str - Input text
 * @param {number} [end] - Exclusive end offset (defaults to full length)
 * @returns {number} Number of newlines before `end`
 */
export function countNewlines(str, end = str.length) {
  let n = 0;
  for (let i = 0; i < end; ++i)
    if (str.charCodeAt(i) === 0x0A)
      n++;
  return n;
}

/**
 * Compute the 1-based column of `pos` inside `str` (columns restart after
 * every newline; multi-line logical lines report positions within them).
 * @param {string} str - Input text
 * @param {number} pos - Offset into the text
 * @returns {number} 1-based column number
 */
export function columnOf(str, pos) {
  const nl = str.lastIndexOf('\n', pos - 1);
  return pos - nl;
}

//#endregion
