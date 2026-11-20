//@ts-check

import { compareCodePoints, hashContent } from './string.js';
import { CodedError } from './errors.js';
import {
  JSON_WALK_DEPTH_CEILING, WALK_CEILING, isPastLongestString, isStackExhausted, locateCycle, locateCycleIn, textTooLong, walkRefusal,
  walkTooDeep,
} from './walk.js';

// the refusal of a text past the host's longest string, for every writer
// of a JSON text to raise alike (`JO2009`), and the test for the host's
// refusal of a call its stack cannot hold, for a recursion to turn into a
// coded refusal of its own
export { locateCycle, isPastLongestString, isStackExhausted, textTooLong };

const hasOwn = Object.hasOwn;
const isEnumerable = Object.prototype.propertyIsEnumerable;

/**
 * Deep equality comparison for arbitrary values: one relation, the same in
 * both orders, that tells apart values whose state is not in their members.
 *
 * - A value that is no object equals only itself: a symbol only that
 *   symbol, `NaN` nothing (itself included), `0` also `-0`. A function
 *   equals a function of the same text, and no object.
 * - An object never equals a value that is none: a wrapper object
 *   (`new String('a')`) is not its primitive.
 * - Two objects are equal when their prototypes name one constructor (an
 *   own `constructor` member is data), the state their kind keeps outside
 *   its members is equal, and their own enumerable members are, each
 *   compared by this relation. That state is a wrapper's primitive; a
 *   Date's instant (two invalid Dates are equal); a RegExp's source and
 *   flags; a Map's entries, keys by identity and values by this relation;
 *   a Set's members, by identity; a buffer's bytes and the bytes a DataView
 *   shows; an error's `name`, `message`, `cause` and `errors`; the length
 *   of an array that is no plain one (a subclass instance, an array of
 *   another realm). The kind is read from the value: a subclass instance
 *   and a built-in of another realm are compared by that state too, and an
 *   object that only inherits from a built-in's prototype, or a Proxy of a
 *   built-in, by its members alone.
 * - A plain array is its elements by index (a hole reads as `undefined`)
 *   and a typed array its elements: named members of either are not read.
 *
 * Not read, so two values that differ only there are equal: a
 * non-enumerable or symbol-keyed member, and state the host keeps to
 * itself (a private field, the outcome of a Promise, the entries of a
 * WeakMap, what a Proxy wraps, what a bound function binds).
 *
 * Not the same as `equalsJson`, which compares JSON values
 * only and is the hot-path variant — keep both.
 *
 * A pair nested past 256 levels is compared on a stack of the compare's
 * own, so a value nested past the host's call stack is compared at any
 * depth. Two values holding cycles compare as the infinite values they
 * unfold to: a pair of containers met again inside its own compare is
 * taken as equal, so the answer is decided by the members that differ, if
 * any (`a = [a]` equals `b = [b]`; `a = [a, 1]` does not equal
 * `b = [b, 2]`), however many members lead back into the cycle.
 * @param {any} target
 * @param {any} source
 * @returns {boolean}
 */
export function equalsDeep(target, source) {
  deepWalksLeft = DEEP_WALKS;
  try {
    return equalsDeepAt(target, source, 1);
  }
  catch (error) {
    if (error !== PAST_RECURSION) throw error;
    // the whole pair again, where every pair open on the way down is known
    return equalsDeepWalk(target, source);
  }
}

// The pairs nested past `RECURSIVE_COMPARE_DEPTH` that one compare carries
// on from where they are, each on a walk of its own: a deep value holds a
// few. A walk knows only the pairs open below its start, so a cycle that
// two members lead into is walked once per way of reaching that depth, and
// those ways double with every level: past this many the compare starts
// again at its root, on one walk that knows every open pair.
const DEEP_WALKS = 4;
let deepWalksLeft = DEEP_WALKS;

// What `equalsDeepAt` throws for a pair nested past `RECURSIVE_COMPARE_DEPTH`
// once the compare has carried on from `DEEP_WALKS` such pairs.
const PAST_RECURSION = { nested: 'past the recursive compare' };

/**
 * `equalsDeep` for a pair `depth` containers down from the root, on the
 * host's stack.
 * @param {any} target
 * @param {any} source
 * @param {number} depth
 * @returns {boolean}
 * @throws `PAST_RECURSION` for a pair of objects nested deeper than
 *   `RECURSIVE_COMPARE_DEPTH`, past the first `DEEP_WALKS` of them
 */
function equalsDeepAt(target, source, depth) {
  if (target === source) return true;
  // only two objects are compared by what they hold: any other value equals
  // itself alone, but a function, which equals a function of its text
  if (typeof target !== 'object' || typeof source !== 'object' || target === null || source === null)
    return typeof target === 'function' && typeof source === 'function' && target.toString() === source.toString();

  if (depth > RECURSIVE_COMPARE_DEPTH) {
    if (deepWalksLeft === 0) throw PAST_RECURSION;
    deepWalksLeft--;
    return equalsDeepWalk(target, source);
  }

  const constructor = Object.getPrototypeOf(target)?.constructor;
  if (constructor !== Object.getPrototypeOf(source)?.constructor)
    return false;

  let kind = MEMBERS;
  if (constructor !== Object) {
    if (constructor === Array) {
      if (target.length !== source.length)
        return false;
      for (let i = 0; i < target.length; ++i) {
        if (!equalsDeepAt(target[i], source[i], depth + 1))
          return false;
      }
      return true;
    }

    kind = equalKind(target, source);
    if (kind === UNEQUAL) return false;
    if (kind === TYPED) return true;
    if (kind === MAP) {
      for (const [key, value] of Map.prototype.entries.call(target)) {
        if (!Map.prototype.has.call(source, key) || !equalsDeepAt(value, Map.prototype.get.call(source, key), depth + 1))
          return false;
      }
    }
  }

  const tkeys = Object.keys(target);
  const skeys = Object.keys(source);
  if (tkeys.length !== skeys.length) return false;
  if (kind === ERROR && !equalsDeepAt(errorState(target, tkeys), errorState(source, skeys), depth + 1))
    return false;
  for (let i = 0; i < tkeys.length; ++i) {
    const key = tkeys[i];
    if ((key !== skeys[i] && !isListed(skeys, key, source)) || !equalsDeepAt(target[key], source[key], depth + 1))
      return false;
  }
  return true;
}

/**
 * Whether `key`, an enumerable own key of one object that the other does
 * not list at the same place, is among the other's enumerable own keys
 * `names`. An own member the other object keeps non-enumerable is none of
 * them, whichever of the two is asked. A list of up to 32 names is
 * searched, which costs less than asking the object; a longer one would
 * cost its length per key, so the object is asked.
 * @param {string[]} names
 * @param {string} key
 * @param {object} object - the object `names` lists
 * @returns {boolean}
 */
function isListed(names, key, object) {
  return names.length <= 32 ? names.includes(key) : isEnumerable.call(object, key);
}

// The kinds of state `equalsDeep` compares besides an object's own
// enumerable members: none, an error's four members it keeps out of them,
// the length of an array that is no plain one, a typed array's elements
// (its members are not read), the bytes a DataView shows, and from `DATE`
// on the slot of one built-in class of `SlotTables`. `UNEQUAL` stands for
// two objects of two kinds, or of one kind and two states.
const UNEQUAL = -1;
const MEMBERS = 0;
const ERROR = 1;
const ARRAY = 2;
const TYPED = 3;
const VIEW = 4;
const DATE = 5;
const REGEXP = 6;
const MAP = 7;
const SET = 8;
const BUFFER = 9;
const SHARED = 10;
const WRAPPER = 11;

/**
 * A function of a built-in prototype that reads a slot of the object it is
 * called on and throws for an object without that slot.
 * @typedef {(this: any) => any} SlotReader
 */

/**
 * What `slotKind` tells an object's kind by: `kinds`, the kind each
 * built-in prototype gives the objects that inherit from it; `tags`, the
 * kind the tag of a built-in names, by which a value of another realm is
 * told; `readers`, the slot reader of each kind from `DATE` on (none for
 * an error: what is compared of it are members); `typedName`, the reader
 * of a typed array's class name, which answers `undefined` for any other
 * object.
 * @typedef {{ kinds: Map<object, number>, tags: Map<string, number>, readers: (SlotReader | null)[], typedName: SlotReader }} SlotTables
 */

// Built by the first compare that reads a kind, so a bundle that compares
// nothing carries no table.
/** @type {SlotTables | undefined} */
let slotTables;

/**
 * The getter of an accessor a built-in prototype defines.
 * @param {object} prototype
 * @param {string | symbol} name
 * @returns {SlotReader}
 */
function slotGetter(prototype, name) {
  return /** @type {any} */ (Object.getOwnPropertyDescriptor(prototype, name)).get;
}

/**
 * The tables of the built-in classes whose instances keep state in a slot
 * of their own, outside their members.
 * @returns {SlotTables}
 */
function buildSlotTables() {
  /** @type {[Function, number, SlotReader | null][]} */
  const classes = [
    [Error, ERROR, null],
    [Date, DATE, Date.prototype.getTime],
    [RegExp, REGEXP, slotGetter(RegExp.prototype, 'source')],
    [Map, MAP, slotGetter(Map.prototype, 'size')],
    [Set, SET, slotGetter(Set.prototype, 'size')],
    [ArrayBuffer, BUFFER, slotGetter(ArrayBuffer.prototype, 'byteLength')],
    [Number, WRAPPER, Number.prototype.valueOf],
    [String, WRAPPER + 1, String.prototype.valueOf],
    [Boolean, WRAPPER + 2, Boolean.prototype.valueOf],
    [BigInt, WRAPPER + 3, BigInt.prototype.valueOf],
    [Symbol, WRAPPER + 4, Symbol.prototype.valueOf],
  ];
  // a page that is not cross-origin isolated has no shared buffers
  if (typeof SharedArrayBuffer === 'function')
    classes.push([SharedArrayBuffer, SHARED, slotGetter(SharedArrayBuffer.prototype, 'byteLength')]);
  /** @type {SlotTables} */
  const tables = {
    kinds: new Map(),
    tags: new Map(),
    readers: [],
    typedName: slotGetter(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag),
  };
  for (const [constructor, kind, reader] of classes) {
    tables.kinds.set(constructor.prototype, kind);
    tables.tags.set(`[object ${constructor.name}]`, kind);
    tables.readers[kind] = reader;
  }
  return tables;
}

/**
 * The kind of state an object keeps outside its members, read from the
 * object itself. The host tells a typed array, a DataView and an array.
 * Any other kind is that of the first built-in prototype on the object's
 * chain, so a subclass instance is of its base's kind; a chain that ends
 * without reaching this realm's `Object.prototype` is a value of another
 * realm, told by the class its tag names. Either is confirmed by the
 * kind's slot reader: an object that merely inherits from
 * `Date.prototype`, and a Proxy of a Date, hold no instant and are of no
 * kind but their members.
 * @param {object} value
 * @returns {number}
 */
function slotKind(value) {
  const tables = slotTables ??= buildSlotTables();
  if (ArrayBuffer.isView(value))
    return tables.typedName.call(value) === undefined ? VIEW : TYPED;
  if (Array.isArray(value))
    return ARRAY;
  let proto = Object.getPrototypeOf(value);
  if (proto === null)
    return MEMBERS;
  /** @type {number | undefined} */
  let kind;
  do {
    if (proto === Object.prototype)
      return MEMBERS;
    kind = tables.kinds.get(proto);
    proto = Object.getPrototypeOf(proto);
  } while (kind === undefined && proto !== null);
  kind ??= tables.tags.get(Object.prototype.toString.call(value));
  if (kind === undefined)
    return MEMBERS;
  const read = tables.readers[kind];
  if (read === null)
    return kind;
  try {
    read.call(value);
    return kind;
  }
  catch {
    return MEMBERS;
  }
}

/**
 * The kind two objects are both of when the state that kind keeps outside
 * its members is equal, else `UNEQUAL`. Left to the walk, which compares
 * values at any depth: the values of a Map's entries (its size is compared
 * here) and an error's four members.
 * @param {any} target
 * @param {any} source
 * @returns {number}
 */
function equalKind(target, source) {
  const kind = slotKind(target);
  if (kind !== slotKind(source))
    return UNEQUAL;
  let equal = true;
  if (kind >= DATE) {
    if (kind === REGEXP)
      equal = RegExp.prototype.toString.call(target) === RegExp.prototype.toString.call(source);
    else if (kind === BUFFER || kind === SHARED)
      equal = equalTypedArrays(shownBytes(target, kind), shownBytes(source, kind));
    else {
      // a Date's instant, a wrapper's primitive, the size of a Map or a Set:
      // `slotKind` built the tables and confirmed both objects by this reader
      const read = /** @type {SlotReader} */ (/** @type {SlotTables} */ (slotTables).readers[kind]);
      const t = read.call(target);
      const s = read.call(source);
      // `NaN` in a wrapper is unlike itself, as outside one; two invalid Dates are one value
      equal = t === s || (kind === DATE && t !== t && s !== s);
      if (equal && kind === SET)
        equal = holdsMembersOf(source, target);
    }
  }
  else if (kind === ARRAY)
    equal = target.length === source.length;
  else if (kind === TYPED)
    equal = equalTypedArrays(target, source);
  else if (kind === VIEW)
    equal = equalTypedArrays(shownBytes(target, kind), shownBytes(source, kind));
  return equal ? kind : UNEQUAL;
}

// The members an error keeps out of its enumerable ones: its `name` is
// inherited and the other three are non-enumerable.
const ERROR_STATE = ['name', 'message', 'cause', 'errors'];

/**
 * What an error holds at the four members it keeps out of its enumerable
 * ones, as one value to compare. A member of those names a host made
 * enumerable (`error.cause = other`) is compared with the error's members,
 * once: its place here holds nothing.
 * @param {any} error
 * @param {string[]} keys - the error's own enumerable keys
 * @returns {unknown[]}
 */
function errorState(error, keys) {
  const state = [];
  for (const name of ERROR_STATE)
    state.push(keys.includes(name) ? undefined : error[name]);
  return state;
}

/**
 * The bytes a buffer holds, or a DataView shows; none where the host
 * refuses to read them (a detached buffer).
 * @param {any} value
 * @param {number} kind
 * @returns {Uint8Array}
 */
function shownBytes(value, kind) {
  try {
    return kind === VIEW
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
  }
  catch {
    return new Uint8Array(0);
  }
}

/**
 * Whether a Set holds every member of another (by identity): two Sets of
 * one size then hold the same members.
 * @param {Set<any>} source @param {Set<any>} target @returns {boolean}
 */
function holdsMembersOf(source, target) {
  for (const value of Set.prototype.values.call(target)) {
    if (!Set.prototype.has.call(source, value))
      return false;
  }
  return true;
}

/**
 * Two typed arrays hold the same elements.
 * @param {any} target @param {any} source @returns {boolean}
 */
function equalTypedArrays(target, source) {
  if (target.length !== source.length)
    return false;
  for (let i = 0; i < target.length; ++i) {
    if (target[i] !== source[i])
      return false;
  }
  return true;
}

/**
 * One pair of containers `equalsDeepWalk` compares member by member:
 * `entries` the entries of a Map still to compare, `keys` the own
 * enumerable keys of an object that is no plain array and `others` those
 * of the object it is compared with, neither for a plain array; `at` the
 * next key or index, -1 where an error's four hidden members come first.
 * @typedef {{ target: any, source: any, keys: string[] | null, others: string[] | null, entries: Iterator<[any, any]> | null, at: number }} DeepPair
 */

/**
 * How `equalsDeep` reads one pair before any member of it: `true` or
 * `false` when that decides it, else the pair whose members it compares
 * next, in `equalsDeepAt`'s order and with its checks.
 * @param {any} target
 * @param {any} source
 * @returns {boolean | DeepPair}
 */
function openDeepPair(target, source) {
  if (target === source) return true;
  if (typeof target !== 'object' || typeof source !== 'object' || target === null || source === null)
    return typeof target === 'function' && typeof source === 'function' && target.toString() === source.toString();
  const constructor = Object.getPrototypeOf(target)?.constructor;
  if (constructor !== Object.getPrototypeOf(source)?.constructor) return false;
  let kind = MEMBERS;
  if (constructor !== Object) {
    if (constructor === Array)
      return target.length === source.length && { target, source, keys: null, others: null, entries: null, at: 0 };
    kind = equalKind(target, source);
    if (kind === UNEQUAL) return false;
    if (kind === TYPED) return true;
  }
  // an object, or any other class instance: its own enumerable members
  const keys = Object.keys(target);
  const others = Object.keys(source);
  return keys.length === others.length
    && { target, source, keys, others, entries: kind === MAP ? Map.prototype.entries.call(target) : null, at: kind === ERROR ? -1 : 0 };
}

/**
 * `equalsDeep` for a pair nested past `RECURSIVE_COMPARE_DEPTH`, or for a
 * whole compare that met more than `DEEP_WALKS` of them: the same
 * depth-first compare, on a stack of its own so the nesting it reaches is
 * not the host's. A pair met again while it is still open above is the
 * compare come back to where it was: it is taken as equal, so only a
 * member that differs makes the answer `false`.
 * @param {any} target
 * @param {any} source
 * @returns {boolean}
 */
function equalsDeepWalk(target, source) {
  const first = openDeepPair(target, source);
  if (typeof first === 'boolean') return first;
  /** @type {DeepPair[]} */
  const pairs = [first];
  /** @type {Map<object, number>} how many pairs open on the way down hold each target container */
  const open = new Map([[target, 1]]);
  for (;;) {
    const pair = pairs[pairs.length - 1];
    let t;
    let s;
    let more = true;
    if (pair.entries !== null) {
      const step = pair.entries.next();
      if (step.done === true) {
        // the entries are compared: the Map's own members come next
        pair.entries = null;
        continue;
      }
      const [key, value] = step.value;
      if (!Map.prototype.has.call(pair.source, key)) return false;
      t = value;
      s = Map.prototype.get.call(pair.source, key);
    }
    else if (pair.keys !== null && pair.others !== null) {
      if (pair.at < 0) {
        pair.at = 0;
        t = errorState(pair.target, pair.keys);
        s = errorState(pair.source, pair.others);
      }
      else if (pair.at < pair.keys.length) {
        const key = pair.keys[pair.at];
        if (key !== pair.others[pair.at] && !isListed(pair.others, key, pair.source)) return false;
        pair.at++;
        t = pair.target[key];
        s = pair.source[key];
      }
      else more = false;
    }
    else if (pair.at < pair.target.length) {
      t = pair.target[pair.at];
      s = pair.source[pair.at];
      pair.at++;
    }
    else more = false;
    if (!more) {
      pairs.pop();
      const holding = /** @type {number} */ (open.get(pair.target));
      if (holding === 1) open.delete(pair.target);
      else open.set(pair.target, holding - 1);
      if (pairs.length === 0) return true;
      continue;
    }
    const next = openDeepPair(t, s);
    if (next === false) return false;
    if (next === true) continue;
    // a target is open twice only on a cycle, so only then are the open pairs searched
    const holding = open.get(t);
    if (holding !== undefined && isOpenPair(pairs, t, s)) continue;
    open.set(t, (holding ?? 0) + 1);
    pairs.push(next);
  }
}

/**
 * Whether the pair `target`, `source` is open on the way down.
 * @param {DeepPair[]} pairs @param {object} target @param {object} source
 * @returns {boolean}
 */
function isOpenPair(pairs, target, source) {
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i].target === target && pairs[i].source === source) return true;
  }
  return false;
}


/**
 * Structural equality of two JSON values per RFC 9535 section 2.3.5.2.2.
 *
 * JSON-only equality: objects compare by own enumerable keys, arrays by
 * index, primitives by `===` (so `1 === 1.0`, and `NaN` is never equal).
 * Other objects also compare by own enumerable keys: constructors and
 * non-enumerable Map/Set entries are ignored, except the two that JOSL and
 * JSONX read text into, which have none: a `Date` equals a `Date` of the
 * same instant (an invalid one equals none, as `NaN` does) and a `RegExp`
 * a `RegExp` of the same source and flags, and neither equals another
 * object. Functions compare by identity.
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
 *
 * Two values that share subtrees (`d = [d, d]`, built separately on each
 * side) cost their distinct pairs of containers, not the pairs they
 * reach: past 2^20 pairs compared plainly, the compare carries on
 * remembering the pairs it found equal, with the same answer, difference,
 * cycle and depth refusal.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle
 */
export function equalsJson(a, b) {
  comparesLeft = PLAIN_COMPARE_BUDGET;
  let equal;
  try {
    equal = equalsJsonAt(a, b, 1);
  }
  catch (error) {
    comparedEqual = null;
    throw error === WALK_CEILING ? walkRefusal('compared', [a, b], COMPARED_VALUES) : error;
  }
  comparedEqual = null;
  return equal;
}

// The names `equalsJson`'s refusal gives its two roots.
const COMPARED_VALUES = ['the first value', 'the second value'];

// The container pairs `equalsJson` compares plainly, each subtree each
// time it is reached. Two values that share subtrees can reach the same
// pair exponentially often (`d = [d, d]`), so past this many every pair
// still to compare goes to `equalsSharedAt`, which remembers the pairs it
// found equal (`comparedEqual`, for the one call) and compares a
// remembered one no more.
const PLAIN_COMPARE_BUDGET = 1 << 20;
let comparesLeft = PLAIN_COMPARE_BUDGET;
/** @type {ComparedPairs | null} */
let comparedEqual = null;

// The nesting `equalsJson` compares on the host's call stack, the fast
// path every ordinary value takes: a recursive walk stops at the first
// difference in member order. A pair nested deeper continues on
// `equalsJsonWalk`, which keeps its own stack.
const RECURSIVE_COMPARE_DEPTH = 256;

/**
 * Whether two objects with no own members of their own differ as the
 * values JOSL and JSONX read into JavaScript objects of that shape: a
 * `Date` equals a `Date` of the same instant and a `RegExp` a `RegExp` of
 * the same source and flags, and neither equals any other object, `{}`
 * included. Read by their members, every two would be one value.
 * @param {object} a - holds no own enumerable member
 * @param {object} b
 * @returns {boolean}
 */
function opaqueDiffers(a, b) {
  const aDate = a instanceof Date;
  const bDate = b instanceof Date;
  if (aDate || bDate)
    return !(aDate && bDate && a.getTime() === b.getTime());
  const aPattern = a instanceof RegExp;
  const bPattern = b instanceof RegExp;
  if (aPattern || bPattern)
    return !(aPattern && bPattern && a.source === b.source && a.flags === b.flags);
  return false;
}

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
  if (--comparesLeft < 0)
    return equalsSharedAt(a, b, depth, comparedEqual ??= new Map()) !== 0;
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
  if (count === 0 && opaqueDiffers(a, b))
    return false;
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
  // the budget on a local, handed back with a `true`: a `false` ends the
  // whole compare
  let left = comparesLeft;
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
      if (count === 0 && opaqueDiffers(a, b))
        return false;
      for (const key in b) {
        if (hasOwn(b, key))
          count--;
      }
      if (count !== 0)
        return false;
    }
    // the next pair, or, past the budget, every pair left on `equalsSharedWalk`
    for (;;) {
      if (pending.length === 0) {
        comparesLeft = left;
        return true;
      }
      depth = pending.pop();
      b = pending.pop();
      a = pending.pop();
      if (--left >= 0)
        break;
      if (equalsSharedWalk(a, b, depth, comparedEqual ??= new Map()) === 0)
        return false;
    }
  }
}

/**
 * The pairs `equalsSharedAt` found equal, each with its height: the
 * container levels from the pair down to its deepest pair of distinct
 * containers.
 * @typedef {Map<object, Map<object, number>>} ComparedPairs
 */

// A pair is remembered only when comparing it took this many pairs: a
// small one costs less to compare again than to remember, and a pair
// compared again costs at most this, so the compare stays linear in the
// distinct pairs.
const REMEMBERED_WORK = 32;
// The pairs the shared compare has compared, for the work of each.
let sharedCompares = 0;

/**
 * `equalsJsonAt` remembering the pairs it found equal: a pair
 * remembered (one that took `REMEMBERED_WORK` pairs to compare) answers
 * equal again without a walk. It answers
 * the pair's height, or 0 when the two differ. The order of the checks
 * is `equalsJsonAt`'s and `equalsJsonWalk`'s, so the first difference,
 * cycle or depth it meets is theirs; a pair found equal held no cycle,
 * and one reached again deeper is refused when its height passes the
 * bound, where the plain walk down it would be.
 * @param {any} a
 * @param {any} b
 * @param {number} depth
 * @param {ComparedPairs} equal
 * @returns {number}
 */
function equalsSharedAt(a, b, depth, equal) {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return 0;
  if (depth > RECURSIVE_COMPARE_DEPTH)
    return equalsSharedWalk(a, b, depth, equal);
  const known = equal.get(a)?.get(b);
  if (known !== undefined) {
    if (depth + known - 1 > JSON_WALK_DEPTH_CEILING)
      throw WALK_CEILING;
    return known;
  }
  const start = sharedCompares++;
  let height = 1;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b))
    return 0;
  if (aIsArray) {
    const alen = a.length;
    if (alen !== b.length)
      return 0;
    for (let i = 0; i < alen; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y)
        continue;
      const below = equalsSharedAt(x, y, depth + 1, equal);
      if (below === 0)
        return 0;
      if (below >= height)
        height = below + 1;
    }
  }
  else {
    let count = 0;
    for (const key in a) {
      if (!hasOwn(a, key))
        continue;
      if (!hasOwn(b, key))
        return 0;
      const x = a[key];
      const y = b[key];
      if (x !== y) {
        const below = equalsSharedAt(x, y, depth + 1, equal);
        if (below === 0)
          return 0;
        if (below >= height)
          height = below + 1;
      }
      count++;
    }
    if (count === 0 && opaqueDiffers(a, b))
      return 0;
    for (const key in b) {
      if (hasOwn(b, key))
        count--;
    }
    if (count !== 0)
      return 0;
  }
  if (sharedCompares - start >= REMEMBERED_WORK)
    rememberEqual(equal, a, b, height);
  return height;
}

/**
 * `equalsJsonWalk` remembering the pairs it found equal, as
 * {@link equalsSharedAt} does: one frame per pair whose members are
 * checked, holding the member pairs still to compare, taken last first
 * as the plain walk's stack takes them.
 * @param {any} a - An array or object
 * @param {any} b - An array or object
 * @param {number} depth
 * @param {ComparedPairs} equal
 * @returns {number}
 */
function equalsSharedWalk(a, b, depth, equal) {
  /** @type {{ a: any, b: any, pairs: any[], depth: number, height: number, start: number }[]} */
  const frames = [];
  for (;;) {
    // the pair `a`, `b` at `depth`: known equal, or checked and opened
    let done = equal.get(a)?.get(b);
    if (done !== undefined) {
      if (depth + done - 1 > JSON_WALK_DEPTH_CEILING)
        throw WALK_CEILING;
    }
    else {
      if (depth > JSON_WALK_DEPTH_CEILING)
        throw WALK_CEILING;
      const start = sharedCompares++;
      /** @type {any[]} */
      const pairs = [];
      const aIsArray = Array.isArray(a);
      if (aIsArray !== Array.isArray(b))
        return 0;
      if (aIsArray) {
        const alen = a.length;
        if (alen !== b.length)
          return 0;
        for (let i = 0; i < alen; i++) {
          const x = a[i];
          const y = b[i];
          if (x === y)
            continue;
          if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null)
            return 0;
          pairs.push(x, y);
        }
      }
      else {
        let count = 0;
        for (const key in a) {
          if (!hasOwn(a, key))
            continue;
          if (!hasOwn(b, key))
            return 0;
          count++;
          const x = a[key];
          const y = b[key];
          if (x === y)
            continue;
          if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null)
            return 0;
          pairs.push(x, y);
        }
        if (count === 0 && opaqueDiffers(a, b))
          return 0;
        for (const key in b) {
          if (hasOwn(b, key))
            count--;
        }
        if (count !== 0)
          return 0;
      }
      if (pairs.length === 0)
        done = 1;
      else
        frames.push({ a, b, pairs, depth, height: 1, start });
    }
    // on to the next pair, closing every frame whose pairs all compared equal
    for (;;) {
      if (done !== undefined) {
        if (frames.length === 0)
          return done;
        const parent = frames[frames.length - 1];
        if (done >= parent.height)
          parent.height = done + 1;
        done = undefined;
      }
      const frame = frames[frames.length - 1];
      if (frame.pairs.length > 0) {
        b = frame.pairs.pop();
        a = frame.pairs.pop();
        depth = frame.depth + 1;
        break;
      }
      done = frame.height;
      if (sharedCompares - frame.start >= REMEMBERED_WORK)
        rememberEqual(equal, frame.a, frame.b, done);
      frames.pop();
    }
  }
}

/**
 * Remember that `a` and `b` compared equal, with the pair's height.
 * @param {ComparedPairs} equal
 * @param {object} a
 * @param {object} b
 * @param {number} height
 */
function rememberEqual(equal, a, b, height) {
  const row = equal.get(a);
  if (row === undefined)
    equal.set(a, new Map([[b, height]]));
  else
    row.set(b, height);
}

/**
 * Ordering of two JSON values per RFC 9535 section 2.3.5.2.2 — the
 * ordering half of the comparison family whose equality half is
 * `equalsJson`.
 *
 * Two numbers or two strings order: numbers by value, strings by Unicode
 * scalar values (`compareCodePoints`, not the native `<`). So do the two
 * values JOSL and JSONX read whose equality is a value's: two `Date`s by
 * their instant (an invalid one orders as `NaN`, against none) and two
 * `bigint`s by their value. Every other pair — mismatched types, a `Date`
 * beside its own text, objects (a `Date` with members of its own, which
 * `equalsJson` reads by them, and a `RegExp` among them), arrays,
 * booleans, null — is simply `false` in both directions, never an error.
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
  if (typeof a === 'bigint')
    return typeof b === 'bigint' && (orEqual ? a <= b : a < b);
  if (a instanceof Date && b instanceof Date && Object.keys(a).length === 0 && Object.keys(b).length === 0)
    return orEqual ? a.getTime() <= b.getTime() : a.getTime() < b.getTime();
  return false;
}

/**
 * Check if all items in an array are unique using deep equality: no two
 * items are equal by `equalsDeep`, so `isUniqueDeepArray([a, b])` is
 * `!equalsDeep(a, b)` for any two values, in either order.
 *
 * The primitives are compared first, by `===` (`NaN` unlike itself, `-0`
 * like `0`, a symbol like itself alone), and never equal an object or a
 * function, as `equalsDeep` has it; then each pair of those by
 * `equalsDeep`, the earlier item read first. Up to 8 items are compared
 * pairwise; past 8 the primitives are deduplicated through a Set.
 * @param {any[]} arr - The array to check
 * @returns {boolean} True if all items are unique
 */
export function isUniqueDeepArray(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return true;

  // Small arrays: pairwise beats allocating a Set and a list of the
  // containers, in the order the walk below compares them.
  const length = arr.length;
  if (length <= 8) {
    let containers = 0;
    for (let i = 0; i < length; i++) {
      const item = arr[i];
      if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
        containers++;
        continue;
      }
      for (let j = i + 1; j < length; j++) {
        if (item === arr[j]) return false;
      }
    }
    if (containers < 2) return true;
    for (let i = 0; i < length; i++) {
      const item = arr[i];
      if ((typeof item !== 'object' || item === null) && typeof item !== 'function') continue;
      for (let j = i + 1; j < length; j++) {
        const other = arr[j];
        if (((typeof other === 'object' && other !== null) || typeof other === 'function')
          && equalsDeep(item, other))
          return false;
      }
    }
    return true;
  }

  // A primitive is compared with the other primitives only, so they dedupe
  // in O(n) through a Set (SameValueZero); only objects, arrays and
  // functions need the pairwise deep comparison.
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
 *
 * A value that shares subtrees (`d = [d, d]`) costs its distinct
 * containers: past 2^18 containers written plainly, the text of each
 * container is remembered and joined wherever it is reached again, the
 * same text held as joined pieces. A text longer than the host's longest
 * string (536870888 characters on Node) is refused with a
 * `JsonLengthError` `JO2009` (`a value whose text is longer than the
 * host's longest string cannot be serialized`).
 * @param {*} value - The value to serialize
 * @returns {string|undefined} Deterministic JSON text
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle, `JO2009` for a text longer than the host's longest string
 */
export function stableStringify(value) {
  try {
    return value === null || typeof value !== 'object' ? JSON.stringify(value) : writeStable(value);
  }
  catch (error) {
    throw isPastLongestString(error) ? textTooLong('serialized') : error;
  }
}

// The containers `stableStringify` and `semanticKey` write plainly, a
// subtree each time it is reached. A value that shares subtrees can reach
// one exponentially often (`d = [d, d]`), so past this many the writer
// also remembers the text of each container that took `REMEMBERED_WORK`
// containers to write, and joins it wherever the container is reached
// again: the same text, held as joined pieces rather than copied.
const PLAIN_WRITE_BUDGET = 1 << 18;

/**
 * The text `stableStringify` answers for a container. Past
 * `PLAIN_WRITE_BUDGET` containers it remembers what it wrote and joins
 * it where it is reached again. A container remembered held no cycle,
 * and one reached again deeper is refused when its height passes the
 * bound, where the plain walk down it would be. Text longer than the
 * host's longest string throws the host's `RangeError`, which
 * `stableStringify` refuses as `JO2009`.
 * @param {object} value - An array or object
 * @returns {string}
 */
function writeStable(value) {
  /** @type {Map<object, { text: string, height: number }> | null} */
  let written = null;
  // One frame per open container, so the nesting is not the host's call
  // stack: `keys` is null for an array, `at` the next member to write,
  // `key` the member whose container is open above this frame, `height`
  // the container levels written into it so far and `start` the
  // containers opened before it.
  /** @type {StableFrame[]} */
  const frames = [];
  let opened = 0;
  let frame = openStableFrame(value, opened++);
  let writesLeft = PLAIN_WRITE_BUDGET;
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
      const known = written === null ? undefined : written.get(child);
      if (known === undefined) {
        if (written === null && --writesLeft < 0)
          written = new Map();
        frames.push(frame);
        if (frames.length >= JSON_WALK_DEPTH_CEILING)
          throw walkRefusal('serialized', [value]);
        frame = openStableFrame(child, opened++);
        continue;
      }
      // the child sits one level below `frame`, its deepest container
      // `height - 1` below that
      if (frames.length + 1 + known.height > JSON_WALK_DEPTH_CEILING)
        throw walkRefusal('serialized', [value]);
      closeStableMember(frame, known.text, known.height);
      continue;
    }
    // the container is complete: close it into the frame below
    const text = frame.out + (keys === null ? ']' : '}');
    if (written !== null && opened - frame.start >= REMEMBERED_WORK)
      written.set(container, { text, height: frame.height });
    const parent = frames.pop();
    if (parent === undefined)
      return text;
    closeStableMember(parent, text, frame.height);
    frame = parent;
  }
}

/**
 * @typedef {{ value: any, keys: string[] | null, at: number, key: string, out: string, first: boolean, height: number, start: number }} StableFrame
 */

/**
 * The frame `writeStable` opens for one container.
 * @param {any} value - An array or object
 * @param {number} start - The containers opened before it
 * @returns {StableFrame}
 */
function openStableFrame(value, start) {
  return Array.isArray(value)
    ? { value, keys: null, at: 0, key: '', out: '[', first: true, height: 1, start }
    : { value, keys: Object.keys(value).sort(), at: 0, key: '', out: '{', first: true, height: 1, start };
}

/**
 * Write a member container's complete text into the frame it belongs to.
 * @param {StableFrame} frame
 * @param {string} text
 * @param {number} height - The member's height
 */
function closeStableMember(frame, text, height) {
  if (frame.keys === null)
    frame.out += (frame.at === 1 ? '' : ',') + text;
  else {
    frame.out += (frame.first ? '' : ',') + JSON.stringify(frame.key) + ':' + text;
    frame.first = false;
  }
  if (height >= frame.height)
    frame.height = height + 1;
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
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle, `JO2009` for a serialization longer than the host's longest
 *   string
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

// What the walks of `semanticKey` and `cloneJson` throw on meeting a
// container already open above them. The walk holds no pointer to it (the
// key's trail is message text), so the caller builds the refusal and
// locates the member that closes the cycle itself, from the root.
const CYCLE_MET = Object.freeze({ cycle: true });

// The containers `semanticKey` may still write plainly; past them every
// container is written by `semanticShared`, which remembers its text in
// `semanticWritten` for the one call.
let semanticWritesLeft = PLAIN_WRITE_BUDGET;
/** @type {Map<object, { text: string, height: number }> | null} */
let semanticWritten = null;
// Whether every container the current call has opened so far is frozen,
// dense and holds only data members; see `semanticKey`'s memo.
let semanticImmutable = false;
// The key of a root whose whole tree a walk proved immutable, one map per
// key form, so a later call returns it without walking again.
/** @type {WeakMap<object, string>} */
const sortedKeyOf = new WeakMap();
/** @type {WeakMap<object, string>} */
const orderedKeyOf = new WeakMap();

/**
 * True when a container can never key differently: frozen, so no member
 * is added, removed or rewritten; every keyed member a data property, so
 * no getter answers differently on a later read; an array dense, so no
 * hole reads through a prototype that may change.
 * @param {object} object
 * @param {string[]} keys - Its own enumerable string keys
 * @param {boolean} isArray
 * @returns {boolean}
 */
function holdsImmutableData(object, keys, isArray) {
  if (!Object.isFrozen(object)) return false;
  if (isArray && keys.length !== /** @type {any[]} */ (object).length) return false;
  for (let i = 0; i < keys.length; i++) {
    // an accessor's descriptor always names `get`, a data member's never does
    if ('get' in /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(object, keys[i]))) return false;
  }
  return true;
}

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
  if (open.has(object)) throw CYCLE_MET;
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
    const indices = Object.keys(object);
    for (const key of indices) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= object.length || String(index) !== key)
        throw semanticRefusal(`the extra array property ${JSON.stringify(key)}`, path);
    }
    if (semanticImmutable) semanticImmutable = holdsImmutableData(object, indices, true);
    return null;
  }
  // Date, Map, Set, RegExp and every class instance stringify to `{}`
  // through `Object.keys` — a whole family collapsing onto one key
  if (proto !== Object.prototype && proto !== null)
    throw semanticRefusal(`a ${object.constructor?.name ?? 'non-plain'} instance`, path);
  // the member names are distinct, so their sequence alone spells the
  // order: an ordered key stays injective with order as part of identity
  const keys = ordered ? Object.keys(object) : Object.keys(object).sort(compareCodePoints);
  if (semanticImmutable) semanticImmutable = holdsImmutableData(object, keys, false);
  return keys;
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
  if (--semanticWritesLeft < 0)
    return semanticShared(value, path, open, ordered, depth, semanticWritten ??= new Map());
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
    else if (--semanticWritesLeft < 0) {
      out += semanticShared(next, nextPath, open, ordered, depth + frames.length, semanticWritten ??= new Map());
      if (frames.length === 0)
        return out;
    }
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
 * {@link semanticToken} for a value `depth` levels down past the plain
 * budget, on its own stack: it remembers the text of each container that
 * took `REMEMBERED_WORK` containers to write in `written`, and joins it
 * where the container is reached again. The text, and the first refusal
 * met, are the plain walk's: the members are met in the same order and
 * checked in it, with the same `open` ancestors; a container remembered
 * held no cycle and no refusal, and one reached again deeper is refused
 * `JO2001` when its height passes the bound, where the plain walk down it
 * would be. Text longer than the host's longest string throws the host's
 * `RangeError`, which `semanticKey` refuses as `JO2009`.
 * @param {*} value
 * @param {string} path - JSON-Pointer-ish trail, for the error message
 * @param {Set<object>} open - Ancestors on the current path (cycle guard)
 * @param {boolean} ordered - Object members in enumeration order rather
 *   than sorted
 * @param {number} depth
 * @param {Map<object, { text: string, height: number }>} written
 * @returns {string}
 */
function semanticShared(value, path, open, ordered, depth, written) {
  /** @type {{ object: any, keys: string[] | null, at: number, path: string, out: string, height: number, start: number }[]} */
  const frames = [];
  let opened = 0;
  /** @type {any} */
  let next = value;
  let nextPath = path;
  for (;;) {
    // `next` is written, joined, or opened as the frame on top
    let text = semanticLeaf(next, nextPath);
    let height = 0;
    if (text === undefined) {
      const known = written.get(next);
      if (known === undefined) {
        if (depth + frames.length > JSON_WALK_DEPTH_CEILING)
          throw walkTooDeep('a cache identity');
        const keys = openSemantic(next, nextPath, open, ordered);
        frames.push({ object: next, keys, at: 0, path: nextPath, out: keys === null ? '[' : '{', height: 1, start: opened++ });
      }
      else {
        if (depth + frames.length + known.height - 1 > JSON_WALK_DEPTH_CEILING)
          throw walkTooDeep('a cache identity');
        text = known.text;
        height = known.height;
      }
    }
    // on to the next member, closing every container it finishes
    for (;;) {
      const frame = frames[frames.length - 1];
      if (text !== undefined) {
        if (frame === undefined)
          return text;
        frame.out += text;
        if (height >= frame.height)
          frame.height = height + 1;
        text = undefined;
      }
      const size = frame.keys === null ? frame.object.length : frame.keys.length;
      if (frame.at < size) {
        if (frame.at > 0)
          frame.out += ',';
        if (frame.keys === null) {
          next = frame.object[frame.at];
          nextPath = `${frame.path}/${frame.at}`;
        }
        else {
          const key = frame.keys[frame.at];
          frame.out += JSON.stringify(key) + ':';
          next = frame.object[key];
          nextPath = `${frame.path}/${key}`;
        }
        frame.at++;
        break;
      }
      text = frame.out + (frame.keys === null ? ']' : '}');
      height = frame.height;
      if (opened - frame.start >= REMEMBERED_WORK)
        written.set(frame.object, { text, height });
      open.delete(frame.object);
      frames.pop();
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
 * "reuse whatever shares the key". A value that shares subtrees costs its
 * distinct containers, as in {@link stableStringify}, with the same key;
 * a key longer than the host's longest string is refused with a
 * `JsonLengthError` `JO2009` (`… cannot be a cache identity`).
 *
 * The identity covers OWN ENUMERABLE string-keyed properties, the same
 * surface JSON reads. Two values differing only in a non-enumerable
 * member are one value to this key, as they are to `JSON.stringify`.
 *
 * **A wholly immutable value is walked once.** When the walk finds every
 * array and object of the tree frozen (`Object.isFrozen`, as
 * {@link deepFreeze} leaves it), each keyed member a data property and
 * each array without holes, the key is remembered for that root object,
 * per key form, and a later call with the same object returns it without
 * walking: such a tree cannot change, so the key stays exact. A tree with
 * one unfrozen container, an accessor or a hole anywhere is walked on
 * every call, and a refused value is refused on every call. The memory is
 * held weakly, for as long as the root object lives; a fresh wrapper —
 * a tuple such as `[document, options]` built per call — is a new root
 * and walks every time.
 * @param {*} value - The value to derive an identity for
 * @param {{ ordered?: boolean }} [options] - `ordered: true` keeps object
 *   members in enumeration order instead of sorting them
 * @returns {string} the complete deterministic serialization
 * @throws {TypeError} When the value cannot be keyed injectively, or
 *   `options` is not a plain `{ ordered?: boolean }`
 * @throws {CodedError} `JO2002` on a cycle, `JO2001` past 10000 levels of
 *   nesting, `JO2009` for a key longer than the host's longest string
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
  const isContainer = typeof value === 'object' && value !== null;
  const memo = ordered ? orderedKeyOf : sortedKeyOf;
  if (isContainer) {
    const known = memo.get(value);
    if (known !== undefined) return known;
  }
  semanticWritesLeft = PLAIN_WRITE_BUDGET;
  // a getter met by the walk may call `semanticKey` itself; the inner
  // call's proof is its own, so the outer one's resumes as it stood
  const outerImmutable = semanticImmutable;
  semanticImmutable = isContainer;
  let error;
  try {
    const key = semanticToken(value, '', new Set(), ordered, 1);
    semanticWritten = null;
    if (semanticImmutable) memo.set(value, key);
    semanticImmutable = outerImmutable;
    return key;
  }
  catch (thrown) {
    error = thrown;
    semanticWritten = null;
    semanticImmutable = outerImmutable;
  }
  if (isPastLongestString(error))
    throw textTooLong('a cache identity');
  if (error !== CYCLE_MET)
    throw error;
  // searched in the walk's own member order, so the member named is the
  // one the walk met
  throw new CodedError('JsonCycleError', 'JO2002', 'a circular reference cannot be a cache identity',
    locateCycleIn(value, ordered ? Object.keys : codePointKeys));
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
 * rebuilt so no part of the result is shared with the input. A value
 * nested past the host's call stack is copied at any depth (past 256
 * levels the copy keeps its own stack). A cycle has no copy: it is refused
 * as a `CodedError` named `JsonCycleError` with code `JO2002`, whose
 * `docPath` is the member that closes it, the first the copy's own member
 * order meets (`a circular reference cannot be copied at /self`).
 * @template T
 * @param {T} value - The JSON value to copy
 * @returns {T} A deep copy sharing no container with the input
 * @throws {CodedError} `JO2002` on a cycle
 */
export function cloneJson(value) {
  try {
    return cloneAt(value, 0);
  }
  catch (error) {
    if (error !== CYCLE_MET)
      throw error;
  }
  // searched in the copy's own member order, so the member named is the
  // one the copy met
  throw new CodedError('JsonCycleError', 'JO2002', 'a circular reference cannot be copied',
    locateCycleIn(value, Object.keys, Infinity));
}

// The nesting `cloneJson` copies on the host's call stack, the path every
// ordinary document takes; a value nested deeper is copied by `cloneDeep`,
// which keeps its own stack.
const RECURSIVE_CLONE_DEPTH = 256;

/**
 * `cloneJson` for a value `depth` containers down from the root. A cycle
 * nests without end, so it reaches `RECURSIVE_CLONE_DEPTH` and is met by
 * `cloneDeep` (`CYCLE_MET`).
 * @param {any} value @param {number} depth @returns {any}
 */
function cloneAt(value, depth) {
  if (!isJsonContainer(value))
    return value;
  if (depth >= RECURSIVE_CLONE_DEPTH)
    return cloneDeep(value);
  if (Array.isArray(value)) {
    const len = value.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++)
      out[i] = cloneAt(value[i], depth + 1);
    return out;
  }
  const out = {};
  for (const key in value) {
    if (Object.hasOwn(value, key))
      setObjectMember(out, key, cloneAt(value[key], depth + 1));
  }
  return out;
}

/**
 * `cloneAt` for a container `RECURSIVE_CLONE_DEPTH` levels down, on a
 * stack of its own so the nesting it reaches is not the host's: the same
 * copy, members in the same order, every container it is copying
 * remembered as open, so a cycle is met as one (`CYCLE_MET`). A cycle
 * closing above this point is met on its next turn below it.
 * @param {object} value @returns {object}
 */
function cloneDeep(value) {
  /** @type {Set<object>} */
  const open = new Set();
  /** @type {{ source: any, out: any, keys: string[] | null, at: number }[]} */
  const frames = [];
  /** @param {any} source @returns {any} the copy, members still to fill */
  const enter = (source) => {
    if (open.has(source))
      throw CYCLE_MET;
    open.add(source);
    const keys = Array.isArray(source) ? null : Object.keys(source);
    const out = keys === null ? new Array(source.length) : {};
    frames.push({ source, out, keys, at: 0 });
    return out;
  };
  const copy = enter(value);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const { source, out, keys } = frame;
    const size = keys === null ? source.length : keys.length;
    if (frame.at === size) {
      frames.pop();
      open.delete(source);
      continue;
    }
    const at = frame.at++;
    const member = source[keys === null ? at : keys[at]];
    const copied = isJsonContainer(member) ? enter(member) : member;
    if (keys === null) out[at] = copied;
    else setObjectMember(out, keys[at], copied);
  }
  return copy;
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
 * ordinary shallow document pays nothing for it. Past
 * `RECURSIVE_FREEZE_DEPTH` levels the walk goes on in `freezeDeep`.
 * @param {object} value @param {number} depth @returns {number}
 */
function freezeWalk(value, depth) {
  if (deepFrozen.has(value)) return 0;
  if (depth >= RECURSIVE_FREEZE_DEPTH) return freezeDeep(value);
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

// The nesting `deepFreeze` walks on the host's call stack, the path every
// ordinary document takes; an object nested deeper is frozen by
// `freezeDeep`, which keeps its own stack.
const RECURSIVE_FREEZE_DEPTH = 256;

/**
 * `freezeWalk` for an object `RECURSIVE_FREEZE_DEPTH` levels down, on a
 * stack of its own so the nesting it reaches is not the host's: the same
 * walk, members frozen before the object holding them, every object
 * remembered as open while its members are walked.
 * @param {object} value @returns {number}
 */
function freezeDeep(value) {
  /** @type {{ value: any, keys: string[] | null, at: number, walked: number }[]} */
  const frames = [];
  let next = value;
  for (;;) {
    if (next !== undefined) {
      open.add(next);
      frames.push({ value: next, keys: Array.isArray(next) ? null : Object.keys(next), at: 0, walked: 1 });
      next = undefined;
    }
    const frame = frames[frames.length - 1];
    const keys = frame.keys;
    const container = frame.value;
    const size = keys === null ? container.length : keys.length;
    let at = frame.at;
    while (at < size) {
      const member = container[keys === null ? at : keys[at]];
      at++;
      if (typeof member === 'object' && member !== null && !open.has(member) && !deepFrozen.has(member)) {
        next = member;
        break;
      }
    }
    frame.at = at;
    if (next !== undefined) continue;
    frames.pop();
    open.delete(frame.value);
    Object.freeze(frame.value);
    if (frame.walked >= DEEP_FROZEN_SIZE) deepFrozen.add(frame.value);
    if (frames.length === 0) return frame.walked;
    frames[frames.length - 1].walked += frame.walked;
  }
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
