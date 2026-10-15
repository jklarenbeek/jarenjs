//@ts-check

import {
  isFn,
  isScalarType,
  isBooleanType,
  isTypedArray,
} from './index.js';
import { compareCodePoints, hashContent } from './string.js';
import { CodedError } from './errors.js';
import { JSON_WALK_DEPTH_CEILING, WALK_CEILING, locateCycle, locateCycleIn, walkRefusal, walkTooDeep } from './walk.js';

export { locateCycle };

const hasOwn = Object.hasOwn;

/**
 * Deep equality comparison for arbitrary values.
 *
 * Generic JavaScript equality: understands Maps, Sets, RegExps, Dates,
 * functions, typed arrays and class instances (prototype constructors
 * must match; an own `constructor` member is data). Not the same as
 * `equalsJson`, which compares JSON values
 * only and is the hot-path variant — keep both.
 * @param {any} target
 * @param {any} source
 * @returns {boolean}
 */
export function equalsDeep(target, source) {
  if (target === source) return true;
  if (target == null) return false;
  if (source == null) return false;
  if (isBooleanType(target)) return false;
  if (isBooleanType(source)) return false;

  if (isFn(target))
    return isFn(source) && target.toString() === source.toString();

  if (isScalarType(target))
    return false;

  const constructor = Object.getPrototypeOf(target)?.constructor;
  if (constructor !== Object.getPrototypeOf(source)?.constructor)
    return false;

  if (constructor === Object) {
    const tks = Object.keys(target);
    const sks = Object.keys(source);
    if (tks.length !== sks.length)
      return false;
    for (let i = 0; i < tks.length; ++i) {
      const key = tks[i];
      if (!hasOwn(source, key) || !equalsDeep(target[key], source[key]))
        return false;
    }
    return true;
  }

  if (constructor === Map) {
    if (target.size !== source.size)
      return false;
    for (const [key, value] of target) {
      if (source.has(key) === false)
        return false;
      if (!equalsDeep(value, source.get(key)))
        return false;
    }
    return true;
  }

  if (constructor === Array) {
    if (target.length !== source.length)
      return false;
    for (let i = 0; i < target.length; ++i) {
      if (!equalsDeep(target[i], source[i]))
        return false;
    }
    return true;
  }

  if (constructor === Set) {
    if (target.size !== source.size)
      return false;
    for (const value of target) {
      if (source.has(value) === false)
        return false;
    }
    return true;
  }

  if (constructor === RegExp) {
    return target.toString() === source.toString();
  }

  // a Date holds its instant in an internal slot, not in a member
  if (constructor === Date)
    return Object.is(target.getTime(), source.getTime());

  if (isTypedArray(target)) {
    if (target.length !== source.length)
      return false;
    for (let i = 0; i < target.length; ++i) {
      if (target[i] !== source[i])
        return false;
    }
    return true;
  }

  // we could test for instance of Array, Map and Set in order
  // to differentiate between types of equality.. but we dont.
  const tkeys = Object.keys(target);
  const skeys = Object.keys(source);
  if (tkeys.length !== skeys.length) return false;
  if (tkeys.length === 0) return true;
  for (let i = 0; i < tkeys.length; ++i) {
    const key = tkeys[i];
    if (!hasOwn(source, key) || !equalsDeep(target[key], source[key]))
      return false;
  }
  return true;
}


/**
 * Structural equality of two JSON values per RFC 9535 section 2.3.5.2.2.
 *
 * JSON-only equality: objects compare by own enumerable keys, arrays by
 * index, primitives by `===` (so `1 === 1.0`, and `NaN` is never equal).
 * Other objects also compare by own enumerable keys: constructors and
 * non-enumerable Map/Set entries are ignored. Functions compare by identity.
 * Deliberately not the same as
 * `equalsDeep`, the generic JavaScript variant: this is the hot-path
 * comparator of the JSONPath engine — do not merge the two.
 *
 * Past 256 levels the walk keeps its own stack, so it does not overflow
 * the host's: a value nested deeper than 10000 levels, past any nesting a
 * default host stack could compare, is refused with a `JsonDepthError`
 * `JO2001` (`a value nested deeper than 10000 levels cannot be compared`),
 * and a pair the walk follows into a cycle with a `JsonCycleError`
 * `JO2002` that names the value and the member closing the cycle
 * (`a circular reference in the first value cannot be compared at /self`,
 * the pointer {@link locateCycle} answers). One reference compared with
 * itself answers `true` at any depth, without a walk.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle
 */
export function equalsJson(a, b) {
  try {
    return equalsJsonAt(a, b, 1);
  }
  catch (error) {
    throw error === WALK_CEILING ? walkRefusal('compared', [a, b], COMPARED_VALUES) : error;
  }
}

// The names `equalsJson`'s refusal gives its two roots.
const COMPARED_VALUES = ['the first value', 'the second value'];

// The nesting `equalsJson` compares on the host's call stack, the fast
// path every ordinary value takes: a recursive walk stops at the first
// difference in member order. A pair nested deeper continues on
// `equalsJsonWalk`, which keeps its own stack.
const RECURSIVE_COMPARE_DEPTH = 256;

/**
 * `equalsJson` for a pair `depth` containers down from the root.
 * @param {any} a
 * @param {any} b
 * @param {number} depth
 * @returns {boolean}
 */
function equalsJsonAt(a, b, depth) {
  if (a === b)
    return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return false;
  if (depth > RECURSIVE_COMPARE_DEPTH)
    return equalsJsonWalk(a, b, depth);
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return false;
  if (aIsArray) {
    const alen = a.length;
    if (alen !== b.length)
      return false;
    for (let i = 0; i < alen; i++) {
      if (!equalsJsonAt(a[i], b[i], depth + 1))
        return false;
    }
    return true;
  }
  let count = 0;
  for (const key in a) {
    if (!hasOwn(a, key))
      continue;
    if (!hasOwn(b, key) || !equalsJsonAt(a[key], b[key], depth + 1))
      return false;
    count++;
  }
  for (const key in b) {
    if (hasOwn(b, key))
      count--;
  }
  return count === 0;
}

/**
 * `equalsJson` for two containers `depth` levels down, on an explicit
 * stack of the pairs still to compare, so the nesting it reaches is not
 * the host's call stack; past `JSON_WALK_DEPTH_CEILING` it throws
 * `WALK_CEILING`, which `equalsJson` turns into its refusal.
 * @param {any} a - An array or object
 * @param {any} b - An array or object
 * @param {number} depth
 * @returns {boolean}
 */
function equalsJsonWalk(a, b, depth) {
  /** @type {any[]} */
  const pending = [];
  for (;;) {
    if (depth > JSON_WALK_DEPTH_CEILING)
      throw WALK_CEILING;
    const aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b))
      return false;
    if (aIsArray) {
      const alen = a.length;
      if (alen !== b.length)
        return false;
      for (let i = 0; i < alen; i++) {
        const x = a[i];
        const y = b[i];
        if (x === y)
          continue;
        if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null)
          return false;
        pending.push(x, y, depth + 1);
      }
    }
    else {
      let count = 0;
      for (const key in a) {
        if (!hasOwn(a, key))
          continue;
        if (!hasOwn(b, key))
          return false;
        count++;
        const x = a[key];
        const y = b[key];
        if (x === y)
          continue;
        if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null)
          return false;
        pending.push(x, y, depth + 1);
      }
      for (const key in b) {
        if (hasOwn(b, key))
          count--;
      }
      if (count !== 0)
        return false;
    }
    if (pending.length === 0)
      return true;
    depth = pending.pop();
    b = pending.pop();
    a = pending.pop();
  }
}

/**
 * Ordering of two JSON values per RFC 9535 section 2.3.5.2.2 — the
 * ordering half of the comparison family whose equality half is
 * `equalsJson`.
 *
 * Only two numbers or two strings order at all: numbers by value,
 * strings by Unicode scalar values (`compareCodePoints`, not the native
 * `<`). Every other pair — mismatched types, objects, arrays, booleans,
 * null — is simply `false` in both directions, never an error.
 *
 * @param {any} a
 * @param {any} b
 * @param {boolean} [orEqual] when true test `<=` instead of `<`
 * @returns {boolean}
 */
export function compareJsonScalarLt(a, b, orEqual = false) {
  if (typeof a === 'number')
    return typeof b === 'number' && (orEqual ? a <= b : a < b);
  if (typeof a === 'string')
    return typeof b === 'string' && (orEqual
      ? compareCodePoints(a, b) <= 0
      : compareCodePoints(a, b) < 0);
  return false;
}

/**
 * Check if all items in an array are unique using deep equality
 * @param {any[]} arr - The array to check
 * @returns {boolean} True if all items are unique
 */
export function isUniqueDeepArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return true;

  // Small all-scalar arrays: pairwise === beats allocating a Set.
  if (arr.length <= 8) {
    let allScalar = true;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
        allScalar = false;
        break;
      }
    }
    if (allScalar) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (arr[i] === arr[j]) return false;
        }
      }
      return true;
    }
  }

  // Primitives are compared with === by equalsDeep and can never deep-equal
  // an object, so they dedupe in O(n) through a Set (SameValueZero); only
  // objects, arrays and functions need the pairwise deep comparison.
  let seen = null;
  let complex = null;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
      if (complex === null) complex = [item];
      else complex.push(item);
    }
    else {
      // NaN !== NaN under equalsDeep; keep NaN values always unique
      if (typeof item === 'number' && item !== item) continue;
      if (seen === null) seen = new Set();
      else if (seen.has(item)) return false;
      seen.add(item);
    }
  }

  if (complex !== null && complex.length > 1) {
    for (let i = 0; i < complex.length; i++) {
      for (let j = i + 1; j < complex.length; j++) {
        if (equalsDeep(complex[i], complex[j])) return false;
      }
    }
  }
  return true;
}

/**
 * Deterministic JSON text for plain data: like `JSON.stringify`, but
 * object keys are emitted in sorted order at every depth, so two
 * structurally equal values always produce the same string (a stable
 * cache/memo/fingerprint key regardless of key insertion order).
 * Non-JSON values follow `JSON.stringify` semantics (undefined members
 * are dropped, undefined roots return undefined).
 *
 * That leniency is what makes it a memo key and not an interchange
 * format: dropping a member changes the document. For output that is
 * hashed or signed, use `canonicalizeJson` (`@jarenjs/json/canonical`,
 * RFC 8785), which rejects every non-JSON input instead of coercing it.
 *
 * The walk keeps its own stack, so it does not overflow the host's: a
 * value nested deeper than 10000 levels, past any nesting a default host
 * stack could serialize, is refused with a `JsonDepthError` `JO2001`
 * (`a value nested deeper than 10000 levels cannot be serialized`), and a
 * cycle with a `JsonCycleError` `JO2002` located at the member that closes
 * it (`a circular reference cannot be serialized at /self`, the pointer
 * {@link locateCycle} and `canonicalizeJson` name).
 * @param {*} value - The value to serialize
 * @returns {string|undefined} Deterministic JSON text
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value);
  // One frame per open container, so the nesting is not the host's call
  // stack: `keys` is null for an array, `at` the next member to write and
  // `key` the member whose container is open above this frame.
  /** @type {{ value: any, keys: string[] | null, at: number, key: string, out: string, first: boolean }[]} */
  const frames = [];
  let frame = openStableFrame(value);
  for (;;) {
    const container = frame.value;
    const keys = frame.keys;
    let child;
    if (keys === null) {
      if (frame.at < container.length) {
        const item = container[frame.at++];
        if (item === null || typeof item !== 'object') {
          frame.out += (frame.at === 1 ? '' : ',') + (JSON.stringify(item) ?? 'null');
          continue;
        }
        child = item;
      }
    }
    else if (frame.at < keys.length) {
      const key = keys[frame.at++];
      const member = container[key];
      if (member === null || typeof member !== 'object') {
        const sv = JSON.stringify(member);
        if (sv !== undefined) {
          frame.out += (frame.first ? '' : ',') + JSON.stringify(key) + ':' + sv;
          frame.first = false;
        }
        continue;
      }
      frame.key = key;
      child = member;
    }
    if (child !== undefined) {
      frames.push(frame);
      if (frames.length >= JSON_WALK_DEPTH_CEILING)
        throw walkRefusal('serialized', [value]);
      frame = openStableFrame(child);
      continue;
    }
    // the container is complete: close it into the frame below
    const text = frame.out + (keys === null ? ']' : '}');
    const parent = frames.pop();
    if (parent === undefined)
      return text;
    if (parent.keys === null)
      parent.out += (parent.at === 1 ? '' : ',') + text;
    else {
      parent.out += (parent.first ? '' : ',') + JSON.stringify(parent.key) + ':' + text;
      parent.first = false;
    }
    frame = parent;
  }
}

/**
 * The frame `stableStringify` opens for one container.
 * @param {any} value - An array or object
 */
function openStableFrame(value) {
  return Array.isArray(value)
    ? { value, keys: null, at: 0, key: '', out: '[', first: true }
    : { value, keys: Object.keys(value).sort(), at: 0, key: '', out: '{', first: true };
}

/**
 * The suite's one MEMO-GRADE content key: `hashContent(stableStringify
 * (value) ?? '')`. Two structurally equal plain-JSON values produce the
 * same key regardless of property insertion order — which is exactly
 * what a reconciliation key wants and exactly what `JSON.stringify`-based
 * keys get wrong.
 *
 * **This is a 32-bit FINGERPRINT, never an identity.** Distinct values
 * DO share a key — the birthday bound puts the first collision around
 * 65k documents, and one turns up after ~113k trivially different query
 * documents in practice. So it is sound for a vnode `key`, a DOM id, a
 * bucket index or a diagnostic label, and WRONG as the sole identity of
 * anything whose reuse changes a result: a compiled query, a query plan,
 * a registered SQL function body, a memoized render. For those use
 * {@link semanticKey}, which compares the whole serialization — in its
 * ordered form when the entry depends on member order.
 *
 * Two further properties a caller must know, inherited from
 * `stableStringify`: **`undefined` members are dropped** (two values
 * differing only in an `undefined` member share a key) and a cyclic value
 * is refused as a circular reference (`JO2002`), located at the member
 * that closes the cycle. Both are fine
 * for a fingerprint and wrong for a checksum — for anything hashed,
 * signed or recorded, use `canonicalizeJson`
 * (`@jarenjs/json/canonical`, RFC 8785) instead. Do not conflate the
 * three.
 * @param {*} value - The value to derive a fingerprint for
 * @returns {string} base-36 content hash of the stable serialization
 */
export function contentKey(value) {
  return hashContent(stableStringify(value) ?? '');
}

/**
 * The raw tokens {@link semanticKey} uses for the values JSON text cannot
 * tell apart. Each is emitted UNQUOTED, which alone is enough that no
 * string can forge one — `JSON.stringify` always puts quotes around a
 * string. The leading NUL is belt and braces: `JSON.stringify` escapes it
 * to `\u0000` inside a string, so a token cannot occur in serialized text
 * at all.
 *
 * Written as `\u0000` escapes on purpose. The same character as a literal
 * byte is invisible in every editor and diff and makes tooling treat the
 * file as binary, so a test pins that it stays an escape.
 */
const SEMANTIC_TOKENS = {
  undefined: '\u0000undef',
  nan: '\u0000nan',
  posInfinity: '\u0000+inf',
  negInfinity: '\u0000-inf',
  // -0 needs no sentinel: JSON text for the NUMBER -0 is `0`, so this
  // two-character form is already unreachable as a number's key
  negZero: '-0',
};

/**
 * The refusal of a value `semanticKey` cannot key injectively.
 * @param {string} what - The value, as the message names it
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @returns {TypeError}
 */
function semanticRefusal(what, path) {
  return new TypeError(
    `semanticKey: ${what} at ${path === '' ? 'the root' : path} cannot be a cache identity`);
}

/**
 * The token of a value that holds nothing to walk, `undefined` for an
 * object, or a throw for a value that cannot be keyed injectively.
 * @param {*} value
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @returns {string | undefined}
 */
function semanticLeaf(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return JSON.stringify(value);
    case 'number':
      if (Number.isNaN(value)) return SEMANTIC_TOKENS.nan;
      if (value === Infinity) return SEMANTIC_TOKENS.posInfinity;
      if (value === -Infinity) return SEMANTIC_TOKENS.negInfinity;
      // -0 and 0 are one token in JSON text and two values to every
      // arithmetic the engine performs (1/-0 is -Infinity)
      return Object.is(value, -0) ? SEMANTIC_TOKENS.negZero : String(value);
    case 'undefined': return SEMANTIC_TOKENS.undefined;
    case 'bigint': return `\u0000big${value}`;
    case 'function': throw semanticRefusal('a function', path);
    case 'symbol': throw semanticRefusal('a symbol', path);
    default: return undefined;
  }
}

// What the walk throws on meeting a container already open above it. Its
// trail is message text, not a pointer, so `semanticKey` builds the
// refusal and locates the member that closes the cycle itself.
const SEMANTIC_CYCLE = Object.freeze({ cycle: true });

// The nesting keyed on the host's call stack, the fast path every
// ordinary value takes; a value nested deeper continues on
// `semanticWalk`, which keeps its own stack.
const RECURSIVE_SEMANTIC_DEPTH = 256;

/**
 * Check one container the walk is about to open and mark it open: the
 * member names in key order, or `null` for an array.
 * @param {object} object
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @param {Set<object>} open - Ancestors on the current path (cycle guard)
 * @param {boolean} ordered - Object members in enumeration order rather
 *   than sorted
 * @returns {string[] | null}
 */
function openSemantic(object, path, open, ordered) {
  if (open.has(object)) throw SEMANTIC_CYCLE;
  const proto = Object.getPrototypeOf(object);
  // a symbol-keyed member is data the serialization cannot show, so two
  // values differing only there would share an identity
  if (Object.getOwnPropertySymbols(object).length > 0)
    throw semanticRefusal('a symbol-keyed member', path);
  open.add(object);
  if (Array.isArray(object)) {
    // a subclass carries behavior the key cannot see
    if (proto !== Array.prototype) throw semanticRefusal('an Array subclass instance', path);
    // an own property beyond the elements would vanish positionally
    for (const key of Object.keys(object)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= object.length || String(index) !== key)
        throw semanticRefusal(`the extra array property ${JSON.stringify(key)}`, path);
    }
    return null;
  }
  // Date, Map, Set, RegExp and every class instance stringify to `{}`
  // through `Object.keys` — a whole family collapsing onto one key
  if (proto !== Object.prototype && proto !== null)
    throw semanticRefusal(`a ${object.constructor?.name ?? 'non-plain'} instance`, path);
  // the member names are distinct, so their sequence alone spells the
  // order: an ordered key stays injective with order as part of identity
  return ordered ? Object.keys(object) : Object.keys(object).sort(compareCodePoints);
}

/**
 * Serialize one node of a semantic key, `depth` containers down from the
 * root, or throw when the value cannot be keyed injectively.
 * @param {*} value
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @param {Set<object>} open - Ancestors on the current path (cycle guard)
 * @param {boolean} ordered - Object members in enumeration order rather
 *   than sorted
 * @param {number} depth
 * @returns {string}
 */
function semanticToken(value, path, open, ordered, depth) {
  const leaf = semanticLeaf(value, path);
  if (leaf !== undefined)
    return leaf;
  if (depth > RECURSIVE_SEMANTIC_DEPTH)
    return semanticWalk(value, path, open, ordered, depth);
  const keys = openSemantic(value, path, open, ordered);
  let out;
  if (keys === null) {
    out = '[';
    for (let i = 0; i < value.length; i++)
      out += (i === 0 ? '' : ',') + semanticToken(value[i], `${path}/${i}`, open, ordered, depth + 1);
    out += ']';
  }
  else {
    out = '{';
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      out += (i === 0 ? '' : ',') + JSON.stringify(key) + ':'
        + semanticToken(value[key], `${path}/${key}`, open, ordered, depth + 1);
    }
    out += '}';
  }
  open.delete(value);
  return out;
}

/**
 * {@link semanticToken} for a container `depth` levels down, on an
 * explicit stack of the containers still open, so the nesting it reaches
 * is not the host's call stack; a container past
 * `JSON_WALK_DEPTH_CEILING` is refused with `JO2001`.
 * @param {object} value - An array or object
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @param {Set<object>} open - Ancestors on the current path (cycle guard)
 * @param {boolean} ordered - Object members in enumeration order rather
 *   than sorted
 * @param {number} depth
 * @returns {string}
 */
function semanticWalk(value, path, open, ordered, depth) {
  /** @type {{ object: any, keys: string[] | null, at: number, path: string }[]} */
  const frames = [];
  let out = '';
  /** @type {any} */
  let next = value;
  let nextPath = path;
  for (;;) {
    const leaf = semanticLeaf(next, nextPath);
    if (leaf !== undefined)
      out += leaf;
    else {
      if (depth + frames.length > JSON_WALK_DEPTH_CEILING)
        throw walkTooDeep('a cache identity');
      const keys = openSemantic(next, nextPath, open, ordered);
      out += keys === null ? '[' : '{';
      frames.push({ object: next, keys, at: 0, path: nextPath });
    }
    // on to the next member, closing every container it finishes
    for (;;) {
      const frame = frames[frames.length - 1];
      const size = frame.keys === null ? frame.object.length : frame.keys.length;
      if (frame.at < size) {
        if (frame.at > 0)
          out += ',';
        if (frame.keys === null) {
          next = frame.object[frame.at];
          nextPath = `${frame.path}/${frame.at}`;
        }
        else {
          const key = frame.keys[frame.at];
          out += JSON.stringify(key) + ':';
          next = frame.object[key];
          nextPath = `${frame.path}/${key}`;
        }
        frame.at++;
        break;
      }
      out += frame.keys === null ? ']' : '}';
      open.delete(frame.object);
      frames.pop();
      if (frames.length === 0)
        return out;
    }
  }
}

/**
 * The suite's one COLLISION-FREE semantic key: the COMPLETE
 * deterministic serialization of a plain-data value. Two values share a
 * key exactly when they are structurally equal, so a cache keyed by it
 * can never serve one document's compiled semantics for another —
 * which a hash-only key inevitably does (see {@link contentKey}).
 *
 * Use it wherever reuse changes a RESULT: compiled queries, query
 * plans, load specifications, safe profiles, registered SQL function
 * bodies, memoized renders. The key is longer than a fingerprint; for a
 * bounded cache of a few hundred entries that cost is a few kilobytes
 * and the alternative is wrong data.
 *
 * **Member order.** By default the key follows the JSON data model, where
 * an object's members are unordered: they are sorted by code point, so
 * two values differing only in member order share a key. With
 * `{ ordered: true }` members keep their enumeration order (`Object.keys`
 * order — array-index names ascending, then insertion order — the order
 * every reader of the value sees), and two such values are two
 * identities. A cache whose entries depend on member order MUST use the
 * ordered form. A JSON query document is such a value — `$for` bindings
 * nest and `$let` binds in key order, and a `$return` object's members
 * are the output's members in that order — and so is anything compiled
 * from one or computed by one over its input: a query plan, a registered
 * SQL function body, a compiled formula, a memo of an evaluation. The
 * ordered key refines the default one (values sharing an ordered key
 * share the default key, never the reverse), so choosing it costs at
 * most an extra miss. Both are one serializer, equally strict, with the
 * same refusals.
 *
 * Injective over plain data, and STRICT about the rest: it distinguishes
 * `-0` from `0`, `NaN`/`±Infinity` from `null` and from each other, and
 * a present-but-`undefined` member from an absent one — every case
 * `stableStringify` silently folds together. Values that cannot be
 * keyed injectively are REFUSED with a `TypeError` rather than folded:
 * functions, symbols, and non-plain objects (a `Date`, `Map`, `RegExp`
 * or class instance, all of which serialize to `{}`), plus the two
 * members a serialization cannot show — a symbol key, and an own array
 * property that is not an element index. A cycle is refused as a
 * circular reference, a `JsonCycleError` `JO2002` located at the member
 * that closes it, the first the key's own member order meets (`a
 * circular reference cannot be a cache identity at /self`). Past 256
 * levels the walk keeps its own stack, so it does not overflow the
 * host's: a value nested deeper than 10000 levels, the bound
 * `stableStringify` and `equalsJson` hold, is refused with a
 * `JsonDepthError` `JO2001` (`a value nested deeper than 10000 levels
 * cannot be a cache identity`). A caller that may hold such a value must
 * treat the refusal as "not cacheable" and compute afresh — never as
 * "reuse whatever shares the key".
 *
 * The identity covers OWN ENUMERABLE string-keyed properties, the same
 * surface JSON reads. Two values differing only in a non-enumerable
 * member are one value to this key, as they are to `JSON.stringify`.
 * @param {*} value - The value to derive an identity for
 * @param {{ ordered?: boolean }} [options] - `ordered: true` keeps object
 *   members in enumeration order instead of sorting them
 * @returns {string} the complete deterministic serialization
 * @throws {TypeError} When the value cannot be keyed injectively, or
 *   `options` is not a plain `{ ordered?: boolean }`
 * @throws {CodedError} `JO2002` on a cycle, `JO2001` past 10000 levels of
 *   nesting
 */
export function semanticKey(value, options = undefined) {
  let ordered = false;
  if (options !== undefined) {
    // a closed set of one: a misspelt member refuses rather than quietly
    // keying without order
    if (!isPlainOptions(options) || Object.keys(options).some((key) => key !== 'ordered')
      || (options.ordered !== undefined && typeof options.ordered !== 'boolean'))
      throw new TypeError('semanticKey: options must be a plain { ordered?: boolean }');
    ordered = options.ordered === true;
  }
  try {
    return semanticToken(value, '', new Set(), ordered, 1);
  }
  catch (error) {
    if (error !== SEMANTIC_CYCLE)
      throw error;
    // searched in the walk's own member order, so the member named is the
    // one the walk met
    throw new CodedError('JsonCycleError', 'JO2002', 'a circular reference cannot be a cache identity',
      locateCycleIn(value, ordered ? Object.keys : codePointKeys));
  }
}

/** @param {object} object @returns {string[]} */
const codePointKeys = (object) => Object.keys(object).sort(compareCodePoints);

/**
 * True for a JSON object — a non-null object that is not an array.
 *
 * This is the JSON data-model predicate, deliberately distinct from
 * `isObjectType`: it treats `Map`, `Set`, `Date` and every other class
 * instance as an object too, because at the JSON layer such a value has
 * already been rejected or serialized before it gets here, and the only
 * distinction that matters is object-vs-array.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a value is representable as JSON as it stands: `null`, a
 * boolean, a finite number, a string, or an array/plain object (own
 * enumerable members, prototype `Object.prototype` or `null`) whose
 * members all are. Everything else — `undefined`, `bigint`, `symbol`,
 * functions, `NaN`/`±Infinity`, class instances (`Error`, `Date`, `Map`,
 * `Response`, DOM nodes ...) and any cycle — is not.
 *
 * This is the boundary predicate for "JSON only crosses": a host that
 * hands a value into application state asks it once, before the value
 * can carry an object the state validator would have to reject. It is
 * TOTAL — a hostile accessor that throws makes the value not-JSON rather
 * than propagating.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isJsonValue(value) {
  try {
    return isJsonValueRec(value, null);
  }
  catch {
    return false;
  }
}

/**
 * @param {any} value
 * @param {Set<object> | null} path - the containers on the current
 *   descent (a cycle is a container met twice on ONE path; a shared
 *   subtree met on two paths is fine JSON)
 * @returns {boolean}
 */
function isJsonValueRec(value, path) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (value === null) return true;
  const isArray = Array.isArray(value);
  if (!isArray) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  }
  if (path !== null && path.has(value)) return false;
  const next = path ?? new Set();
  next.add(value);
  if (isArray) {
    for (let i = 0; i < value.length; i++) {
      if (!isJsonValueRec(value[i], next)) return false;
    }
  }
  else {
    for (const key of Object.keys(value)) {
      if (!isJsonValueRec(value[key], next)) return false;
    }
  }
  next.delete(value);
  return true;
}

/**
 * Assign a member so that a key named `__proto__` becomes an own data
 * property instead of reassigning the object's prototype. Every builder
 * that turns untrusted names into members must go through this — a plain
 * `out[name] = value` is a prototype-pollution hole for that one name.
 *
 * @param {Object} out target object
 * @param {string} name member name, possibly attacker-controlled
 * @param {any} value
 */
export function setObjectMember(out, name, value) {
  if (name === '__proto__') {
    Object.defineProperty(out, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  else {
    out[name] = value;
  }
}

/**
 * Whether a value can hold JSON members: an object or an array, not null.
 * The complement of a JSON scalar.
 * @param {any} value
 * @returns {boolean}
 */
export function isJsonContainer(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Copy one JSON container one level deep, preserving member order. Object
 * spread copies an own `__proto__` data property as an own property
 * (CreateDataProperty semantics), so this is pollution-safe.
 * @template T
 * @param {T} value - The container to copy
 * @returns {T} A shallow copy; scalars are returned unchanged
 */
export function shallowCloneJson(value) {
  return Array.isArray(value) ? value.slice() : { ...value };
}

/**
 * Deep-copy a JSON value. Scalars are returned as-is; containers are
 * rebuilt so no part of the result is shared with the input.
 * @template T
 * @param {T} value - The JSON value to copy
 * @returns {T} A deep copy sharing no container with the input
 */
export function cloneJson(value) {
  if (!isJsonContainer(value))
    return value;
  if (Array.isArray(value)) {
    const len = value.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++)
      out[i] = cloneJson(value[i]);
    return out;
  }
  const out = {};
  for (const key in value) {
    if (Object.hasOwn(value, key))
      setObjectMember(out, key, cloneJson(value[key]));
  }
  return out;
}

/**
 * The roots `deepFreeze` froze whole and that held at least `DEEP_FROZEN_SIZE`
 * values: freezing one again, or a document that shares it, does not walk it
 * again. (A smaller subtree is cheaper to walk than to remember.)
 */
const deepFrozen = new WeakSet();
const DEEP_FROZEN_SIZE = 64;

/** The objects being frozen below `CYCLE_DEPTH`, so a cycle meets one of them and stops. */
const open = new Set();
const CYCLE_DEPTH = 8;

/**
 * Freeze everything under `value`, answering how many objects it walked.
 * Objects are remembered as "open" only from `CYCLE_DEPTH` down: a cycle
 * revisits some object at ever greater depth, so it is met there, and the
 * ordinary shallow document pays nothing for it.
 * @param {object} value @param {number} depth @returns {number}
 */
function freezeWalk(value, depth) {
  if (deepFrozen.has(value)) return 0;
  const tracked = depth >= CYCLE_DEPTH;
  if (tracked) open.add(value);
  let walked = 1;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'object' && item !== null && !(tracked && open.has(item))) walked += freezeWalk(item, depth + 1);
    }
  }
  else {
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const member = /** @type {any} */ (value)[keys[i]];
      if (typeof member === 'object' && member !== null && !(tracked && open.has(member))) walked += freezeWalk(member, depth + 1);
    }
  }
  if (tracked) open.delete(value);
  Object.freeze(value);
  if (walked >= DEEP_FROZEN_SIZE) deepFrozen.add(value);
  return walked;
}

/**
 * Recursively `Object.freeze` a value and everything reachable from it,
 * returning the value. Scalars pass through untouched. A value frozen only at
 * its top (`Object.freeze({ a: [] })`) still has its members frozen. A large
 * subtree this function already froze is not walked again, so freezing a
 * document that shares one with an earlier document costs the new part only;
 * a cycle terminates. An array is frozen element by element (its non-index
 * properties are frozen, not descended into).
 *
 * @template T
 * @param {T} value
 * @returns {T} the same value, deeply frozen
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) return value;
  try {
    freezeWalk(value, 0);
  }
  finally {
    if (open.size !== 0) open.clear();
  }
  return value;
}

/**
 *
 * @param {Map<any, any>} map
 * @param {...Map<any, any>} iterables
 */
export function mergeMap(map, ...iterables) {
  for (const iterable of iterables) {
    for (const item of iterable) {
      map.set(...item);
    }
  }
}

/**
 *
 * @param {Set<any>} set
 * @param  {...Array<Set<any>>} iterables
 */
export function mergeSet(set, ...iterables) {
  for (const iterable of iterables) {
    for (const item of iterable) {
      set.add(item);
    }
  }
}

/**
 * The known name a misspelt one most plausibly meant, or `undefined` —
 * the one "did you mean" judgement every closed option set in the suite
 * shares (a store's `openStore` and transaction options, a driver's, a
 * contract binding's `serveHttp`/`serveLocal`/`servePort` options).
 * Close means either of two things, compared case-insensitively: one
 * spelling is a prefix of the other (`captur` → `capture`, `modes` →
 * `mode`), or the two are within a small edit distance
 * (`statmentTimeoutMs` → `statementTimeoutMs`) — at most one edit for a
 * name of four characters or fewer, two otherwise, so a short name is
 * not "corrected" into an unrelated one. A prefix counts only when the
 * shorter spelling has three characters or more — `a` is a prefix of
 * everything and a hint of nothing — and an empty key has no nearest
 * name. A prefix match wins, in the order `known` lists the names;
 * otherwise the smallest distance does.
 * @param {string} key
 * @param {readonly string[]} known
 * @returns {string | undefined}
 */
export function nearestName(key, known) {
  const lower = key.toLowerCase();
  if (lower.length === 0) return undefined;
  const prefix = known.find((name) => {
    const other = name.toLowerCase();
    return (lower.length >= 3 && other.startsWith(lower)) || (other.length >= 3 && lower.startsWith(other));
  });
  if (prefix !== undefined) return prefix;
  const limit = lower.length <= 4 ? 1 : 2;
  let best;
  let bestDistance = limit + 1;
  for (const name of known) {
    const distance = boundedEditDistance(lower, name.toLowerCase(), limit);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Whether `value` is a plain options object — an object literal or a
 * null-prototype record, never an array, a class instance or a string:
 * the one test every closed option set in the suite reads its options
 * object by, so a caller's `Object.create(null)` is read like a literal.
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Refuse the first own member of `options` outside `known`, through the
 * caller's own coded error — a closed option set refuses before any
 * effect rather than dropping a misspelt member in silence. The hint
 * names the nearest member ({@link nearestName}), or lists the set when
 * nothing is close.
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
 * Optimal-string-alignment distance (a transposition counts as one
 * edit), abandoned early once every cell of a row exceeds `limit`.
 * @param {string} a
 * @param {string} b
 * @param {number} limit
 * @returns {number} the distance, or `limit + 1` when it exceeds `limit`
 */
function boundedEditDistance(a, b, limit) {
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
