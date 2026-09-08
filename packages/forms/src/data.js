//@ts-check

/**
 * Immutable data helpers for form values, addressed by JSON pointer.
 *
 * Form data follows JSON semantics: a field that was never filled in is
 * ABSENT (undefined), not an empty string - so `required` and default
 * handling behave exactly like they will on the wire.
 *
 * Pointer parsing and reading go through the @jarenjs/json compiled
 * pointer engine (one pointer implementation in the whole repo); field
 * pointers are stable for a model's lifetime, so compiled getters are
 * cached by pointer string and reads are allocation-free.
 */

import { equalsJson, setObjectMember } from '@jarenjs/core/object';
import { createBoundedCache } from '@jarenjs/core/cache';
import {
  parseJSONPointer,
  compileJSONPointer,
  encodeJSONPointerSegment,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json/pointer';
import {
  compileJSONPointerSetter,
  compileJSONPointerRemover,
  JsonWriteError,
} from '@jarenjs/json/write';

/**
 * Split a JSON pointer into decoded segments per RFC 6901. '' -> [].
 * @param {string} pointer
 * @returns {string[]}
 * @throws {import('@jarenjs/json/pointer').JSONPointerSyntaxError}
 *   When the pointer violates the RFC 6901 grammar
 */
export function parsePointer(pointer) {
  if (pointer == null) return [];
  return parseJSONPointer(pointer);
}

const getterCache = createBoundedCache(512);

/**
 * Compiled getter for a pointer string, cached in the shared bounded
 * LRU (`@jarenjs/core/cache`): form field pointers are a small, stable
 * set, so every keystroke after the first hits the cache.
 * @param {string} pointer
 * @returns {(root: any) => any}
 */
function getPointerGetter(pointer) {
  return getterCache.getOrCreate(pointer, compileJSONPointer);
}

/**
 * Read the value at a JSON pointer.
 * @param {any} data
 * @param {string} pointer - e.g. '/user/address/0/street'
 * @returns {any} The value, or undefined when the path does not exist
 */
export function getValueAtPointer(data, pointer) {
  const value = getPointerGetter(pointer)(data);
  return value === JSONPOINTER_NOTHING ? undefined : value;
}

//#region write operations
// One write engine in the whole repo: the copy-on-write kernel behind
// @jarenjs/json's patch and write modules. Forms adds only its two
// data disciplines - missing parents are CREATED (a rendered field may
// be the first write into an untouched branch) and setting `undefined`
// deletes (parseFieldInput maps a cleared input to undefined).

const setterCache = createBoundedCache(512);
const removerCache = createBoundedCache(512);

function getPointerSetter(pointer) {
  return setterCache.getOrCreate(pointer,
    (p) => compileJSONPointerSetter(p, { parents: 'create' }));
}

function getPointerRemover(pointer) {
  return removerCache.getOrCreate(pointer, compileJSONPointerRemover);
}

/**
 * Return a copy of `data` with the value at `pointer` replaced.
 * Setting `undefined` REMOVES the location (deleting something that does
 * not exist is a no-op returning `data` unchanged). Missing intermediate
 * containers are created (objects for name segments, arrays for numeric
 * segments), and untouched siblings are shared by reference — the same
 * copy-on-write engine as `@jarenjs/json`'s patch and write modules.
 * @param {any} data
 * @param {string} pointer
 * @param {any} value
 * @returns {any} The new root value
 */
export function setValueAtPointer(data, pointer, value) {
  if (value === undefined) {
    if (pointer === '') return undefined;
    try {
      return getPointerRemover(pointer)(data);
    }
    catch (error) {
      if (error instanceof JsonWriteError) return data;
      throw error;
    }
  }
  return getPointerSetter(pointer)(data, value);
}

/**
 * Return a copy of `data` with the item at `index` removed from the array
 * at `pointer`.
 * @param {any} data
 * @param {string} pointer - Pointer to the ARRAY
 * @param {number} index
 * @returns {any}
 */
export function removeItemAt(data, pointer, index) {
  const arr = getValueAtPointer(data, pointer);
  if (!Array.isArray(arr)) return data;
  const next = arr.slice();
  next.splice(index, 1);
  return setValueAtPointer(data, pointer, next);
}

/**
 * Return a copy of `data` with `value` appended to the array at `pointer`
 * (the array is created when absent).
 * @param {any} data
 * @param {string} pointer - Pointer to the ARRAY
 * @param {any} value
 * @returns {any}
 */
export function appendItem(data, pointer, value) {
  const arr = getValueAtPointer(data, pointer);
  const next = Array.isArray(arr) ? [...arr, value] : [value];
  return setValueAtPointer(data, pointer, next);
}

/**
 * Every pointer whose value differs between two documents, in
 * document order.
 *
 * Membership is significant: an added or removed member (or array tail
 * slot) contributes its pointer even when both sides read back as
 * `null` through a pointer lookup. Reference-equal subtrees are skipped
 * whole, so over copy-on-write edits — which is how every writer in
 * this package produces its next document — the walk costs O(change),
 * not O(document).
 *
 * Two callers rely on it: the session's navigation-guard evidence
 * (`dirtyPaths`) and the rule memo's invalidation set.
 * @param {any} previous
 * @param {any} current
 * @returns {string[]}
 */
export function changedPointers(previous, current) {
  /** @type {string[]} */
  const out = [];
  collectChanged(previous, current, '', out);
  return out;
}

function collectChanged(previous, current, pointer, out) {
  // Reference equality first, at every level and before any pointer
  // string is built: over a copy-on-write edit almost every member of
  // the touched container is the identical value, and formatting a
  // pointer for each of them would put the document's WIDTH back into a
  // walk whose whole point is to cost only its depth.
  if (previous === current) return;
  if (Array.isArray(previous) && Array.isArray(current)) {
    const shared = Math.min(previous.length, current.length);
    for (let i = 0; i < shared; i++) {
      if (previous[i] !== current[i])
        collectChanged(previous[i], current[i], `${pointer}/${i}`, out);
    }
    const longest = Math.max(previous.length, current.length);
    for (let i = shared; i < longest; i++)
      out.push(`${pointer}/${i}`); // added or removed tail slot
    return;
  }
  if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)
    && current !== null && typeof current === 'object' && !Array.isArray(current)) {
    const before = Object.keys(previous);
    const after = Object.keys(current);
    // Same members in the same order — which is what a copy-on-write
    // edit of one member produces — needs no membership probing at all,
    // just a value compare per key. The general path below is for real
    // shape changes.
    if (before.length === after.length && sameOrder(before, after)) {
      for (let i = 0; i < before.length; i++) {
        const key = before[i];
        if (previous[key] !== current[key]) {
          collectChanged(previous[key], current[key],
            `${pointer}/${encodeJSONPointerSegment(key)}`, out);
        }
      }
      return;
    }
    // own keys only, membership by Object.hasOwn — JSON member names
    // like 'constructor', 'toString' or a parsed own '__proto__' are
    // legal data and must diff as data, never through the prototype
    // chain (null-prototype records diff identically)
    for (const key of before) {
      if (!Object.hasOwn(current, key))
        out.push(`${pointer}/${encodeJSONPointerSegment(key)}`); // removed member
      else if (previous[key] !== current[key])
        collectChanged(previous[key], current[key], `${pointer}/${encodeJSONPointerSegment(key)}`, out);
    }
    for (const key of after) {
      if (!Object.hasOwn(previous, key))
        out.push(`${pointer}/${encodeJSONPointerSegment(key)}`); // added member
    }
    return;
  }
  if (!equalsJson(previous, current)) out.push(pointer);
}

/** Whether two key lists hold the same names in the same positions. */
function sameOrder(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

//#endregion

/**
 * Create initial data for a form model: schema defaults and const values
 * are filled in, everything else stays absent.
 * @param {import('./model.js').FormField} field - A field from buildFormModel
 * @returns {any}
 */
export function createInitialData(field) {
  if (field == null) return undefined;
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.constValue !== undefined) return field.constValue;

  if (field.kind === 'object') {
    const obj = {};
    if (field.children) {
      for (const child of field.children) {
        const value = createInitialData(child);
        if (value !== undefined) setObjectMember(obj, child.key, value);
      }
    }
    return obj;
  }

  if (field.kind === 'array') {
    if (field.tuple) {
      const items = field.tuple.map((item) => createInitialData(item));
      while (items.length > 0 && items[items.length - 1] === undefined) items.pop();
      return items;
    }
    return [];
  }

  return undefined;
}

/**
 * Create a sensible starter value for one array item of the given field.
 * @param {import('./model.js').FormField} itemField
 * @returns {any}
 */
export function createItemValue(itemField) {
  const initial = createInitialData(itemField);
  if (initial !== undefined) return initial;
  switch (itemField?.kind) {
    case 'string': return '';
    case 'number':
    case 'integer': return 0;
    case 'boolean': return false;
    case 'enum': return itemField.enumValues?.[0];
    default: return initial;
  }
}

/**
 * Coerce a raw input string (what an HTML input yields) into the typed
 * value for a field. An empty string means "absent" (undefined) so that
 * required/optional semantics stay correct.
 * @param {import('./model.js').FormField} field
 * @param {any} raw - Raw input value (string, or boolean for checkboxes)
 * @returns {any}
 */
export function parseFieldInput(field, raw) {
  if (field.kind === 'boolean') return !!raw;
  if (raw === '' || raw == null) return undefined;

  switch (field.kind) {
    case 'number':
    case 'integer': {
      const num = Number(raw);
      // Keep the raw string when it is not numeric, so validation can
      // report a type error instead of silently swallowing the input.
      return Number.isNaN(num) ? raw : num;
    }
    case 'enum': {
      // Map the selected option string back to the typed enum value
      const match = field.enumValues?.find((v) => String(v) === String(raw));
      return match !== undefined ? match : raw;
    }
    default:
      return raw;
  }
}
