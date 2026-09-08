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
 * Convert a local date and time with an offset to their native instant.
 * ISO parsing preserves years 0000-0099 and truncates sub-millisecond
 * precision consistently for JOSL and typed CSV. An invalid offset (or
 * an instant Date cannot represent) returns an invalid Date for the
 * caller's own refusal or text-preservation policy.
 * @param {import('./values.js').LocalDate} date - Validated calendar date
 * @param {import('./values.js').LocalTime} time - Validated local time
 * @param {string} offset - Z/z or a signed HH:MM offset
 * @returns {Date}
 */
export function offsetDateTime(date, time, offset) {
  return new Date(`${date.toString()}T${time.toString()}${offset.toUpperCase()}`);
}

/**
 * Run a sticky regex at `pos` and return its match (or null).
 * @param {RegExp} re - A sticky (`y`) pattern
 * @param {string} text - The text to match against
 * @param {number} pos - Position the match must start at
 * @returns {RegExpExecArray | null} The match, anchored at `pos`
 */
export function stickyExec(re, text, pos) {
  re.lastIndex = pos;
  return re.exec(text);
}

/**
 * Shared `feed(chunk)` body for the buffering stream machines (JOSL and
 * CSV): guard against feeding after `end()`, strip a leading BOM on the
 * first non-empty chunk, then buffer and scan. The JSONX stream reader
 * has its own `feed` on purpose - it pumps a token loop and models BOM
 * handling differently.
 * @template {{ ended: boolean, started: boolean, buf: string, scan: () => void }} T
 * @param {T} machine - The stream machine (`this` of its `feed`)
 * @param {string} chunk - Next piece of the document
 * @returns {T} The machine, for chaining
 */
export function feedMachine(machine, chunk) {
  if (machine.ended)
    throw new Error('cannot feed after end()');
  if (!machine.started && chunk.length !== 0) {
    machine.started = true;
    if (chunk.charCodeAt(0) === 0xFEFF)
      chunk = chunk.slice(1); // strip a leading BOM
  }
  if (chunk.length !== 0) {
    machine.buf += chunk;
    machine.scan();
  }
  return machine;
}

/**
 * Shared `parseAll(text)` prelude for the buffering stream machines:
 * reject mixing with `feed()`/`end()`, mark the machine started and
 * ended, and strip a leading BOM.
 * @param {{ ended: boolean, started: boolean }} machine - The stream machine
 * @param {string} text - The entire document
 * @returns {string} The text with any leading BOM removed
 */
export function beginParseAll(machine, text) {
  if (machine.started || machine.ended)
    throw new Error('parseAll cannot be mixed with feed()/end()');
  machine.started = true;
  machine.ended = true;
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
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
