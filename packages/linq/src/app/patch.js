//@ts-check
/**
 * @file The six RFC 6902 operations of a transition's `patch`
 * (APP-FORMAT §3.2), written by code. A `path` is a captured lambda over
 * the state — `(st) => st.todos` is `/todos`, `st.todos.at(2)` is
 * `/todos/2` — so a pointer is DERIVED from the state shape and a typo
 * is a capture error rather than a silent `JA2004` at dispatch; a
 * pointer string is accepted verbatim for the locations a shape cannot
 * spell.
 *
 * The one place this pen computes a pointer is a NON-literal index: an
 * `at(x.payload.i)` cannot be written as pointer text at build time, so
 * the pen emits the pointer as a string expression — `{ "$concat":
 * ["/todos/", "$payload.i", "/done"] }` — which is exactly what §3.2
 * means by "op members like `value` and `path` are themselves query
 * expressions". A path that is not a chain of member reads and
 * subscripts at all is `JL0102`: the pen will not guess where an
 * arbitrary expression lands in the state.
 *
 * A `value` is left exactly as the caller wrote it — an expression from
 * the enclosing action capture, or a literal — because the action
 * capture is what spells the whole transition.
 */

import { LinqBuildError } from '../errors.js';
import { liftExpression } from '../expression.js';
import { describeValue } from '../json-boundary.js';
import { captureAction } from './capture.js';

/** RFC 6901: `~` and `/` escape inside a pointer segment. @param {string} segment */
const escapeSegment = (segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * `JL0102` for a path expression the pen cannot lower to a pointer.
 * @param {any} doc - what the capture produced
 * @returns {never}
 */
function unlowerable(doc) {
  throw new LinqBuildError('JL0102',
    'a patch path is a JSON Pointer, and this one cannot be written as one: '
    + `${JSON.stringify(doc)} — a path lambda reads members and subscripts off the state `
    + '(st.todos.at(2).done, st.todos.at(x.payload.i)); anything else, pass the pointer as '
    + 'a string', '/path');
}

/**
 * Lower one RFC 9535 path string — the shape the capture writes — to a
 * JSON Pointer.
 * @param {string} path
 * @returns {string}
 */
function pointerOf(path) {
  if (path[0] !== '$') unlowerable(path);
  let i = 1;
  let out = '';
  while (i < path.length) {
    if (path[i] === '.') {
      let j = i + 1;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      if (j === i + 1) unlowerable(path);
      out += `/${escapeSegment(path.slice(i + 1, j))}`;
      i = j;
      continue;
    }
    if (path[i] !== '[') unlowerable(path);
    if (path[i + 1] === "'") {
      let name = '';
      let j = i + 2;
      for (;;) {
        if (j >= path.length) unlowerable(path);
        const ch = path[j];
        if (ch === "'") break;
        if (ch !== '\\') { name += ch; j++; continue; }
        const esc = path[j + 1];
        if (esc === 'u') {
          name += String.fromCodePoint(Number.parseInt(path.slice(j + 2, j + 6), 16));
          j += 6;
        }
        else { name += esc; j += 2; }
      }
      if (path[j + 1] !== ']') unlowerable(path);
      out += `/${escapeSegment(name)}`;
      i = j + 2;
      continue;
    }
    const close = path.indexOf(']', i);
    const index = path.slice(i + 1, close);
    if (close === -1 || !/^\d+$/.test(index)) unlowerable(path);
    out += `/${index}`;
    i = close + 1;
  }
  return out;
}

/**
 * The pieces of a pointer, left to right: pointer TEXT for every segment
 * the capture wrote literally, and one query expression per computed
 * one. A `$get` chain is how the capture spells a subscript it could not
 * fold into the path string, so unwinding it is what turns
 * `st.todos.at(x.payload.i).done` into `/todos/`, the index, `/done`.
 * @param {any} doc - a path string, or a `$get` over one
 * @returns {any[] | null} the pieces, or `null` when this is not a path
 */
function pointerPieces(doc) {
  if (typeof doc === 'string') return [{ text: pointerOf(doc) }];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)
    || !Array.isArray(doc.$get) || doc.$get.length !== 2) {
    return null;
  }
  const base = pointerPieces(doc.$get[0]);
  if (base === null) return null;
  const key = doc.$get[1];
  // a bare string operand is a literal member name; one starting with
  // `$` is a path, which is a computed segment like any other operator
  if (typeof key === 'string' && key[0] !== '$') return [...base, { text: `/${escapeSegment(key)}` }];
  if (Number.isInteger(key) && key >= 0) return [...base, { text: `/${key}` }];
  return [...base, { text: '/' }, { expr: key }];
}

/**
 * The `path` member of one operation: a pointer string verbatim, or a
 * captured lambda lowered to one — as text where every segment is
 * literal, as a `$concat` expression where one is computed.
 * @param {any} path - `(st, x) => …`, or a JSON Pointer string
 * @param {string} [suffix] - a literal tail, `'/-'` for an array append
 * @returns {any} the pointer, or the expression that builds it
 */
export function pathMember(path, suffix = '') {
  if (typeof path === 'string') {
    if (path !== '' && path[0] !== '/') {
      throw new LinqBuildError('JL0102',
        `a patch path given as a string is an RFC 6901 JSON Pointer — '${path}' does not `
        + "start with '/'; write a lambda over the state instead, (st) => st.todos", '/path');
    }
    return path + suffix;
  }
  if (typeof path !== 'function') {
    throw new LinqBuildError('JL0101',
      'a patch path is a lambda over the state — (st) => st.todos — or a JSON Pointer '
      + `string, got ${describeValue(path)}`, '/path');
  }
  const doc = captureAction('a patch path', path);
  const lowered = pointerPieces(doc);
  if (lowered === null) return unlowerable(doc);
  const pieces = suffix === '' ? lowered : [...lowered, { text: suffix }];
  // adjacent literal text is one operand; all-literal is one pointer
  /** @type {any[]} */
  const merged = [];
  /** @type {string | null} */
  let text = null;
  let literal = true;
  for (const piece of pieces) {
    if (piece.expr === undefined) {
      text = text === null ? piece.text : text + piece.text;
      continue;
    }
    if (text !== null) { merged.push(text); text = null; }
    merged.push(piece.expr);
    literal = false;
  }
  if (text !== null) merged.push(text);
  // lifted, not written as data: a `$`-keyed object in a captured tree
  // is a CONSTRUCTOR (the `$map` escape), and this one is an operator
  return literal ? merged[0] : liftExpression({ $concat: merged });
}

/**
 * One operation object, in RFC 6902's member order (`op`, `from`,
 * `path`, `value` — only what applies).
 * @param {string} op
 * @param {any} path
 * @param {{ from?: any, value?: any, hasValue?: boolean, suffix?: string }} parts
 * @returns {any}
 */
function operation(op, path, parts) {
  const out = { op };
  if (parts.from !== undefined) out.from = pathMember(parts.from);
  out.path = pathMember(path, parts.suffix);
  if (parts.hasValue === true) out.value = parts.value;
  return out;
}

/**
 * `{ "op": "add", "path", "value" }` — inserts into an array, or sets a
 * member.
 * @param {any} path - `(st) => st.todos`, or a JSON Pointer string
 * @param {any} value - an expression from the action's scope, or a literal
 * @returns {any}
 * @example
 * add((st) => st.todos, x.payload);
 */
export function add(path, value) { return operation('add', path, { value, hasValue: true }); }

/**
 * `{ "op": "add", "path": "<path>/-", "value" }` — RFC 6902's array
 * APPEND, which is `add` at the array's `-` position and not at the
 * array itself: `add((st) => st.todos, item)` sets `/todos` TO the item
 * and drops the list, because a pointer that names a member replaces
 * that member. The distinction is the RFC's, and it costs a state
 * schema's own `validateState` to find out at dispatch time, so the
 * append has its own name here.
 * @param {any} path - the ARRAY's path
 * @param {any} value
 * @returns {any}
 * @example
 * append((st) => st.todos, { text: x.payload.text, done: false });
 */
export function append(path, value) {
  return operation('add', path, { value, hasValue: true, suffix: '/-' });
}

/**
 * `{ "op": "replace", "path", "value" }` — the op an app transition
 * writes most, and the one an array ELEMENT must use (`add` inserts).
 * @param {any} path
 * @param {any} value
 * @returns {any}
 * @example
 * replace((st) => st.count, s.count.add(1));
 */
export function replace(path, value) {
  return operation('replace', path, { value, hasValue: true });
}

/**
 * `{ "op": "remove", "path" }`.
 * @param {any} path
 * @returns {any}
 */
export function remove(path) { return operation('remove', path, {}); }

/**
 * `{ "op": "move", "from", "path" }`.
 * @param {any} from
 * @param {any} path
 * @returns {any}
 */
export function move(from, path) { return operation('move', path, { from }); }

/**
 * `{ "op": "copy", "from", "path" }`.
 * @param {any} from
 * @param {any} path
 * @returns {any}
 */
export function copy(from, path) { return operation('copy', path, { from }); }

/**
 * `{ "op": "test", "path", "value" }` — a failing test aborts the whole
 * transition (`JA2004`), which is the format's own way to write a
 * precondition.
 * @param {any} path
 * @param {any} value
 * @returns {any}
 */
export function test(path, value) { return operation('test', path, { value, hasValue: true }); }

/**
 * A patch list, as the transition carries it.
 * @param {any} list
 * @returns {any[]}
 */
export function readPatch(list) {
  if (!Array.isArray(list)) {
    throw new LinqBuildError('JL0101',
      'transition() patch is an array of add/replace/remove/move/copy/test operations, got '
      + describeValue(list));
  }
  return list.map((op, i) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string') {
      throw new LinqBuildError('JL0101',
        `transition() patch[${i}] is one of add/replace/remove/move/copy/test, got `
        + describeValue(op), `/patch/${i}`);
    }
    return op;
  });
}
