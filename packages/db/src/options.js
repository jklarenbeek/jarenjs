//@ts-check
/**
 * @file The one refusal rule every closed option set in this package
 * shares (MODEL-FORMAT §4, §5): a member outside the set is refused
 * before any effect — no handle opened, no file created, no statement
 * run — and the refusal names the member the caller most plausibly
 * meant. `openStore` (`JD0009`), the transaction surfaces (`JD0013`)
 * and the PostgreSQL driver (`JD0003`) each raise their own code through
 * it; the nearest-name judgement exists once.
 */

/**
 * The known name a misspelt one most plausibly meant, or `undefined`.
 * Close means either of two things, compared case-insensitively: one
 * spelling is a prefix of the other (`captur` → `capture`, `modes` →
 * `mode`), or the two are within a small edit distance
 * (`statmentTimeoutMs` → `statementTimeoutMs`) — at most one edit for a
 * name of four characters or fewer, two otherwise, so a short name is
 * not "corrected" into an unrelated one. A prefix match wins, in the
 * order `known` lists the names; otherwise the smallest distance does.
 * @param {string} key
 * @param {readonly string[]} known
 * @returns {string | undefined}
 */
export function nearestName(key, known) {
  const lower = key.toLowerCase();
  const prefix = known.find((name) => {
    const other = name.toLowerCase();
    return other.startsWith(lower) || lower.startsWith(other);
  });
  if (prefix !== undefined) return prefix;
  const limit = lower.length <= 4 ? 1 : 2;
  let best;
  let bestDistance = limit + 1;
  for (const name of known) {
    const distance = editDistance(lower, name.toLowerCase(), limit);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Refuse the first member of `options` outside `known`, through the
 * caller's own coded error; the hint names the nearest member, or lists
 * the set when nothing is close.
 * @param {Record<string, any>} options
 * @param {readonly string[]} known
 * @param {(key: string, hint: string) => Error} refusal
 */
export function refuseUnknownMembers(options, known, refusal) {
  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;
    const near = nearestName(key, known);
    throw refusal(key, near === undefined
      ? `; the options are ${known.join(', ')}`
      : ` — did you mean '${near}'?`);
  }
}

/**
 * Whether `value` is a plain options object: an object literal or a
 * null-prototype record, never an array, a class instance or a string.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Optimal-string-alignment distance (a transposition counts as one
 * edit), abandoned early once every cell of a row exceeds `limit`.
 * @param {string} a
 * @param {string} b
 * @param {number} limit
 * @returns {number} the distance, or `limit + 1` when it exceeds `limit`
 */
function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  /** @type {number[]} */
  let beforePrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, beforePrevious[j - 2] + 1);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return Math.min(previous[b.length], limit + 1);
}
