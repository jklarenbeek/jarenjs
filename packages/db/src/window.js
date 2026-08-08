//@ts-check
/**
 * @file The maintained sorted window for `orderBy` (+ optional
 * `limit`) live queries — LIVE-FORMAT §7's window row. The structure
 * keeps EVERY matching row in sorted order (which is what makes a
 * delete inside the visible window answerable without a re-query: the
 * successor is already here), and the visible result is the first
 * `limit` entries. Ties are broken by the collection key token,
 * always ascending — the total order LIVE-FORMAT §9 promises.
 *
 * String comparison is CODEPOINT order (SQLite BINARY over UTF-8 —
 * probed, never assumed), which `<` on JS strings gets wrong for
 * astral-vs-BMP pairs; `compareCodepoint` walks code points.
 */

/**
 * Compare two strings in Unicode code-point order.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCodepoint(a, b) {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length;) {
    const ca = /** @type {number} */ (a.codePointAt(i));
    const cb = /** @type {number} */ (b.codePointAt(i));
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * Compare two sort VALUES of one order term. Absent (`undefined`)
 * ranks per `emptyGreatest` as the greatest or least value; direction
 * is applied by the caller. Mixed types rank number-before-string —
 * deterministic on hostile data, exact on schema-conformant data (the
 * same precondition the pushdown ordering documents).
 * @param {any} a
 * @param {any} b
 * @param {boolean} emptyGreatest
 * @returns {number}
 */
function compareValues(a, b, emptyGreatest) {
  const aEmpty = a === undefined;
  const bEmpty = b === undefined;
  if (aEmpty || bEmpty) {
    if (aEmpty && bEmpty) return 0;
    return (aEmpty ? 1 : -1) * (emptyGreatest ? 1 : -1);
  }
  const aNumber = typeof a === 'number';
  const bNumber = typeof b === 'number';
  if (aNumber && bNumber) return a < b ? -1 : a > b ? 1 : 0;
  if (aNumber !== bNumber) return aNumber ? -1 : 1;
  return compareCodepoint(String(a), String(b));
}

/**
 * @typedef {{ token: string, sortValues: any[], item: any }} WindowEntry
 */

/**
 * A maintained sorted set of rows under the declared order terms plus
 * the key-token tiebreaker.
 * @param {{ desc: boolean, emptyGreatest: boolean }[]} terms
 * @param {number | null} limit - visible size; `null` = everything
 */
export function createSortedWindow(terms, limit) {
  /** @type {WindowEntry[]} */
  const entries = [];
  /** @type {Map<string, WindowEntry>} */
  const byToken = new Map();

  /**
   * @param {WindowEntry} a
   * @param {WindowEntry} b
   */
  const compare = (a, b) => {
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const cmp = compareValues(a.sortValues[i], b.sortValues[i], term.emptyGreatest);
      if (cmp !== 0) return term.desc ? -cmp : cmp;
    }
    return compareCodepoint(a.token, b.token);
  };

  /** Binary search for the insertion index of `entry`. */
  const positionOf = (entry) => {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(entries[mid], entry) < 0) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  return {
    compare,
    size: () => entries.length,
    /** The visible slice: the first `limit` entries (all, unbounded). */
    visible: () => (limit === null ? [...entries] : entries.slice(0, limit)),
    /**
     * Insert a row; the token MUST not be present.
     * @param {string} token
     * @param {any[]} sortValues
     * @param {any} item
     */
    insert(token, sortValues, item) {
      const entry = { token, sortValues, item };
      entries.splice(positionOf(entry), 0, entry);
      byToken.set(token, entry);
    },
    /** Remove a row by token; absent tokens are a no-op. */
    remove(token) {
      const entry = byToken.get(token);
      if (entry === undefined) return false;
      entries.splice(entries.indexOf(entry), 1);
      byToken.delete(token);
      return true;
    },
  };
}
