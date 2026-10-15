//#region JSON Patch (RFC 6902) + JSON Merge Patch (RFC 7396)
// JSON Patch: https://datatracker.ietf.org/doc/html/rfc6902
// JSON Merge Patch: https://datatracker.ietf.org/doc/html/rfc7396
//
// Both formats compile in the house two-stage style:
//
//   1. `compileJSONPatch` validates the patch document once (all `JP0xxx`
//      errors, with a `docPath` into the *patch* document), pre-parses
//      every `path`/`from` through the strict RFC 6901 parser and
//      specializes one closure per operation. `compileMergePatch`
//      pre-splits a merge patch into remove/set/merge plans.
//   2. Applying replays the closures against a copy-on-write state:
//      the input document is never mutated, untouched subtrees are shared
//      by reference with the result (the JSLT `share` discipline), and a
//      failing operation aborts the whole application (RFC 6902
//      section 5) for free because the input root was never touched.
//
// Copy-on-write: an application tracks the set of nodes it has already
// cloned ("owned"). The first write along a path shallow-clones the spine
// from the root down; later writes find the spine in the owned set and
// mutate the clones in place, so k operations touching one region cost
// one spine copy, not k.
//
// `createJSONPatch` and `createMergePatch` are the structural diffs;
// `applyJSONPatch(doc, createJSONPatch(a, b))` reproduces `b` from `a`.
//
// Error codes:
//   JP0001 - the patch document or an operation has the wrong shape
//   JP0002 - unknown or missing `op` member
//   JP0003 - missing or invalid JSON Pointer (`path`/`from`)
//   JP0004 - missing `value` member
//   JP0005 - `from` is a proper prefix of `path` in a move
//   JP2001 - the target location does not exist
//   JP2002 - invalid array position
//   JP2003 - the root of the document cannot be removed
//   JP2004 - a `test` operation failed

import {
  cloneJson,
  equalsJson,
  isJsonContainer,
  isJsonObject,
  isPlainOptions,
  locateCycle,
  refuseUnknownMembers,
  setObjectMember,
  stableStringify,
} from '@jarenjs/core/object';

import {
  parseJSONPointer,
  encodeJSONPointerSegment,
} from './pointer.js';

import { NOTHING, scanArrayIndex } from './segments.js';

import { CodedError } from '@jarenjs/core/errors';
import { CodedDocPathError, JSON_WALK_DEPTH_CEILING, walkTooDeep } from './errors.js';

import {
  makeState,
  ownedRoot,
  ownedChild,
  readSteps,
} from './cow.js';

const hasOwn = Object.hasOwn;

//#region errors

/**
 * Error thrown when a JSON Patch document is rejected at compile time
 * (`JP0xxx` codes). `docPath` is an RFC 6901 JSON Pointer into the
 * patch document (e.g. `/2/from`). A wrapped pointer syntax error is
 * exposed through `cause`.
 */
export class JsonPatchCompileError extends CodedDocPathError {
  constructor(code, message, docPath, cause = undefined) {
    super('JsonPatchCompileError', code, message, docPath, cause);
  }
}

/**
 * Error thrown when applying a compiled JSON Patch fails (`JP2xxx`
 * codes). `docPath` points at the failing operation in the patch
 * document; `dataPath` is the operation's target location in the
 * document being patched — both render, separately identifiable, per
 * the `@jarenjs/core` coded contract (`at` = document, `in data` =
 * data).
 */
export class JsonPatchRuntimeError extends CodedError {
  constructor(code, reason, docPath, dataPath) {
    super('JsonPatchRuntimeError', code, reason, { docPath, dataPath });
  }
}

//#endregion

//#region copy-on-write machinery
// The generic pieces (owned-set state, spine cloning, step reads) live
// in the package-internal cow.js, shared with the standalone write
// operations (write.js). This region keeps only what is specific to the
// patch engine: the walk that raises JsonPatchRuntimeError with both a
// patch docPath and a target dataPath.

function pathError(code, message, docPath, dataPath) {
  return new JsonPatchRuntimeError(code, message, docPath, dataPath);
}

// Walk to the parent of the target location, cloning the spine on first
// touch. `t` is a compiled target; the walk covers segments [0, len-1).
function walkOwnedParent(state, t, docPath) {
  const names = t.names;
  const indexes = t.indexes;
  const plen = t.len - 1;
  let v = ownedRoot(state);
  for (let i = 0; i < plen; i++) {
    if (Array.isArray(v)) {
      const idx = indexes[i];
      if (idx < 0 || idx >= v.length)
        throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
      v = ownedChild(state, v, v[idx], idx);
    }
    else if (typeof v === 'object' && v !== null) {
      const name = names[i];
      if (!hasOwn(v, name))
        throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
      v = ownedChild(state, v, v[name], name);
    }
    else {
      throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
    }
  }
  return v;
}

// Read the full target location without cloning anything.
function readTarget(root, t) {
  return readSteps(root, t.names, t.indexes, t.len, NOTHING);
}

function containsOwned(v, owned) {
  if (!isJsonContainer(v))
    return false;
  if (owned.has(v))
    return true;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (containsOwned(v[i], owned))
        return true;
    }
    return false;
  }
  for (const key in v) {
    if (hasOwn(v, key) && containsOwned(v[key], owned))
      return true;
  }
  return false;
}

// The value a `copy` inserts. Sharing the source reference is safe only
// while no clone of this application lives inside it: a later operation
// walking the second location would find an owned node and mutate both
// aliases. In-place mode owns everything, so it always deep-copies.
function copyForInsert(value, owned) {
  if (!isJsonContainer(value))
    return value;
  if (owned === null)
    return cloneJson(value);
  if (owned.size !== 0 && containsOwned(value, owned))
    return cloneJson(value);
  return value;
}

//#endregion

//#region operation primitives

// Change tracking (`changes` option): one pointer per successful write,
// pushed by the operation primitives below. `state.changes` is `null`
// when tracking is off - a single monomorphic null check per write.
function recordChange(state, pointer) {
  if (state.changes !== null)
    state.changes.push(pointer);
}

// add semantics at a non-root target: array insert (with shift, `-`
// appends), object member set-or-replace (RFC 6902 section 4.1).
function insertAt(state, t, value, docPath) {
  const parent = walkOwnedParent(state, t, docPath);
  if (Array.isArray(parent)) {
    const len = parent.length;
    const idx = t.lastName === '-' ? len : t.lastIndex;
    if (idx < 0 || idx > len)
      throw pathError('JP2002', `invalid array position '${t.lastName}' in '${t.pointer}'`, docPath, t.pointer);
    if (idx === len) {
      parent.push(value);
      // append shifts nothing: the new element's location is precise
      recordChange(state, t.parentPointer + '/' + idx);
    }
    else {
      parent.splice(idx, 0, value);
      // insert shifts every later element: the whole array changed
      recordChange(state, t.parentPointer);
    }
    return;
  }
  if (isJsonObject(parent)) {
    setObjectMember(parent, t.lastName, value);
    recordChange(state, t.pointer);
    return;
  }
  throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
}

// remove semantics at a non-root target; returns the removed value so
// `move` can re-insert it (RFC 6902 sections 4.2, 4.4).
function extractAt(state, t, docPath) {
  const parent = walkOwnedParent(state, t, docPath);
  if (Array.isArray(parent)) {
    const idx = t.lastName === '-' ? -1 : t.lastIndex;
    if (idx < 0)
      throw pathError('JP2002', `invalid array position '${t.lastName}' in '${t.pointer}'`, docPath, t.pointer);
    if (idx >= parent.length)
      throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
    const value = parent[idx];
    parent.splice(idx, 1);
    // removal shifts every later element: the whole array changed
    recordChange(state, t.parentPointer);
    return value;
  }
  if (isJsonObject(parent)) {
    const name = t.lastName;
    if (!hasOwn(parent, name))
      throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
    const value = parent[name];
    delete parent[name];
    recordChange(state, t.pointer);
    return value;
  }
  throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
}

// replace semantics at a non-root target: the location must already
// exist (RFC 6902 section 4.3).
function replaceAt(state, t, value, docPath) {
  const parent = walkOwnedParent(state, t, docPath);
  if (Array.isArray(parent)) {
    const idx = t.lastName === '-' ? -1 : t.lastIndex;
    if (idx < 0)
      throw pathError('JP2002', `invalid array position '${t.lastName}' in '${t.pointer}'`, docPath, t.pointer);
    if (idx >= parent.length)
      throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
    parent[idx] = value;
    recordChange(state, t.pointer);
    return;
  }
  if (isJsonObject(parent)) {
    const name = t.lastName;
    if (!hasOwn(parent, name))
      throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
    setObjectMember(parent, name, value);
    recordChange(state, t.pointer);
    return;
  }
  throw pathError('JP2001', `the path '${t.pointer}' does not exist`, docPath, t.pointer);
}

//#endregion

//#region patch compiler

/**
 * A single RFC 6902 operation object.
 * @typedef {{op: 'add'|'remove'|'replace'|'move'|'copy'|'test', path: string,
 *   value?: any, from?: string}} JsonPatchOperation
 */

/**
 * A compiled JSON Patch: applies the patch to a document and returns
 * the patched document.
 * @typedef {(doc: any) => any} JsonPatchApplier
 */

/**
 * A compiled JSON Patch with change tracking (`changes: true`): applies
 * the patch and returns the patched document together with the changed
 * locations (see `JsonPatchOptions`).
 * @typedef {(doc: any) => { doc: any, changes: string[] }} JsonPatchChangesApplier
 */

/**
 * Options for `compileJSONPatch` / `applyJSONPatch`.
 * @typedef {Object} JsonPatchOptions
 * @property {boolean} [mutate] - Apply in place instead of copy-on-write.
 *   Faster, but the input document is modified and a failing operation
 *   leaves it partially patched (application is no longer atomic).
 * @property {'share'|'fresh'} [values] - How operation values enter the
 *   result: `'share'` (default) inserts them by reference, so results of
 *   repeated applications share structure with the patch document and
 *   must be treated as immutable; `'fresh'` deep-copies per application.
 *   In-place mode always behaves as `'fresh'`.
 * @property {boolean} [changes] - Track changed locations: the applier
 *   returns `{ doc, changes }` where `changes` is an array of JSON
 *   Pointers, one per successful write, in application order and not
 *   deduplicated. The reported pointer is chosen to be *sound for
 *   invalidation* — everything at or below it (plus the identity of its
 *   ancestors) may have changed, and nothing outside the reported set
 *   did: object writes, array replaces and array appends report the
 *   written location itself; array inserts and removes that shift later
 *   elements report the parent array's pointer; a root write reports
 *   `''`. `test` operations report nothing.
 */

function compileError(code, message, docPath, cause) {
  return new JsonPatchCompileError(code, message, docPath, cause);
}

// Parse and pre-compile a target pointer (`path` or `from`): decoded
// member names alongside pre-scanned array indexes (one token, two
// forms), plus the split-off last token for the mutating operations.
function parseTarget(op, index, member) {
  const docPath = '/' + index + '/' + member;
  if (!hasOwn(op, member))
    throw compileError('JP0003', `the operation requires a '${member}' member`, docPath);
  const pointer = op[member];
  let names;
  try {
    names = parseJSONPointer(pointer);
  }
  catch (e) {
    throw compileError('JP0003', `invalid JSON Pointer in '${member}'`, docPath, e);
  }
  const len = names.length;
  const indexes = new Array(len);
  for (let i = 0; i < len; i++)
    indexes[i] = scanArrayIndex(names[i], 0, names[i].length);
  return {
    pointer,
    names,
    indexes,
    len,
    lastName: len === 0 ? '' : names[len - 1],
    lastIndex: len === 0 ? -1 : indexes[len - 1],
    // the parent location, for shift-style change reports (tokens never
    // contain a raw '/', so the last separator bounds the last token)
    parentPointer: len === 0 ? '' : pointer.slice(0, pointer.lastIndexOf('/')),
  };
}

function parseValueGetter(op, index, fresh) {
  if (!hasOwn(op, 'value'))
    throw compileError('JP0004', "the operation requires a 'value' member", '/' + index);
  const value = op.value;
  if (!isJsonContainer(value))
    return () => value;
  if (fresh)
    return () => cloneJson(value);
  return () => value;
}

function isProperPrefix(a, b) {
  const alen = a.length;
  if (alen >= b.length)
    return false;
  for (let i = 0; i < alen; i++) {
    if (a[i] !== b[i])
      return false;
  }
  return true;
}

function readSource(state, from, docPath) {
  const value = readTarget(state.root, from);
  if (value === NOTHING)
    throw pathError('JP2001', `the path '${from.pointer}' does not exist`, docPath, from.pointer);
  return value;
}

// Compile one operation object into a `(state) => void` closure with
// every pointer parsed, every index scanned and every docPath string
// pre-bound.
function compileOperation(op, index, fresh) {
  const docPath = '/' + index;
  if (!isJsonObject(op))
    throw compileError('JP0001', 'an operation must be an object', docPath);
  if (!hasOwn(op, 'op') || typeof op.op !== 'string')
    throw compileError('JP0002', "the operation requires a string 'op' member", docPath + '/op');
  switch (op.op) {
    case 'add': {
      const t = parseTarget(op, index, 'path');
      const getValue = parseValueGetter(op, index, fresh);
      if (t.len === 0) {
        return (state) => {
          state.root = getValue();
          recordChange(state, '');
        };
      }
      return (state) => {
        insertAt(state, t, getValue(), docPath);
      };
    }
    case 'remove': {
      const t = parseTarget(op, index, 'path');
      if (t.len === 0) {
        return () => {
          throw pathError('JP2003', 'the root of the document cannot be removed', docPath, '');
        };
      }
      return (state) => {
        extractAt(state, t, docPath);
      };
    }
    case 'replace': {
      const t = parseTarget(op, index, 'path');
      const getValue = parseValueGetter(op, index, fresh);
      if (t.len === 0) {
        return (state) => {
          state.root = getValue();
          recordChange(state, '');
        };
      }
      return (state) => {
        replaceAt(state, t, getValue(), docPath);
      };
    }
    case 'move': {
      const from = parseTarget(op, index, 'from');
      const t = parseTarget(op, index, 'path');
      if (isProperPrefix(from.names, t.names))
        throw compileError('JP0005', "'from' may not be a proper prefix of 'path' in a move", docPath + '/from');
      if (from.len === 0)
        return () => { }; // '' to '' - moving the root onto itself
      if (t.len === 0) {
        return (state) => {
          state.root = extractAt(state, from, docPath);
          recordChange(state, '');
        };
      }
      return (state) => {
        insertAt(state, t, extractAt(state, from, docPath), docPath);
      };
    }
    case 'copy': {
      const from = parseTarget(op, index, 'from');
      const t = parseTarget(op, index, 'path');
      if (t.len === 0) {
        return (state) => {
          state.root = copyForInsert(readSource(state, from, docPath), state.owned);
          recordChange(state, '');
        };
      }
      return (state) => {
        insertAt(state, t, copyForInsert(readSource(state, from, docPath), state.owned), docPath);
      };
    }
    case 'test': {
      const t = parseTarget(op, index, 'path');
      if (!hasOwn(op, 'value'))
        throw compileError('JP0004', "the operation requires a 'value' member", docPath);
      const value = op.value;
      return (state) => {
        const actual = readTarget(state.root, t);
        if (actual === NOTHING)
          throw pathError('JP2004', `test failed: no value at '${t.pointer}'`, docPath, t.pointer);
        if (!equalsJson(actual, value))
          throw pathError('JP2004', `test failed at '${t.pointer}'`, docPath, t.pointer);
      };
    }
    default:
      throw compileError('JP0002', `unknown operation '${op.op}'`, docPath + '/op');
  }
}

/** The members `compileJSONPatch` / `applyJSONPatch` read; any other is refused. */
const PATCH_OPTIONS = Object.freeze(['mutate', 'values', 'changes']);
/** The members `createJSONPatch` reads. */
const DIFF_OPTIONS = Object.freeze(['arrayDiff']);

/**
 * Refuse an options object that is not plain, or that carries a member
 * outside `known` - a misspelt `mutated` would otherwise silently leave
 * the document copied, a misspelt `change` the bare result unwrapped. A
 * host programming error, so a `TypeError` naming the nearest member.
 * @param {unknown} options @param {readonly string[]} known @param {string} owner
 */
function admitPatchOptions(options, known, owner) {
  if (!isPlainOptions(options)) throw new TypeError(`${owner}: options must be a plain object`);
  refuseUnknownMembers(options, known, (key, hint) => new TypeError(`${owner}: unknown option '${key}'${hint}`));
}

/** A boolean switch: absent (undefined) is off, anything but a boolean is refused.
 * @param {Record<string, any>} options @param {string} name @returns {boolean} */
function readSwitch(options, name) {
  const value = options[name];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`compileJSONPatch: '${name}' must be true or false`);
  return value;
}

/**
 * Compile a JSON Patch (RFC 6902) into a reusable applier.
 *
 * The patch document is validated once (`JsonPatchCompileError`,
 * `JP0xxx`, with a `docPath` into the patch document); every pointer is
 * pre-parsed and each operation becomes a specialized closure. Applying
 * is copy-on-write: the input document is never mutated, untouched
 * subtrees are shared with the result, and application is atomic - a
 * failing operation (`JsonPatchRuntimeError`, `JP2xxx`) leaves nothing
 * behind.
 *
 * With `changes: true` the applier is specialized at compile time to
 * also report the changed locations: it returns `{ doc, changes }`,
 * where `changes` holds one JSON Pointer per successful write with the
 * invalidation-sound semantics documented on `JsonPatchOptions` — the
 * primitive dirty-path consumers (view re-rendering, rule dependency
 * memoization) build on.
 *
 * @param {JsonPatchOperation[]} patch - The RFC 6902 patch document
 * @param {JsonPatchOptions} [options] - Application options
 * @returns {JsonPatchApplier | JsonPatchChangesApplier} applier
 *   returning the patched document (or `{ doc, changes }` with the
 *   `changes` option)
 * @throws {JsonPatchCompileError} When the patch document is invalid
 * @throws {TypeError} When `options` is not a plain object, names a member
 *   other than `mutate`, `values` and `changes`, or gives one a value of the
 *   wrong type
 * @example
 * const apply = compileJSONPatch([
 *   { op: 'test', path: '/version', value: 5 },
 *   { op: 'replace', path: '/user/name', value: 'Bob' },
 *   { op: 'add', path: '/user/tags/-', value: 'admin' },
 * ]);
 * const next = apply(doc); // doc is untouched
 * @example
 * const applyTracked = compileJSONPatch(
 *   [{ op: 'replace', path: '/user/name', value: 'Bob' }],
 *   { changes: true });
 * const { doc: next2, changes } = applyTracked(doc);
 * // changes: ['/user/name']
 */
export function compileJSONPatch(patch, options = undefined) {
  let mutate = false;
  let values = 'share';
  let changes = false;
  if (options !== undefined && options !== null) {
    admitPatchOptions(options, PATCH_OPTIONS, 'compileJSONPatch');
    mutate = readSwitch(options, 'mutate');
    if (options.values !== undefined) {
      if (options.values !== 'share' && options.values !== 'fresh')
        throw new TypeError(`compileJSONPatch: unknown 'values' option '${options.values}'`);
      values = options.values;
    }
    changes = readSwitch(options, 'changes');
  }
  const fresh = mutate || values === 'fresh';
  if (!Array.isArray(patch))
    throw compileError('JP0001', 'a JSON Patch document must be an array of operations', '');
  const plen = patch.length;
  const ops = new Array(plen);
  for (let i = 0; i < plen; i++)
    ops[i] = compileOperation(patch[i], i, fresh);
  if (changes) {
    const owned = mutate ? null : undefined;
    return function applyJsonPatchTracked(doc) {
      const state = makeState(doc, owned === null ? null : new Set());
      state.changes = [];
      for (let i = 0; i < plen; i++)
        ops[i](state);
      return { doc: state.root, changes: state.changes };
    };
  }
  if (mutate) {
    return function applyJsonPatchInPlace(doc) {
      const state = makeState(doc, null);
      state.changes = null;
      for (let i = 0; i < plen; i++)
        ops[i](state);
      return state.root;
    };
  }
  return function applyJsonPatchCow(doc) {
    const state = makeState(doc, new Set());
    state.changes = null;
    for (let i = 0; i < plen; i++)
      ops[i](state);
    return state.root;
  };
}

/**
 * Apply a JSON Patch (RFC 6902) to a document in one shot. Compiles the
 * patch and applies it once; on hot paths prefer `compileJSONPatch` and
 * reuse the applier.
 *
 * @param {any} doc - The document to patch (never mutated unless
 *   `options.mutate` is set)
 * @param {JsonPatchOperation[]} patch - The RFC 6902 patch document
 * @param {JsonPatchOptions} [options] - Application options
 * @returns {any} The patched document, or `{ doc, changes }` when
 *   `options.changes` is set
 * @throws {JsonPatchCompileError} When the patch document is invalid
 * @throws {JsonPatchRuntimeError} When an operation fails to apply
 * @throws {TypeError} When `options` is malformed, as for `compileJSONPatch`
 */
export function applyJSONPatch(doc, patch, options = undefined) {
  return compileJSONPatch(patch, options)(doc);
}

/**
 * Returns true when `patch` is a structurally valid RFC 6902 patch
 * document (an array of well-formed operation objects with valid
 * pointers). Runtime applicability against a document is not checked.
 * @param {any} patch - The candidate patch document
 * @returns {boolean}
 */
export function isValidJSONPatch(patch) {
  try {
    compileJSONPatch(patch);
    return true;
  }
  catch (e) {
    if (e instanceof JsonPatchCompileError)
      return false;
    /* c8 ignore next -- compile only throws JsonPatchCompileError */
    throw e;
  }
}

//#endregion

//#region structural diff (RFC 6902)

function appendPointer(path, key) {
  return path + '/' + encodeJSONPointerSegment(key);
}

// The diff keeps its own stack instead of recursing per level, so the
// nesting it can reach is not the host's call stack: a member pair of two
// containers of one kind is not diffed where it is met, it is emitted into
// the op list as a DiffPair, and `createJSONPatch` diffs it in its place,
// so the ops come out in the order a recursive walk emits them.
class DiffPair {
  /**
   * @param {any} src
   * @param {any} tgt
   * @param {string} path
   * @param {number} depth - Containers from the root down to this pair
   */
  constructor(src, tgt, path, depth) {
    this.src = src;
    this.tgt = tgt;
    this.path = path;
    this.depth = depth;
  }
}

// Emit what one pair of values needs: nothing for one reference, a
// DiffPair for two arrays or two objects, else a replace unless the two
// are deep-equal.
function diffChild(src, tgt, path, out, depth) {
  if (src === tgt)
    return;
  const sArr = Array.isArray(src);
  const tArr = Array.isArray(tgt);
  if (sArr ? tArr : !tArr && isJsonContainer(src) && isJsonContainer(tgt))
    out.push(new DiffPair(src, tgt, path, depth));
  else if (!equalsJson(src, tgt))
    out.push({ op: 'replace', path, value: tgt });
}

function diffObject(src, tgt, path, out, depth) {
  for (const key in src) {
    if (!hasOwn(src, key))
      continue;
    if (!hasOwn(tgt, key))
      out.push({ op: 'remove', path: appendPointer(path, key) });
    else
      diffChild(src[key], tgt[key], appendPointer(path, key), out, depth + 1);
  }
  for (const key in tgt) {
    if (hasOwn(tgt, key) && !hasOwn(src, key))
      out.push({ op: 'add', path: appendPointer(path, key), value: tgt[key] });
  }
}

// Emit the ops for one gap between two aligned (deep-equal) elements:
// `sRun` source elements at src[si...] became `tRun` target elements at
// tgt[ti...]. Overlapping positions are diffed in place - an edited
// element stays one `replace` rather than a remove plus an add - and the
// length difference is appended or removed.
//
// `cur` is the position of src[si] in the document as the ops so far
// have left it: an `add` shifts everything after it right (so the next
// insert goes one further along), while repeated `remove`s all land on
// the same index (each one shifts the rest left onto it).
function diffArrayGap(src, si, sRun, tgt, ti, tRun, cur, path, out, depth) {
  const both = sRun < tRun ? sRun : tRun;
  for (let k = 0; k < both; k++)
    diffChild(src[si + k], tgt[ti + k], path + '/' + (cur + k), out, depth + 1);
  if (tRun > both) {
    for (let k = both; k < tRun; k++)
      out.push({ op: 'add', path: path + '/' + (cur + k), value: tgt[ti + k] });
    return cur + tRun;
  }
  const at = path + '/' + (cur + both);
  for (let k = both; k < sRun; k++)
    out.push({ op: 'remove', path: at });
  return cur + both;
}

// Cell budget for the alignment table: beyond this the quadratic
// alignment costs more than the ops it saves, so the index-wise diff
// answers instead - still correct, just not minimal.
const ALIGN_MAX_CELLS = 1 << 20;

// Intern one element's stable serialization to an integer id, so the
// alignment's inner loop compares integers instead of walking two
// subtrees. The ids only ever act as a filter: different ids mean
// certainly different values, equal ids still have to pass the real
// comparison - so a collision costs one wasted comparison and can never
// align two unequal elements.
function internElement(ids, value) {
  const key = stableStringify(value);
  let id = ids.get(key);
  if (id === undefined) {
    id = ids.size;
    ids.set(key, id);
  }
  return id;
}

// Align src[s0,s1) with tgt[t0,t1) and emit the ops for the alignment.
//
// The cost model is the patch itself: keeping a deep-equal pair is free,
// rewriting one position in place is one step, and so is inserting or
// deleting a single element. Minimizing that is edit distance WITH
// substitutions, not a longest common subsequence - LCS maximizes kept
// elements, which is a different thing and loses on a permutation, where
// it pays a delete plus an insert for what one rewrite covers.
//
// Because pairing every overlapping position is itself a valid
// alignment, the result never takes more steps than the index-wise diff.
//
// `cur` tracks where the current source element sits in the document as
// the ops emitted so far have left it: an insert shifts the rest right,
// a delete shifts it left onto the same index.
function diffArrayAligned(src, s0, s1, tgt, t0, t1, path, out, depth) {
  const m = s1 - s0;
  const n = t1 - t0;
  const ids = new Map();
  const sk = new Int32Array(m);
  const tk = new Int32Array(n);
  for (let i = 0; i < m; i++)
    sk[i] = internElement(ids, src[s0 + i]);
  for (let j = 0; j < n; j++)
    tk[j] = internElement(ids, tgt[t0 + j]);

  // backward DP, so the alignment replays front to back - the order the
  // ops have to be emitted in
  const width = n + 1;
  const dp = new Uint32Array((m + 1) * width);
  const last = m * width;
  for (let j = n - 1; j >= 0; j--)
    dp[last + j] = n - j;
  for (let i = m - 1; i >= 0; i--) {
    const row = i * width;
    const next = row + width;
    dp[row + n] = m - i;
    const key = sk[i];
    for (let j = n - 1; j >= 0; j--) {
      const same = key === tk[j] && equalsJson(src[s0 + i], tgt[t0 + j]);
      let best = dp[next + j + 1] + (same ? 0 : 1);
      const del = dp[next + j] + 1;
      if (del < best)
        best = del;
      const ins = dp[row + j + 1] + 1;
      if (ins < best)
        best = ins;
      dp[row + j] = best;
    }
  }

  let i = 0;
  let j = 0;
  let cur = s0;
  while (i < m && j < n) {
    const row = i * width;
    const next = row + width;
    const same = sk[i] === tk[j] && equalsJson(src[s0 + i], tgt[t0 + j]);
    const best = dp[row + j];
    if (best === dp[next + j + 1] + (same ? 0 : 1)) {
      if (!same)
        diffChild(src[s0 + i], tgt[t0 + j], path + '/' + cur, out, depth + 1);
      i++;
      j++;
      cur++;
    }
    else if (best === dp[next + j] + 1) {
      out.push({ op: 'remove', path: path + '/' + cur });
      i++;
    }
    else {
      out.push({ op: 'add', path: path + '/' + cur, value: tgt[t0 + j] });
      j++;
      cur++;
    }
  }
  for (; i < m; i++)
    out.push({ op: 'remove', path: path + '/' + cur });
  for (; j < n; j++, cur++)
    out.push({ op: 'add', path: path + '/' + cur, value: tgt[t0 + j] });
}

// Array diff. Both modes first trim the deep-equal common prefix and
// suffix, which alone makes in-place edits and head/tail insertions
// minimal and bounds the work to the changed middle.
//
// What differs is the middle. The default pairs it up index-wise, which
// is linear but turns a mid-array insertion into a run of per-index
// replaces (correct, not minimal). `arrayDiff: 'minimal'` aligns the
// middle instead, so an insertion or deletion is emitted as one op and
// only genuinely changed positions are rewritten - at O(m*n) time and
// space in the size of that middle.
function diffArray(src, tgt, path, out, lcs, depth) {
  const slen = src.length;
  const tlen = tgt.length;
  const minLen = slen < tlen ? slen : tlen;
  let start = 0;
  while (start < minLen && equalsJson(src[start], tgt[start]))
    start++;
  let sEnd = slen;
  let tEnd = tlen;
  while (sEnd > start && tEnd > start && equalsJson(src[sEnd - 1], tgt[tEnd - 1])) {
    sEnd--;
    tEnd--;
  }
  const sMid = sEnd - start;
  const tMid = tEnd - start;
  if (sMid === 0 && tMid === 0)
    return;

  // one run of pure inserts or pure deletes needs no alignment, and the
  // budget keeps a large middle from turning quadratic
  if (!lcs || sMid === 0 || tMid === 0 || (sMid + 1) * (tMid + 1) > ALIGN_MAX_CELLS) {
    diffArrayGap(src, start, sMid, tgt, start, tMid, start, path, out, depth);
    return;
  }
  diffArrayAligned(src, start, sEnd, tgt, start, tEnd, path, out, depth);
}

// Diff `source` into `target`, expanding each DiffPair where it stands.
function diffDocuments(source, target, lcs) {
  const out = [];
  /** @type {any[]} */
  const stack = [];
  diffChild(source, target, '', stack, 1);
  while (stack.length > 0) {
    const item = stack.pop();
    if (!(item instanceof DiffPair)) {
      out.push(item);
      continue;
    }
    if (item.depth > JSON_WALK_DEPTH_CEILING)
      throw walkTooDeep('diffed');
    const items = [];
    if (Array.isArray(item.src))
      diffArray(item.src, item.tgt, item.path, items, lcs, item.depth);
    else
      diffObject(item.src, item.tgt, item.path, items, item.depth);
    // the ops before the first pair need no stacking
    let first = 0;
    while (first < items.length && !(items[first] instanceof DiffPair))
      out.push(items[first++]);
    for (let i = items.length - 1; i >= first; i--)
      stack.push(items[i]);
  }
  return out;
}

/**
 * Compute a JSON Patch (RFC 6902) that transforms `source` into
 * `target`: `applyJSONPatch(source, createJSONPatch(source, target))`
 * is deep-equal to `target`.
 *
 * Objects diff member-wise; arrays trim the common prefix/suffix and
 * diff the middle index-wise, so in-place edits and head/tail
 * insertions produce minimal patches while a mid-array insertion falls
 * back to correct (but larger) per-index replaces. Emitted `value`
 * members share references with `target`.
 *
 * `arrayDiff: 'minimal'` aligns the changed middle instead, so a
 * mid-array insertion or deletion is emitted as one `add`/`remove` —
 * the smallest patch, which is what matters when patches go over the
 * wire. The alignment minimizes the patch itself (edit distance with
 * substitutions, not a longest common subsequence: LCS maximizes kept
 * elements, which costs a delete plus an insert on a permutation where
 * one rewrite would do), so it never takes more alignment steps than
 * the index-wise pairing.
 *
 * It is opt-in because it costs O(m*n) time and space in the length of
 * that middle, against the default's linear pass; above a fixed cell
 * budget a single array falls back to the index-wise diff, so the mode
 * never turns a large diff quadratic. Both modes produce patches that
 * reproduce `target` exactly.
 *
 * @param {any} source - The original document
 * @param {any} target - The desired document
 * @param {{ arrayDiff?: 'index' | 'minimal' }} [options] - `arrayDiff`
 *   selects the array strategy: `'index'` (default) or `'minimal'`
 * @returns {JsonPatchOperation[]} The patch document (empty when equal)
 * @throws {TypeError} When `options` is not a plain object, names a member
 *   other than `arrayDiff`, or `arrayDiff` is not a known mode
 * @example
 * createJSONPatch({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
 * // [{ op: 'replace', path: '/b', value: 3 },
 * //  { op: 'add', path: '/c', value: 4 }]
 * @example
 * const before = [{ id: 1 }, { id: 2 }, { id: 3, n: 0 }];
 * const after = [{ id: 1 }, { id: 9 }, { id: 2 }, { id: 3, n: 1 }];
 * createJSONPatch(before, after, { arrayDiff: 'minimal' });
 * // [{ op: 'add', path: '/1', value: { id: 9 } },
 * //  { op: 'replace', path: '/3/n', value: 1 }]
 */
export function createJSONPatch(source, target, options = undefined) {
  if (options != null) admitPatchOptions(options, DIFF_OPTIONS, 'createJSONPatch');
  const mode = options == null || options.arrayDiff === undefined
    ? 'index'
    : options.arrayDiff;
  if (mode !== 'index' && mode !== 'minimal')
    throw new TypeError(`unknown 'arrayDiff' option '${mode}'`);
  try {
    return diffDocuments(source, target, mode === 'minimal');
  }
  catch (error) {
    throw diffRefusal(error, source, target);
  }
}

/**
 * The refusal of a walk that reached `JSON_WALK_DEPTH_CEILING`, the one
 * `@jarenjs/core/object` raises there: a cycle in one of `roots` is
 * named as one at the member that closes it (`locateCycle`), a
 * `JsonCycleError` `JO2002`; a value without one is too deep (`JO2001`).
 * @param {string} verb - What could not be done, in the passive
 * @param {any[]} roots - The values the walk started from
 * @param {string[]} [names] - Each root's name, for a walk over several
 * @returns {CodedError}
 */
function walkRefusal(verb, roots, names = undefined) {
  for (let i = 0; i < roots.length; i++) {
    const at = locateCycle(roots[i]);
    if (at !== undefined)
      return new CodedError('JsonCycleError', 'JO2002',
        `a circular reference${names === undefined ? '' : ` in ${names[i]}`} cannot be ${verb}`, at);
  }
  return walkTooDeep(verb);
}

const DIFFED_DOCUMENTS = ['the source', 'the target'];

/**
 * What a diff throws for an error raised inside it. The walk bound is met
 * by the diff's own walk or by the `equalsJson` and `stableStringify` it
 * calls on a subtree, whose cycle pointer is the subtree's; a cycle is
 * named from the documents' roots instead (`JO2002`), and a refusal of a
 * value without one (`JO2001`) and every other error pass unchanged.
 * @param {unknown} error
 * @param {any} source
 * @param {any} target
 * @returns {unknown}
 */
function diffRefusal(error, source, target) {
  const code = /** @type {any} */ (error)?.code;
  if (!(error instanceof Error) || (code !== 'JO2001' && code !== 'JO2002'))
    return error;
  const refusal = walkRefusal('diffed', [source, target], DIFFED_DOCUMENTS);
  return refusal.code === 'JO2002' || code === 'JO2002' ? refusal : error;
}

//#endregion

//#region JSON Merge Patch (RFC 7396)

/**
 * A compiled JSON Merge Patch: applies the merge patch to a document
 * and returns the patched document.
 * @typedef {(doc: any) => any} JsonMergePatchApplier
 */

// One merge-patch object level, split once into removes (null members),
// scalar/array sets and nested-object merges; `merges` holds the plan of
// each nested level, filled by `compileMergePlan`.
function splitMergeLevel(patch) {
  const removes = [];
  const setKeys = [];
  const setVals = [];
  const mergeKeys = [];
  const mergePatches = [];
  for (const key in patch) {
    if (!hasOwn(patch, key))
      continue;
    const v = patch[key];
    if (v === null) {
      removes.push(key);
    }
    else if (isJsonObject(v)) {
      mergeKeys.push(key);
      mergePatches.push(v);
    }
    else {
      setKeys.push(key);
      setVals.push(v);
    }
  }
  return {
    removes,
    removeSet: removes.length > 0 ? new Set(removes) : null,
    setKeys,
    setVals,
    mergeKeys,
    mergePatches,
    merges: [],
  };
}

// The plans of a merge patch's object levels, split on their own stack
// instead of recursing per level, so the nesting a patch can reach is not
// the host's call stack; past JSON_WALK_DEPTH_CEILING levels it is
// refused, as the diff that writes such patches refuses.
function compileMergePlan(patch) {
  const root = splitMergeLevel(patch);
  const open = [root];
  const depths = [1];
  while (open.length > 0) {
    const plan = open.pop();
    const depth = depths.pop() + 1;
    for (let i = 0; i < plan.mergePatches.length; i++) {
      if (depth > JSON_WALK_DEPTH_CEILING)
        throw walkRefusal('applied', [patch]);
      const child = splitMergeLevel(plan.mergePatches[i]);
      plan.merges.push(child);
      open.push(child);
      depths.push(depth);
    }
  }
  return root;
}

// The value one level merges `target` into, given the merged value of
// each of its nested levels. RFC 7396: a non-object target is replaced by
// merging into {}. An object target the level does not change comes back
// by reference; otherwise its members are copied, the removed ones left out.
function mergeLevel(plan, target, merged) {
  const removes = plan.removes;
  const setKeys = plan.setKeys;
  const setVals = plan.setVals;
  const mergeKeys = plan.mergeKeys;
  const isObject = isJsonObject(target);
  if (isObject) {
    let changed = false;
    for (let i = 0; i < removes.length && !changed; i++)
      changed = hasOwn(target, removes[i]);
    for (let i = 0; i < setKeys.length && !changed; i++)
      changed = !hasOwn(target, setKeys[i]) || target[setKeys[i]] !== setVals[i];
    for (let i = 0; i < mergeKeys.length && !changed; i++)
      changed = merged[i] !== (hasOwn(target, mergeKeys[i]) ? target[mergeKeys[i]] : undefined);
    if (!changed)
      return target;
  }
  const out = {};
  if (isObject) {
    const removeSet = plan.removeSet;
    for (const key in target) {
      if (!hasOwn(target, key))
        continue;
      if (removeSet !== null && removeSet.has(key))
        continue;
      setObjectMember(out, key, target[key]);
    }
  }
  for (let i = 0; i < setKeys.length; i++)
    setObjectMember(out, setKeys[i], setVals[i]);
  for (let i = 0; i < mergeKeys.length; i++)
    setObjectMember(out, mergeKeys[i], merged[i]);
  return out;
}

// Apply a merge plan on its own stack of open levels: a nested level's
// value joins its parent when it closes, in the patch's member order; a
// level without nested levels closes where it is reached.
function applyMergePlan(root, doc) {
  if (root.mergeKeys.length === 0)
    return mergeLevel(root, doc, null);
  const frames = [];
  let frame = { plan: root, target: doc, merged: new Array(root.mergeKeys.length), at: 0 };
  for (;;) {
    const { plan, target } = frame;
    if (frame.at < plan.mergeKeys.length) {
      const key = plan.mergeKeys[frame.at];
      const child = plan.merges[frame.at];
      const prev = isJsonObject(target) && hasOwn(target, key) ? target[key] : undefined;
      if (child.mergeKeys.length === 0) {
        frame.merged[frame.at++] = mergeLevel(child, prev, null);
        continue;
      }
      frames.push(frame);
      frame = { plan: child, target: prev, merged: new Array(child.mergeKeys.length), at: 0 };
      continue;
    }
    const value = mergeLevel(plan, target, frame.merged);
    const parent = frames.pop();
    if (parent === undefined)
      return value;
    parent.merged[parent.at++] = value;
    frame = parent;
  }
}

/**
 * Compile a JSON Merge Patch (RFC 7396) into a reusable applier.
 *
 * The patch pre-splits once into remove/set/merge plans per level.
 * Applying is copy-on-write and identity-preserving: unchanged subtrees
 * (and a wholly unchanged document) come back by reference, set values
 * are shared with the patch document, and the input is never mutated.
 *
 * @param {any} patch - The merge patch (any JSON value; a non-object
 *   replaces the document wholesale)
 * @returns {JsonMergePatchApplier} applier returning the patched document
 * @example
 * const apply = compileMergePatch({ age: 31, temp: null });
 * apply({ name: 'Alice', age: 30, temp: 'x' });
 * // { name: 'Alice', age: 31 }
 */
export function compileMergePatch(patch) {
  if (!isJsonObject(patch)) {
    return function applyMergeReplace() {
      return patch;
    };
  }
  const plan = compileMergePlan(patch);
  return function applyMerge(doc) {
    return applyMergePlan(plan, doc);
  };
}

/**
 * Apply a JSON Merge Patch (RFC 7396) to a document in one shot. On hot
 * paths prefer `compileMergePatch` and reuse the applier.
 *
 * @param {any} doc - The document to patch (never mutated)
 * @param {any} patch - The merge patch
 * @returns {any} The patched document
 */
export function applyMergePatch(doc, patch) {
  return compileMergePatch(patch)(doc);
}

function isEmptyObjectShallow(obj) {
  for (const key in obj) {
    if (hasOwn(obj, key))
      return false;
  }
  return true;
}

// One object pair `diffMergeObjects` has open: the removals are written
// when it opens, then `at` walks the target's members; `key` names the
// member whose pair is open above this one.
function openMergeFrame(src, tgt) {
  const patch = {};
  for (const key in src) {
    if (hasOwn(src, key) && !hasOwn(tgt, key))
      setObjectMember(patch, key, null);
  }
  return { src, tgt, keys: Object.keys(tgt), at: 0, key: '', patch };
}

// The merge diff keeps its own stack of open object pairs instead of
// recursing per level, so the nesting it can reach is not the host's
// call stack; a nested patch joins its parent when its pair closes, in
// the member order a recursive walk writes.
function diffMergeObjects(src, tgt) {
  const frames = [];
  let frame = openMergeFrame(src, tgt);
  for (;;) {
    const keys = frame.keys;
    if (frame.at < keys.length) {
      const key = keys[frame.at++];
      const tv = frame.tgt[key];
      if (!hasOwn(frame.src, key)) {
        // an added member with value null is unrepresentable (null means
        // remove); either way the key ends up absent after applying
        if (tv !== null)
          setObjectMember(frame.patch, key, tv);
        continue;
      }
      const sv = frame.src[key];
      if (sv === tv)
        continue;
      if (isJsonObject(sv) && isJsonObject(tv)) {
        frame.key = key;
        frames.push(frame);
        if (frames.length >= JSON_WALK_DEPTH_CEILING)
          throw walkTooDeep('diffed');
        frame = openMergeFrame(sv, tv);
      }
      else if (!equalsJson(sv, tv)) {
        setObjectMember(frame.patch, key, tv);
      }
      continue;
    }
    const parent = frames.pop();
    if (parent === undefined)
      return frame.patch;
    if (!isEmptyObjectShallow(frame.patch))
      setObjectMember(parent.patch, parent.key, frame.patch);
    frame = parent;
  }
}

/**
 * Compute a JSON Merge Patch (RFC 7396) that transforms `source` into
 * `target`. Removed members become `null`, nested objects diff
 * recursively, and arrays (or any kind change) replace wholesale.
 *
 * RFC 7396 cannot represent a member whose target value is `null`:
 * the diff emits `null` (a removal), so applying yields an absent
 * member instead. Emitted values share references with `target`.
 *
 * @param {any} source - The original document
 * @param {any} target - The desired document
 * @returns {any} The merge patch (`{}` when nothing changed)
 * @example
 * createMergePatch({ a: 'b', c: 1 }, { a: 'x' });
 * // { a: 'x', c: null }
 */
export function createMergePatch(source, target) {
  if (!isJsonObject(source) || !isJsonObject(target))
    return target;
  try {
    return diffMergeObjects(source, target);
  }
  catch (error) {
    throw diffRefusal(error, source, target);
  }
}

//#endregion

//#endregion
