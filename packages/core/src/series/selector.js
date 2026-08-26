//@ts-check

//#region Reading a source row
// Where a member lives in a caller's row, and nothing else.
//
// Timestamped rows almost never arrive spelled `{ at, value }` or
// `{ start, end }`. They come out of a document as `on`, out of a
// database as `recorded_at`, out of a booking system as `from`/`to`. A
// selector is either that member's name or a function of the row, so
// nothing has to be rewritten into the canonical shape before it can be
// normalized or indexed.
//
// This module imports nothing on purpose: it is the leaf both the
// normalizer and the index stand on.

/**
 * A reader for one member of a source row.
 * @param {string | ((item: any, index: number) => any)} spec - a
 *   property name, or a function of the row and its position
 * @param {string} role - the member's name, for the message
 * @returns {(item: any, index: number) => any}
 * @throws {TypeError} when `spec` is neither
 */
export function selectorOf(spec, role) {
  if (typeof spec === 'string')
    return (item) => item[spec];
  if (typeof spec === 'function')
    return spec;
  throw new TypeError(`the '${role}' selector is a property name or a function`);
}

/**
 * The row at `index`, confirmed to be something with members to read.
 * @param {any} item
 * @param {number} index
 * @returns {any}
 * @throws {TypeError} when it is not an object
 */
export function requireRow(item, index) {
  if (item === null || typeof item !== 'object')
    throw new TypeError(`row ${index} is not an object`);
  return item;
}

//#endregion

//#region Reading a specification
// A specification is closed, and a member nobody admitted is a refusal.
//
// `minPeriod` for `minPeriods` silently ignored is the bug that takes
// an afternoon: the window still answers, the number is still
// plausible, and it was computed from a specification nobody wrote.
// The zone members are worse — a named zone with NO provider refuses
// (`zone.js`), so the only way left to reach a quiet UTC ladder is to
// misspell the member that refusal keys on, and UTC is right for
// Amsterdam for none of the year while looking right for eight months
// of it.
//
// The near miss is named because that is the whole cost of the bug:
// same first letter and a length within two, or a case-folded match.
// It never guesses when nothing is close.

/**
 * The nearest admitted member to a misspelling.
 * @param {string} name
 * @param {readonly string[]} allowed
 * @returns {string} `''`, or ` (did you mean 'x'?)`
 */
function nearMiss(name, allowed) {
  const lower = name.toLowerCase();
  for (const candidate of allowed) {
    const other = candidate.toLowerCase();
    if (other === lower
      || (other.startsWith(lower) && other.length - lower.length <= 2)
      || (lower.startsWith(other) && lower.length - other.length <= 2))
      return ` (did you mean '${candidate}'?)`;
  }
  return '';
}

/**
 * One specification, confirmed to name only admitted members.
 * @param {any} spec - the caller's specification object
 * @param {readonly string[]} allowed - the closed member list
 * @param {string} kernel - the function's name, for the message
 * @param {string} shape - what the specification is, for the message
 *   when it is not an object at all
 * @returns {any} the same object
 * @throws {TypeError} when it is not an object, or names a member the
 *   kernel does not admit
 */
export function requireSpecMembers(spec, allowed, kernel, shape) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec))
    throw new TypeError(shape);
  for (const name of Object.keys(spec)) {
    if (!allowed.includes(name)) {
      throw new TypeError(`${kernel} has no specification member '${name}'${
        nearMiss(name, allowed)}; it admits ${allowed.map((m) => `'${m}'`).join(', ')}`);
    }
  }
  return spec;
}

//#endregion
