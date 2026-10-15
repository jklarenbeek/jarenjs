//#region Jaren JSON Query sequence runtime
// The tagged sequence representation of the query engine (QUERY-FORMAT.md
// section 2.1). Items are JSON values, and JSON arrays ARE items, so a
// sequence needs a representation that can never be confused with a value:
//
//   - the empty sequence is the exported `EMPTY` singleton symbol;
//   - a singleton sequence is the raw item itself (no wrapper, no
//     allocation - "singleton = item", spec section 2.1 rule 5);
//   - a sequence of two or more items is a `Seq` instance.
//
// Seqs are always flat: a Seq never contains another Seq, EMPTY, or fewer
// than two items. All constructors go through `seqOf`/`appendItem`, which
// maintain the invariant; `assertSeqInvariant` checks it in tests.

import { messageRef, queryRuntimeError } from './messages.js';
import { JSON_WALK_DEPTH_CEILING, walkRefusal } from '../errors.js';

/**
 * The empty sequence `()` (same singleton-sentinel pattern as
 * `JSONPATH_NOTHING`).
 */
export const EMPTY = Symbol('JsonQuery.Empty');

/**
 * A sequence of two or more items. Never constructed directly by
 * operator code - use `seqOf` so the flatness invariant holds.
 */
export class Seq {
  constructor(items) {
    this.items = items;
  }
}

/**
 * Build a sequence value from a flat accumulator array of items.
 * Returns EMPTY for zero items, the raw item for one, a Seq otherwise.
 * The array is adopted, not copied; callers hand over ownership.
 * @param {any[]} items - flat array of items (no Seq, no EMPTY inside)
 * @returns {any} EMPTY, a single item, or a Seq
 */
export function seqOf(items) {
  const len = items.length;
  if (len === 0)
    return EMPTY;
  if (len === 1)
    return items[0];
  return new Seq(items);
}

/**
 * Append a sequence value's items to a plain accumulator array
 * (the shared flattening step of array constructors and `$seq`).
 * @param {any[]} list - accumulator array of items
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 */
export function appendItem(list, v) {
  if (v === EMPTY)
    return;
  if (v instanceof Seq) {
    const items = v.items;
    for (let i = 0; i < items.length; i++)
      list.push(items[i]);
    return;
  }
  list.push(v);
}

/**
 * First item of a sequence value, or EMPTY for the empty sequence.
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @returns {any}
 */
export function firstItem(v) {
  if (v instanceof Seq)
    return v.items[0];
  return v;
}

/**
 * Effective boolean value of a sequence value per the EBV table of
 * QUERY-FORMAT.md section 2.2 (D3: singleton array/object is true).
 * @param {any} v - a sequence value (EMPTY, item, or Seq)
 * @param {string} docPath - RFC 6901 pointer for the JQ2003 error
 * @returns {boolean}
 * @throws {JsonQueryRuntimeError} JQ2003 on a sequence of two or more items
 */
export function ebv(v, docPath) {
  if (v === EMPTY)
    return false;
  switch (typeof v) {
    case 'boolean':
      return v;
    case 'number':
      return v === v && v !== 0; // false for 0, -0, NaN
    case 'string':
      return v.length !== 0;
    default:
      if (v === null)
        return false;
      if (v instanceof Seq)
        throw queryRuntimeError('JQ2003', 'query/ebv-sequence', {}, docPath);
      return true; // array or object (D3)
  }
}

/**
 * What an item is, as a message reference (`query/item/*`): the `{got}`
 * of a refusal, translated whole by whichever catalog renders it.
 * @param {any} v
 * @returns {{ messageId: string, params: Record<string, any> }}
 */
export function itemRef(v) {
  if (v instanceof Seq)
    return messageRef('query/item/sequence', { count: v.items.length });
  if (v === EMPTY)
    return messageRef('query/item/empty');
  if (v === null)
    return messageRef('query/item/null');
  if (Array.isArray(v))
    return messageRef('query/item/array');
  const t = typeof v;
  return t === 'object' || t === 'string' || t === 'number' || t === 'boolean'
    ? messageRef(`query/item/${t}`) : messageRef('query/item/other', { type: t });
}

/**
 * Deterministic serialization of one JSON item, for `$groupby` keys
 * (QUERY-FORMAT.md section 6.5) — the identity the engine files a group,
 * a `$distinct` item and an equi-join bucket under, exported from
 * `@jarenjs/json/query` for a host that maintains groups of its own and
 * must file a row under the group a fresh run would. Not an interchange
 * format. For interchange (hashing, signing) use `canonicalizeJson`
 * (canonical.js, RFC 8785), which is deliberately NOT this function: JCS
 * rejects `NaN`/`Infinity` outright, where grouping needs them to be
 * representable so that `NaN` groups with `NaN`. This exists solely so
 * that deep-equal items (D2) map to the same string:
 *
 *   - object members serialize sorted by key (code-unit order), so key
 *     order never matters;
 *   - `-0` normalizes to `0` (D2: `-0` equals `0`);
 *   - strings serialize via `JSON.stringify` (its escape discipline means
 *     no raw control character ever appears in the output, so a control
 *     character is safe as a composite-key separator);
 *   - numbers serialize bare via `String(n)` — `NaN` and `±Infinity`
 *     (reachable through `$div`) serialize as `NaN`/`Infinity`, which
 *     cannot collide with quoted strings. Note this makes `NaN` group
 *     with `NaN`, the XQuery grouping rule, even though `NaN` never
 *     equals itself under `$eq`;
 *   - a `bigint` serializes as its digits and `n`, so it never reaches the
 *     object branch (where every bigint would read as `{}`);
 *   - `undefined` serializes as `undefined`, so a member held as `undefined`
 *     is a member, as it is to `$eq` (`equalsJson`) and to the async
 *     operators' `semanticKey`, and is not the same row as one without it.
 *
 * A value is keyed on the host's call stack to 256 levels of nesting and
 * on its own stack past them, so the bound is the same on every host:
 * past 10000 levels, the bound `equalsJson` compares to (`$eq`), it is
 * refused with a `JsonDepthError` `JO2001` (`a value nested deeper than
 * 10000 levels cannot be keyed`), and a value holding a cycle with a
 * `JsonCycleError` `JO2002` whose `docPath` is the member that closes
 * it, a JSON Pointer into `value` (`a circular reference cannot be keyed
 * at /self`).
 *
 * A key longer than 1048576 characters (2^20) is written in its shared
 * form instead, so a value that shares a subtree many times, without a
 * cycle, costs its distinct subtrees rather than every path to them:
 * `[d, d]` nested 40 times is 2^40 leaves written out, and 41 subtrees
 * shared. The shared form is the same text, except that a container
 * equal to one already written is written as a back-reference, `\u0001`
 * and the ordinal of that first one among the containers written in
 * full (the root is 0), in document order. Equal is the key's own
 * equality, decided by content and never by reference, so two values get
 * the same key exactly when they did before, shared or not; only the
 * text of a key past the bound differs. `\u0001` occurs in no key
 * written out (`JSON.stringify` escapes it), so a back-reference cannot
 * be read as a value.
 *
 * @param {any} value - a JSON item (not EMPTY, not a Seq)
 * @returns {string} a deterministic serialization for grouping
 * @throws {CodedError} `JO2001` past 10000 levels of nesting, `JO2002` on
 *   a cycle
 */
export function stableKeyString(value) {
  try {
    return stableKeyOf(value);
  }
  catch (error) {
    throw error === KEY_CEILING ? walkRefusal('keyed', [value]) : error;
  }
}

/**
 * {@link stableKeyString}, or `undefined` for a value it refuses: for a
 * caller that answers such a value another way.
 * @param {any} value - a JSON item (not EMPTY, not a Seq)
 * @returns {string | undefined}
 */
export function stableKeyStringWithin(value) {
  try {
    return stableKeyOf(value);
  }
  catch (error) {
    if (error === KEY_CEILING)
      return undefined;
    throw error;
  }
}

// What the key walk throws past the bound: the caller holds the root it
// needs to tell a cycle from a deep value.
const KEY_CEILING = Object.freeze({ reached: JSON_WALK_DEPTH_CEILING });

// The longest key written out; a longer one is written in the shared form.
const KEY_TEXT_BOUND = 2 ** 20;

// What the key walk throws once the key it writes out is past
// `KEY_TEXT_BOUND`: the caller writes the shared form instead.
const KEY_TOO_LONG = Object.freeze({ reached: KEY_TEXT_BOUND });

/**
 * The key of a value, written out or, past {@link KEY_TEXT_BOUND}, in the
 * shared form; throws `KEY_CEILING` past the bound on nesting.
 * @param {any} value
 * @returns {string}
 */
function stableKeyOf(value) {
  let key;
  try {
    key = stableKeyAt(value, 1);
  }
  catch (error) {
    if (error !== KEY_TOO_LONG)
      throw error;
    return sharedKey(value);
  }
  return key.length > KEY_TEXT_BOUND ? sharedKey(value) : key;
}

// The nesting keyed on the host's call stack, the fast path every
// ordinary value takes; a value nested deeper continues on
// `stableKeyWalk`, which keeps its own stack.
const RECURSIVE_KEY_DEPTH = 256;

/**
 * The key of a value that holds nothing to walk, or `undefined` for one
 * that does (an array, an object, or anything else read as an object).
 * @param {any} value
 * @returns {string | undefined}
 */
function leafKey(value) {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return value === 0 ? '0' : String(value); // normalizes -0
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return String(value) + 'n'; // an integer past 2^53 read from JOSL
    case 'undefined':
      return 'undefined'; // a row member held as `undefined`: present, not absent
    default:
      return value === null ? 'null' : undefined;
  }
}

/**
 * The key of a value `depth` containers down from the root.
 * @param {any} value
 * @param {number} depth
 * @returns {string}
 */
function stableKeyAt(value, depth) {
  const leaf = leafKey(value);
  if (leaf !== undefined)
    return leaf;
  if (depth > RECURSIVE_KEY_DEPTH)
    return stableKeyWalk(value, depth);
  if (Array.isArray(value)) {
    let s = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0)
        s += ',';
      s += stableKeyAt(value[i], depth + 1);
      if (s.length > KEY_TEXT_BOUND)
        throw KEY_TOO_LONG;
    }
    return s + ']';
  }
  const keys = Object.keys(value).sort();
  let s = '{';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0)
      s += ',';
    s += JSON.stringify(keys[i]) + ':' + stableKeyAt(value[keys[i]], depth + 1);
    if (s.length > KEY_TEXT_BOUND)
      throw KEY_TOO_LONG;
  }
  return s + '}';
}

/**
 * The key of a container `depth` levels down, on an explicit stack of
 * the containers still open, so the nesting it reaches is not the host's
 * call stack; a container past {@link JSON_WALK_DEPTH_CEILING} throws
 * `KEY_CEILING`, which the caller turns into its answer.
 * @param {any} value - An array or object
 * @param {number} depth
 * @returns {string}
 */
function stableKeyWalk(value, depth) {
  /** @type {{ value: any, keys: string[] | null, at: number }[]} */
  const frames = [];
  let s = '';
  let next = value;
  for (;;) {
    const leaf = leafKey(next);
    if (leaf !== undefined)
      s += leaf;
    else {
      if (depth + frames.length > JSON_WALK_DEPTH_CEILING)
        throw KEY_CEILING;
      const keys = Array.isArray(next) ? null : Object.keys(next).sort();
      s += keys === null ? '[' : '{';
      frames.push({ value: next, keys, at: 0 });
    }
    if (s.length > KEY_TEXT_BOUND)
      throw KEY_TOO_LONG;
    // on to the next member, closing every container it finishes
    for (;;) {
      const frame = frames[frames.length - 1];
      const size = frame.keys === null ? frame.value.length : frame.keys.length;
      if (frame.at < size) {
        if (frame.at > 0)
          s += ',';
        if (frame.keys === null)
          next = frame.value[frame.at];
        else {
          const key = frame.keys[frame.at];
          s += JSON.stringify(key) + ':';
          next = frame.value[key];
        }
        frame.at++;
        break;
      }
      s += frame.keys === null ? ']' : '}';
      frames.pop();
      if (frames.length === 0)
        return s;
    }
  }
}

/**
 * The shared form of a value's key (see {@link stableKeyString}), on an
 * explicit stack, in time and space linear in the value's distinct
 * containers; throws `KEY_CEILING` for a cycle, or a container past
 * `JSON_WALK_DEPTH_CEILING` on any path to it.
 *
 * First every container gets the identity of its content: its text with
 * each member container written as that member's identity, so two
 * containers share one exactly when their keys written out are equal, and
 * a container reached again by reference is not walked again. Then the
 * key is written, each identity in full the first time and as a
 * back-reference after.
 * @param {any} value
 * @returns {string}
 */
function sharedKey(value) {
  const leaf = leafKey(value);
  if (leaf !== undefined)
    return leaf;
  /** @type {Map<object, number>} each container walked, to its identity */
  const identities = new Map();
  /** @type {Map<string, number>} each content seen, to its identity */
  const contents = new Map();
  /** @type {number[]} each identity's height: the containers on its longest path down */
  const heights = [];
  /** @type {Set<object>} */
  const open = new Set([value]);
  /** @param {any} container */
  const openFrame = (container) => {
    const keys = Array.isArray(container) ? null : Object.keys(container).sort();
    return { value: container, keys, at: 0, text: keys === null ? '[' : '{', height: 1 };
  };
  const frames = [openFrame(value)];
  for (;;) {
    const frame = frames[frames.length - 1];
    const size = frame.keys === null ? frame.value.length : frame.keys.length;
    if (frame.at < size) {
      const key = frame.keys === null ? null : frame.keys[frame.at];
      const member = key === null ? frame.value[frame.at] : frame.value[key];
      frame.text += (frame.at > 0 ? ',' : '') + (key === null ? '' : JSON.stringify(key) + ':');
      frame.at++;
      const memberLeaf = leafKey(member);
      if (memberLeaf !== undefined) {
        frame.text += memberLeaf;
        continue;
      }
      const known = identities.get(member);
      if (known !== undefined) {
        frame.text += '#' + known;
        frame.height = Math.max(frame.height, heights[known] + 1);
        continue;
      }
      if (open.has(member) || frames.length >= JSON_WALK_DEPTH_CEILING)
        throw KEY_CEILING;
      open.add(member);
      frames.push(openFrame(member));
      continue;
    }
    const content = frame.text + (frame.keys === null ? ']' : '}');
    let identity = contents.get(content);
    if (identity === undefined) {
      identity = heights.length;
      contents.set(content, identity);
      heights.push(frame.height);
    }
    identities.set(frame.value, identity);
    open.delete(frame.value);
    frames.pop();
    if (frames.length === 0) {
      if (heights[identity] > JSON_WALK_DEPTH_CEILING)
        throw KEY_CEILING;
      return writeShared(value, identities);
    }
    const parent = frames[frames.length - 1];
    parent.text += '#' + identity;
    parent.height = Math.max(parent.height, heights[identity] + 1);
  }
}

/**
 * Write the shared form of a key whose containers all have identities.
 * @param {object} value - An array or object
 * @param {Map<object, number>} identities
 * @returns {string}
 */
function writeShared(value, identities) {
  /** @type {Map<number, number>} each identity written, to its ordinal */
  const ordinals = new Map([[/** @type {number} */ (identities.get(value)), 0]]);
  /** @param {any} container */
  const openFrame = (container) => ({ value: container, keys: Array.isArray(container) ? null : Object.keys(container).sort(), at: 0 });
  const frames = [openFrame(value)];
  let s = frames[0].keys === null ? '[' : '{';
  for (;;) {
    const frame = frames[frames.length - 1];
    const size = frame.keys === null ? frame.value.length : frame.keys.length;
    if (frame.at < size) {
      const key = frame.keys === null ? null : frame.keys[frame.at];
      const member = key === null ? frame.value[frame.at] : frame.value[key];
      s += (frame.at > 0 ? ',' : '') + (key === null ? '' : JSON.stringify(key) + ':');
      frame.at++;
      const memberLeaf = leafKey(member);
      if (memberLeaf !== undefined) {
        s += memberLeaf;
        continue;
      }
      const identity = /** @type {number} */ (identities.get(member));
      const ordinal = ordinals.get(identity);
      if (ordinal !== undefined) {
        s += '\u0001' + ordinal;
        continue;
      }
      ordinals.set(identity, ordinals.size);
      const inner = openFrame(member);
      s += inner.keys === null ? '[' : '{';
      frames.push(inner);
      continue;
    }
    s += frame.keys === null ? ']' : '}';
    frames.pop();
    if (frames.length === 0)
      return s;
  }
}

/**
 * Debug-only invariant check: asserts a sequence value is well-formed
 * (a Seq holds 2+ items and contains no nested Seq or EMPTY). Used by
 * tests; never called on hot paths.
 * @param {any} v - a sequence value to check
 * @returns {any} v itself when well-formed
 * @throws {Error} when the flatness invariant is violated
 */
export function assertSeqInvariant(v) {
  if (v instanceof Seq) {
    if (v.items.length < 2)
      throw new Error(`Seq invariant violated: ${v.items.length} item(s) in a Seq`);
    for (let i = 0; i < v.items.length; i++) {
      const item = v.items[i];
      if (item instanceof Seq)
        throw new Error(`Seq invariant violated: nested Seq at index ${i}`);
      if (item === EMPTY)
        throw new Error(`Seq invariant violated: EMPTY inside a Seq at index ${i}`);
      if (item === undefined)
        throw new Error(`Seq invariant violated: undefined inside a Seq at index ${i}`);
    }
  }
  return v;
}

//#endregion
