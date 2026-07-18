//#region Write operations
// Standalone compiled write operations: set / insert / remove at a
// JSON Pointer (RFC 6901), a normalized path (RFC 9535 section 2.7,
// or any singular query), or at every node an arbitrary JSONPath query
// selects - with copy-on-write application throughout.
//
// The pointer-addressed writers follow the two-stage house pipeline:
// the target (pointer or singular query - dispatch decided once on the
// first character) parses into the cow.js step encoding and the writer
// closes over it. The JSONPath writers compile the query once; applying
// runs it in nodes mode and rewrites the matched locations in REVERSE
// document order - descendants before ancestors, later siblings before
// earlier ones - so array-index shifts from inserts/removes never
// invalidate the remaining locations, and an ancestor rewrite
// deterministically wins over rewrites inside it.
//
// Application is copy-on-write via the shared owned-set machinery
// (cow.js): the input document is never mutated, only the written spine
// is cloned (once, however many locations share it), untouched subtrees
// are shared with the result. `{ mutate: true }` patches in place.
//
// Error codes:
//   JW0001 - the write target has the wrong form (not a pointer or a
//            singular JSONPath query)
//   JW2001 - the target location does not exist
//   JW2002 - invalid array position
//   JW2003 - the root of the document cannot be removed

import {
  CC_DOLLAR,
  CC_SQUOTE,
  CC_BACKSLASH,
  CC_RBRACKET,
  CC_0,
} from '@jarenjs/core/scan';

import {
  parseJSONPointer,
} from './pointer.js';

import { parseJSONPath, compileJSONPath } from './path.js';

import { scanArrayIndex, isSingularSegments } from './segments.js';

import {
  isJsonObject,
  setObjectMember,
  makeState,
  ownedRoot,
  ownedChild,
  stepArrayIndex,
} from './cow.js';

const hasOwn = Object.hasOwn;

//#region errors

/**
 * Error thrown when a write target is malformed (`JW0001`) or a write
 * fails to apply (`JW2xxx`). `dataPath` is the write target as given
 * (a JSON Pointer or JSONPath), or the normalized path of the failing
 * location for query-selected writes.
 */
export class JsonWriteError extends Error {
  constructor(code, message, dataPath) {
    super(`${code}: ${message} at ${dataPath === '' ? "''" : dataPath}`);
    this.name = 'JsonWriteError';
    this.code = code;
    this.dataPath = dataPath;
  }
}

function writeError(code, message, dataPath) {
  return new JsonWriteError(code, message, dataPath);
}

//#endregion

//#region targets

/**
 * Parse a write target into the cow.js step encoding. A target starting
 * with `$` is a JSONPath and must be singular (normalized paths are);
 * `''` or a leading `/` is an RFC 6901 pointer (one token, two forms).
 * The dispatch is decided once at compile time.
 */
function parseWriteTarget(target) {
  if (typeof target !== 'string')
    throw writeError('JW0001', 'a write target must be a string', String(target));
  if (target.length !== 0 && target.charCodeAt(0) === CC_DOLLAR) {
    const { segments } = parseJSONPath(target);
    if (!isSingularSegments(segments))
      throw writeError('JW0001', 'a write target must be a singular JSONPath query', target);
    const len = segments.length;
    const names = new Array(len);
    const indexes = new Array(len);
    for (let i = 0; i < len; i++) {
      const sel = segments[i].selectors[0];
      if (sel.kind === 'name') {
        names[i] = sel.name;
        indexes[i] = -1;
      }
      else {
        names[i] = null;
        indexes[i] = sel.index;
      }
    }
    return { pointer: target, names, indexes, len };
  }
  const names = parseJSONPointer(target);
  const len = names.length;
  const indexes = new Array(len);
  for (let i = 0; i < len; i++)
    indexes[i] = scanArrayIndex(names[i], 0, names[i].length);
  return { pointer: target, names, indexes, len };
}

function parseMutate(options) {
  return options !== undefined && options !== null && options.mutate === true;
}

//#endregion

//#region walk and leaf operations

// Walk to the parent of the target location, cloning the spine on first
// touch. Steps use the cow.js encoding; a miss raises JW2001.
function walkOwnedParent(state, names, indexes, plen, dataPath) {
  let v = ownedRoot(state);
  for (let i = 0; i < plen; i++) {
    if (Array.isArray(v)) {
      const idx = stepArrayIndex(v, names[i], indexes[i]);
      if (idx < 0 || idx >= v.length)
        throw writeError('JW2001', 'the location does not exist', dataPath);
      v = ownedChild(state, v, v[idx], idx);
    }
    else if (typeof v === 'object' && v !== null) {
      const name = names[i];
      if (name === null || !hasOwn(v, name))
        throw writeError('JW2001', 'the location does not exist', dataPath);
      v = ownedChild(state, v, v[name], name);
    }
    else {
      throw writeError('JW2001', 'the location does not exist', dataPath);
    }
  }
  return v;
}

/** A value may be an updater function `(oldValue, location) => next`. */
function resolveValue(value, oldValue, location) {
  return typeof value === 'function' ? value(oldValue, location) : value;
}

// set semantics: replace the element / member, create the member when
// absent, extend an array by one at index === length (or '-').
function leafSet(parent, name, index, value, dataPath) {
  if (Array.isArray(parent)) {
    const len = parent.length;
    const idx = name === '-' ? len : stepArrayIndex(parent, name, index);
    if (idx < 0 || idx > len)
      throw writeError('JW2002', `invalid array position '${name === null ? index : name}'`, dataPath);
    if (idx === len)
      parent.push(resolveValue(value, undefined, dataPath));
    else
      parent[idx] = resolveValue(value, parent[idx], dataPath);
    return;
  }
  if (isJsonObject(parent)) {
    if (name === null)
      throw writeError('JW2001', 'the location does not exist', dataPath);
    const old = hasOwn(parent, name) ? parent[name] : undefined;
    setObjectMember(parent, name, resolveValue(value, old, dataPath));
    return;
  }
  throw writeError('JW2001', 'the location does not exist', dataPath);
}

// insert semantics: RFC 6902 `add` - array insert with shift ('-'
// appends), object member set-or-create.
function leafInsert(parent, name, index, value, dataPath) {
  if (Array.isArray(parent)) {
    const len = parent.length;
    const idx = name === '-' ? len : stepArrayIndex(parent, name, index);
    if (idx < 0 || idx > len)
      throw writeError('JW2002', `invalid array position '${name === null ? index : name}'`, dataPath);
    if (idx === len)
      parent.push(value);
    else
      parent.splice(idx, 0, value);
    return;
  }
  if (isJsonObject(parent)) {
    if (name === null)
      throw writeError('JW2001', 'the location does not exist', dataPath);
    setObjectMember(parent, name, value);
    return;
  }
  throw writeError('JW2001', 'the location does not exist', dataPath);
}

// remove semantics: delete the element (with shift) / member. `lenient`
// turns a missing location into a no-op (the query-selected writers).
function leafRemove(parent, name, index, dataPath, lenient) {
  if (Array.isArray(parent)) {
    const idx = name === '-' ? -1 : stepArrayIndex(parent, name, index);
    if (idx < 0 || idx >= parent.length) {
      if (lenient)
        return;
      throw writeError(idx < 0 ? 'JW2002' : 'JW2001',
        idx < 0 ? `invalid array position '${name === null ? index : name}'` : 'the location does not exist',
        dataPath);
    }
    parent.splice(idx, 1);
    return;
  }
  if (isJsonObject(parent) && name !== null && hasOwn(parent, name)) {
    delete parent[name];
    return;
  }
  if (!lenient)
    throw writeError('JW2001', 'the location does not exist', dataPath);
}

//#endregion

//#region pointer-addressed writers

/**
 * Options for the compiled write operations.
 * @typedef {Object} JsonWriteOptions
 * @property {boolean} [mutate] - Apply in place instead of copy-on-write.
 */

/**
 * A compiled setter/inserter: applies the write and returns the new
 * document. `value` may be an updater function `(oldValue, location) =>
 * next` for setters.
 * @typedef {(root: any, value: any) => any} JsonWriter
 */

/**
 * A compiled remover: removes the location and returns the new document.
 * @typedef {(root: any) => any} JsonRemover
 */

/**
 * Compile a `set` at a JSON Pointer, a normalized path, or any singular
 * JSONPath query. Set replaces the addressed element or member, creates
 * the member when absent (parents must exist), and extends an array by
 * one at index == length (`/arr/-` appends). `value` may be an updater
 * function `(oldValue, location) => next`.
 *
 * Application is copy-on-write: the input is never mutated and
 * untouched subtrees are shared with the result.
 *
 * @param {string} target - The write target (e.g. `/user/name`, `$['user']['name']`)
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonWriter} `(root, value) => newRoot`
 * @throws {JsonWriteError} `JW0001` when the target is not a pointer or
 *   singular query
 * @example
 * const setZip = compileJSONPointerSetter('/address/zip');
 * setZip(doc, '10999'); // doc untouched, spine cloned once
 */
export function compileJSONPointerSetter(target, options = undefined) {
  const t = parseWriteTarget(target);
  const mutate = parseMutate(options);
  if (t.len === 0)
    return (root, value) => resolveValue(value, root, t.pointer);
  const plen = t.len - 1;
  return function setAt(root, value) {
    const state = makeState(root, mutate ? null : new Set());
    const parent = walkOwnedParent(state, t.names, t.indexes, plen, t.pointer);
    leafSet(parent, t.names[plen], t.indexes[plen], value, t.pointer);
    return state.root;
  };
}

/**
 * Compile an `insert` at a JSON Pointer, a normalized path, or any
 * singular JSONPath query - RFC 6902 `add` semantics: array elements
 * shift right (`/arr/-` appends), object members are set-or-created.
 *
 * @param {string} target - The write target
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonWriter} `(root, value) => newRoot`
 * @throws {JsonWriteError} `JW0001` when the target is not a pointer or
 *   singular query
 */
export function compileJSONPointerInserter(target, options = undefined) {
  const t = parseWriteTarget(target);
  const mutate = parseMutate(options);
  if (t.len === 0)
    return (root, value) => value;
  const plen = t.len - 1;
  return function insertAt(root, value) {
    const state = makeState(root, mutate ? null : new Set());
    const parent = walkOwnedParent(state, t.names, t.indexes, plen, t.pointer);
    leafInsert(parent, t.names[plen], t.indexes[plen], value, t.pointer);
    return state.root;
  };
}

/**
 * Compile a `remove` at a JSON Pointer, a normalized path, or any
 * singular JSONPath query. The location must exist (`JW2001`); array
 * elements shift left.
 *
 * @param {string} target - The write target
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonRemover} `(root) => newRoot`
 * @throws {JsonWriteError} `JW0001` when the target is not a pointer or
 *   singular query
 */
export function compileJSONPointerRemover(target, options = undefined) {
  const t = parseWriteTarget(target);
  const mutate = parseMutate(options);
  if (t.len === 0) {
    return () => {
      throw writeError('JW2003', 'the root of the document cannot be removed', t.pointer);
    };
  }
  const plen = t.len - 1;
  return function removeAt(root) {
    const state = makeState(root, mutate ? null : new Set());
    const parent = walkOwnedParent(state, t.names, t.indexes, plen, t.pointer);
    leafRemove(parent, t.names[plen], t.indexes[plen], t.pointer, false);
    return state.root;
  };
}

/**
 * One-shot `set` at a pointer / normalized path / singular query. On hot
 * paths prefer `compileJSONPointerSetter` and reuse the writer.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} target - The write target
 * @param {any} value - The value, or an updater `(oldValue, location) => next`
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function setAtJSONPointer(root, target, value, options = undefined) {
  return compileJSONPointerSetter(target, options)(root, value);
}

/**
 * One-shot `insert` at a pointer / normalized path / singular query.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} target - The write target
 * @param {any} value - The value to insert
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function insertAtJSONPointer(root, target, value, options = undefined) {
  return compileJSONPointerInserter(target, options)(root, value);
}

/**
 * One-shot `remove` at a pointer / normalized path / singular query.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} target - The write target
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function removeAtJSONPointer(root, target, options = undefined) {
  return compileJSONPointerRemover(target, options)(root);
}

//#endregion

//#region JSONPath-selected writers

// Scan a normalized path produced by the nodes-mode engine back into
// typed steps. The engine only emits `['name']` (with the section 2.7
// escape set) and `[index]` selectors, so this scanner is total for its
// input; it is never exposed to user text.
function scanNormalizedSteps(path) {
  const names = [];
  const indexes = [];
  const len = path.length;
  let pos = 1; // skip '$'
  while (pos < len) {
    pos++; // consume '['
    if (path.charCodeAt(pos) === CC_SQUOTE) {
      pos++;
      let name = '';
      let chunk = pos;
      while (path.charCodeAt(pos) !== CC_SQUOTE) {
        if (path.charCodeAt(pos) === CC_BACKSLASH) {
          name += path.slice(chunk, pos);
          const esc = path.charCodeAt(pos + 1);
          if (esc === 0x75 /* 'u' */) {
            name += String.fromCharCode(parseInt(path.slice(pos + 2, pos + 6), 16));
            pos += 6;
          }
          else {
            name += esc === 0x62 ? '\b'
              : esc === 0x74 ? '\t'
                : esc === 0x6E ? '\n'
                  : esc === 0x66 ? '\f'
                    : esc === 0x72 ? '\r'
                      : String.fromCharCode(esc); // \' and \\
            pos += 2;
          }
          chunk = pos;
        }
        else {
          pos++;
        }
      }
      names.push(name + path.slice(chunk, pos));
      indexes.push(-1);
      pos += 2; // consume "']"
    }
    else {
      let index = 0;
      while (path.charCodeAt(pos) !== CC_RBRACKET) {
        index = index * 10 + (path.charCodeAt(pos) - CC_0);
        pos++;
      }
      names.push(null);
      indexes.push(index);
      pos++; // consume ']'
    }
  }
  return { names, indexes, len: names.length };
}

// The shared apply loop of the query-selected writers: run the compiled
// query in nodes mode, then rewrite the matched locations in reverse
// document order (dedupe first - RFC 9535 nodelists may repeat a node).
function applyAtNodes(query, root, mutate, leaf) {
  const paths = query.paths(root);
  if (paths.length === 0)
    return root;
  const state = makeState(root, mutate ? null : new Set());
  const seen = paths.length > 1 ? new Set() : null;
  for (let i = paths.length - 1; i >= 0; i--) {
    const path = paths[i];
    if (seen !== null) {
      if (seen.has(path))
        continue;
      seen.add(path);
    }
    leaf(state, path);
  }
  return state.root;
}

/**
 * Compile a `set` at every node a JSONPath query selects. Applying runs
 * the query against the document and replaces each matched node; `value`
 * may be an updater function `(oldValue, normalizedPath) => next`.
 * Matching nothing is a no-op. Locations are rewritten in reverse
 * document order, so when matches nest, the ancestor's rewrite wins.
 *
 * @param {string} path - The JSONPath query (e.g. `$..price`)
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonWriter} `(root, value) => newRoot`
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 * @example
 * const addVat = compileJSONPathSetter('$..price');
 * addVat(doc, (price) => price * 1.21);
 */
export function compileJSONPathSetter(path, options = undefined) {
  const query = compileJSONPath(path);
  const mutate = parseMutate(options);
  return function setAtMatches(root, value) {
    return applyAtNodes(query, root, mutate, (state, p) => {
      if (p === '$') {
        state.root = resolveValue(value, state.root, p);
        return;
      }
      const t = scanNormalizedSteps(p);
      const parent = walkOwnedParent(state, t.names, t.indexes, t.len - 1, p);
      leafSet(parent, t.names[t.len - 1], t.indexes[t.len - 1], value, p);
    });
  };
}

/**
 * Compile an `insert` at every node a JSONPath query selects - RFC 6902
 * `add` semantics per location: the value is inserted *before* each
 * matched array element (later siblings shift right), and replaces
 * matched object members. Matching nothing is a no-op.
 *
 * @param {string} path - The JSONPath query (e.g. `$.list[0]`)
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonWriter} `(root, value) => newRoot`
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 */
export function compileJSONPathInserter(path, options = undefined) {
  const query = compileJSONPath(path);
  const mutate = parseMutate(options);
  return function insertAtMatches(root, value) {
    return applyAtNodes(query, root, mutate, (state, p) => {
      if (p === '$') {
        state.root = value;
        return;
      }
      const t = scanNormalizedSteps(p);
      const parent = walkOwnedParent(state, t.names, t.indexes, t.len - 1, p);
      leafInsert(parent, t.names[t.len - 1], t.indexes[t.len - 1], value, p);
    });
  };
}

/**
 * Compile a `remove` of every node a JSONPath query selects. Array
 * elements are removed with shift; removals apply in reverse document
 * order, so multiple removals from one array (and nested removals)
 * compose correctly. Matching nothing is a no-op; selecting the root
 * raises `JW2003`.
 *
 * @param {string} path - The JSONPath query (e.g. `$.store.book[?@.price > 20]`)
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {JsonRemover} `(root) => newRoot`
 * @throws {JSONPathSyntaxError} When the query is not valid RFC 9535
 * @example
 * const dropExpensive = compileJSONPathRemover('$.store.book[?@.price > 20]');
 * dropExpensive(doc); // matched books removed, everything else shared
 */
export function compileJSONPathRemover(path, options = undefined) {
  const query = compileJSONPath(path);
  const mutate = parseMutate(options);
  return function removeMatches(root) {
    return applyAtNodes(query, root, mutate, (state, p) => {
      if (p === '$')
        throw writeError('JW2003', 'the root of the document cannot be removed', p);
      const t = scanNormalizedSteps(p);
      const parent = walkOwnedParent(state, t.names, t.indexes, t.len - 1, p);
      leafRemove(parent, t.names[t.len - 1], t.indexes[t.len - 1], p, true);
    });
  };
}

/**
 * One-shot `set` at every node a JSONPath query selects. On hot paths
 * prefer `compileJSONPathSetter` and reuse the writer.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} path - The JSONPath query
 * @param {any} value - The value, or an updater `(oldValue, normalizedPath) => next`
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function setAtJSONPath(root, path, value, options = undefined) {
  return compileJSONPathSetter(path, options)(root, value);
}

/**
 * One-shot `insert` at every node a JSONPath query selects.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} path - The JSONPath query
 * @param {any} value - The value to insert
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function insertAtJSONPath(root, path, value, options = undefined) {
  return compileJSONPathInserter(path, options)(root, value);
}

/**
 * One-shot `remove` of every node a JSONPath query selects.
 * @param {any} root - The document (never mutated unless `options.mutate`)
 * @param {string} path - The JSONPath query
 * @param {JsonWriteOptions} [options] - Write options
 * @returns {any} The new document
 */
export function removeAtJSONPath(root, path, options = undefined) {
  return compileJSONPathRemover(path, options)(root);
}

//#endregion

//#endregion
