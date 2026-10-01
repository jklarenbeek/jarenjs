//@ts-check
/**
 * @file `createJsonStateValidator()` — a `validateState` hook that keeps the
 * state JSON (APP-FORMAT §6) in time proportional to what a transition
 * changed, not to how large the state is.
 *
 * A patch-only transition hands the hook the patch engine's changed
 * pointers: one per write, the parent array for an insert or a removal that
 * shifts later elements, `''` for a write at the root. Every location the
 * transition did not write is the previous state's, checked when that state
 * was committed, so the hook checks what the pointers address and nothing
 * else:
 *
 *  - `changes === null` (boot, a transition carrying `state`, `setState`):
 *    the whole state;
 *  - `''`: the whole state;
 *  - a pointer that no longer addresses a location (a removal): passes;
 *  - any other pointer: the value there.
 *
 * The limit is the patch engine's: an insert or a removal that shifts an
 * array reports the array, so that array is checked whole. Large read-only
 * data belongs outside the state (APP-FORMAT §6), where nothing walks it.
 */

import { createBoundedCache } from '@jarenjs/core/cache';
import { isJsonValue } from '@jarenjs/core/object';
import { compileJSONPointer, encodeJSONPointerSegment, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';

/** Compiled pointers kept per validator: a list's element pointers are
 * many, and the least recently used one is the one to drop. */
const POINTER_CACHE_LIMIT = 1024;

/**
 * The verdict for a value that is not JSON, in the shape a schema
 * validator answers, so `JA2005`'s `detail` reads the same either way.
 * @param {string} pointer
 */
const notJson = (pointer) => ({
  valid: false,
  errors: [{ instancePath: pointer, message: 'is not a JSON value' }],
});

/**
 * Where, under a value that is not JSON, the first offending value sits:
 * the value's own pointer when it is the offender (`undefined`, a function,
 * a `Date`, a non-finite number), a member's or an item's below it
 * otherwise, and a container met twice on one descent — the cycle — at its
 * own pointer. So the detail names the location the bad value was written
 * to, not the array an insert reported. Walks only after a check failed.
 * @param {any} value - a value `isJsonValue` refused
 * @param {string} pointer - where it sits
 * @param {Set<object>} [path] - the containers on this descent
 * @returns {string}
 */
function offending(value, pointer, path = new Set()) {
  if (value === null || typeof value !== 'object') return pointer;
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return pointer;
  }
  if (path.has(value)) return pointer;
  path.add(value);
  const keys = isArray ? Array.from(value, (_item, index) => String(index)) : Object.keys(value);
  for (const key of keys) {
    if (!isJsonValue(value[key])) return offending(value[key], `${pointer}/${encodeJSONPointerSegment(key)}`, path);
  }
  return pointer;
}

/**
 * Create the hook. Pass it as `createApp(doc, { validateState })`, or call
 * it from a hook of your own before a schema check.
 * @returns {(state: any, context?: { changes?: string[] | null }) => true | { valid: false, errors: Array<{ instancePath: string, message: string }> }}
 * @example
 * const app = createApp(doc, { node, validateState: createJsonStateValidator() });
 * app.dispatch('set', new Date()); // a patch writing $payload: JA2005 at the written pointer
 */
export function createJsonStateValidator() {
  /** @type {import('@jarenjs/core/cache').BoundedCache<string, (root: any) => any>} */
  const pointers = createBoundedCache(POINTER_CACHE_LIMIT);
  return function validateJsonState(state, context = undefined) {
    const changes = context?.changes ?? null;
    if (changes === null) return isJsonValue(state) ? true : notJson(offending(state, ''));
    for (const pointer of changes) {
      // '' compiles to the root, so a root write checks the whole state
      const value = pointers.getOrCreate(pointer, compileJSONPointer)(state);
      // a removed location has nothing left to check
      if (value === JSONPOINTER_NOTHING) continue;
      if (!isJsonValue(value)) return notJson(offending(value, pointer));
    }
    return true;
  };
}
