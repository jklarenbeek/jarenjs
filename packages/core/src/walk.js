//@ts-check
/**
 * @file The bounds the walks over a JSON value hold, and their refusals:
 * `equalsJson`, `stableStringify` and `semanticKey` (`./object.js`) walk at
 * most `JSON_WALK_DEPTH_CEILING` levels of nesting, the GeoJSON traversal
 * (`./geo/`) at most `GEOJSON_WALK_DEPTH_CEILING`, and a walk that reaches
 * its bound tells a cycle from a deep value here, so each refuses both
 * alike.
 * Internal to the package: not an entry of its `exports`.
 */

import { escapePointerToken } from './string.js';
import { CodedError } from './errors.js';

// The deepest nesting `equalsJson`, `stableStringify` and `semanticKey`
// walk (and the JSON Patch and Merge Patch diffs and
// the query keys of `@jarenjs/json`, which hold the same bound): past every nesting a default host stack could walk recursively,
// so no value that answered before is refused, and fixed, so a refusal is
// the same on every host.
export const JSON_WALK_DEPTH_CEILING = 10000;

// The deepest nesting the GeoJSON traversal walks. A walk of it on the
// host's stack took a whole collection, two levels (the collection and its
// list), or a whole Feature per frame, so on a default host stack it
// answered nests well past `JSON_WALK_DEPTH_CEILING` levels; the bound sits
// past them, so no value that answered on such a host is refused.
export const GEOJSON_WALK_DEPTH_CEILING = 100000;

// What a walk on its own stack throws on reaching the bound: the caller
// holds the root it needs to tell a cycle from a deep value, and turns it
// into `walkRefusal`.
export const WALK_CEILING = Object.freeze({ reached: JSON_WALK_DEPTH_CEILING });

/**
 * The refusal of a value nested past a walk's bound.
 * @param {string} verb - What could not be done, in the passive
 * @param {number} [ceiling] - The bound, `JSON_WALK_DEPTH_CEILING` unless
 *   the walk holds another
 * @returns {CodedError}
 */
export function walkTooDeep(verb, ceiling = JSON_WALK_DEPTH_CEILING) {
  return new CodedError('JsonDepthError', 'JO2001',
    `a value nested deeper than ${ceiling} levels cannot be ${verb}`);
}

/**
 * The refusal of a walk that reached `JSON_WALK_DEPTH_CEILING`. A walk
 * over a cycle reaches it too, so the roots are searched for one only
 * then, never on the way down: a cycle is named as one, located at the
 * member that closes it (`JsonCycleError` `JO2002`); a value without one
 * is as deep as the bound (`JO2001`).
 * @param {string} verb - What could not be done, in the passive
 * @param {any[]} roots - The values the walk started from
 * @param {string[]} [names] - Each root's name, for a walk over several
 * @param {number} [ceiling] - The bound the walk reached,
 *   `JSON_WALK_DEPTH_CEILING` unless it holds another
 * @returns {CodedError}
 */
export function walkRefusal(verb, roots, names = undefined, ceiling = JSON_WALK_DEPTH_CEILING) {
  for (let i = 0; i < roots.length; i++) {
    const at = locateCycleIn(roots[i], stableKeys, ceiling);
    if (at !== undefined)
      return new CodedError('JsonCycleError', 'JO2002',
        `a circular reference${names === undefined ? '' : ` in ${names[i]}`} cannot be ${verb}`, at);
  }
  return walkTooDeep(verb, ceiling);
}

/**
 * The JSON Pointer of the member that closes a cycle in `value`: the first
 * member whose value is a container already open above it, walking arrays
 * by index and object members in the sorted order `stableStringify` and
 * `canonicalizeJson` (`@jarenjs/json/canonical`) write them, so the three
 * name the same member. `undefined` for a value without a cycle, and for
 * one whose cycle lies past 10000 levels of nesting, the bound
 * `stableStringify` and `equalsJson` refuse at (`JO2001`).
 *
 * Every container is walked once: a member already searched without a
 * cycle is not searched again, so a value that shares a subtree many times
 * costs its size, not the number of its paths.
 * @param {unknown} value
 * @returns {string | undefined} The pointer, or `undefined` when there is none
 * @example
 * const doc = { items: [1] };
 * doc.items.push(doc);
 * locateCycle(doc); // '/items/1'
 * locateCycle({ a: [1, 2] }); // undefined
 */
export function locateCycle(value) {
  return locateCycleIn(value, stableKeys);
}

/** @param {object} object @returns {string[]} */
const stableKeys = (object) => Object.keys(object).sort();

/**
 * {@link locateCycle} over object members in the order `keysOf` names
 * them: the order of the walk that met the cycle.
 * @param {unknown} value
 * @param {(object: object) => string[]} keysOf
 * @param {number} [ceiling] - The nesting searched
 * @returns {string | undefined}
 */
export function locateCycleIn(value, keysOf, ceiling = JSON_WALK_DEPTH_CEILING) {
  if (value === null || typeof value !== 'object')
    return undefined;
  /** @type {Set<object>} */
  const open = new Set([value]);
  /** @type {Set<object>} */
  const searched = new Set();
  /** @param {any} container */
  const openFrame = (container) => ({ value: container, keys: Array.isArray(container) ? null : keysOf(container), at: 0 });
  // one frame per open container: `keys` is null for an array, `at` the
  // next member to search
  const frames = [openFrame(value)];
  for (;;) {
    const frame = frames[frames.length - 1];
    const size = frame.keys === null ? frame.value.length : frame.keys.length;
    if (frame.at < size) {
      const member = frame.value[frame.keys === null ? frame.at : frame.keys[frame.at]];
      frame.at++;
      if (member === null || typeof member !== 'object' || searched.has(member))
        continue;
      if (open.has(member))
        return frames.map((f) => '/' + (f.keys === null ? String(f.at - 1) : escapePointerToken(f.keys[f.at - 1]))).join('');
      if (frames.length >= ceiling)
        return undefined;
      open.add(member);
      frames.push(openFrame(member));
      continue;
    }
    open.delete(frame.value);
    searched.add(frame.value);
    frames.pop();
    if (frames.length === 0)
      return undefined;
  }
}
