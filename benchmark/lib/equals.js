//#region benchmark result equivalence
// NOT core's `equalsDeep` on purpose: that helper gates on
// `constructor` identity, and rival engines return values that fail it
// while being JSON-equal - jsonata builds its result objects with null
// prototypes (`constructor` undefined) and marks result arrays with an
// own `sequence` member. Equivalence here must judge the JSON *shape*
// only, so this comparator looks at typeof/Array.isArray and enumerable
// keys and nothing else.

/**
 * JSON-shape deep equality: index-by-index for arrays, own enumerable
 * keys for objects, `===` for scalars.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function deepEquals(a, b) {
  if (a === b)
    return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return false;
  if (aIsArray) {
    if (a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i]))
        return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length)
    return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || !deepEquals(a[key], b[key]))
      return false;
  }
  return true;
}

//#endregion
