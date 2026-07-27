//#region internal helpers shared by the JOSL and JSONX readers

// The date-time token patterns of both readers. Sticky (`y`) so they
// match in place at the current position without slicing the logical
// line. They live here because the JOSL machine and the JSONX scalar
// reader lex the same tokens: two copies drifting apart would give one
// syntax two date grammars.
//
// The capture groups are the readers' contract: 1-3 date, 4-6 clock,
// 7 the fraction INCLUDING its leading dot, 8 the offset. The fraction
// is captured as text on purpose - JOSL round-trips a document, so
// `00.100` must not come back `00.1`.

/** `YYYY-MM-DD` with an optional time half. @type {RegExp} */
export const RE_DATETIME = /(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/y;

/** A bare `HH:MM:SS` with an optional fraction. @type {RegExp} */
export const RE_TIMEONLY = /(\d{2}):(\d{2}):(\d{2})(\.\d+)?/y;

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
