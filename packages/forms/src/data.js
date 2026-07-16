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

import {
  parseJSONPointer,
  compileJSONPointer,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json/pointer';

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

const getterCache = new Map();
const GETTER_CACHE_LIMIT = 512;

/**
 * Compiled getter for a pointer string, cached FIFO (the same pattern as
 * the query engine's string cache): form field pointers are a small,
 * stable set, so every keystroke after the first hits the cache.
 * @param {string} pointer
 * @returns {(root: any) => any}
 */
function getPointerGetter(pointer) {
  let getter = getterCache.get(pointer);
  if (getter === undefined) {
    getter = compileJSONPointer(pointer);
    if (getterCache.size >= GETTER_CACHE_LIMIT)
      getterCache.delete(getterCache.keys().next().value);
    getterCache.set(pointer, getter);
  }
  return getter;
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

//#region roadmap
// Immutable write ops (set/append/remove by pointer) are a @jarenjs/json
// roadmap item (compiled setters beside the compiled getters, feeding the
// JSON Patch work). Until that lands they live here; parsing already goes
// through the shared parseJSONPointer above.

/**
 * Return a copy of `data` with the value at `pointer` replaced.
 * Setting `undefined` REMOVES the property (array items become undefined
 * holes only when explicitly set; use removeItemAt to delete them).
 * Missing intermediate containers are created (objects for name segments,
 * arrays for numeric segments).
 * @param {any} data
 * @param {string} pointer
 * @param {any} value
 * @returns {any} The new root value
 */
export function setValueAtPointer(data, pointer, value) {
  const keys = parsePointer(pointer);
  if (keys.length === 0) return value;

  const root = cloneContainer(data, keys[0]);
  let current = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    current[key] = cloneContainer(current[key], keys[i + 1]);
    current = current[key];
  }

  const last = keys[keys.length - 1];
  if (value === undefined && !Array.isArray(current)) {
    delete current[last];
  }
  else {
    current[last] = value;
  }
  return root;
}

function cloneContainer(value, nextKey) {
  if (Array.isArray(value)) return value.slice();
  if (value != null && typeof value === 'object') return { ...value };
  return /^\d+$/.test(String(nextKey)) ? [] : {};
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
        if (value !== undefined) obj[child.key] = value;
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
