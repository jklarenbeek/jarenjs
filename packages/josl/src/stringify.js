//#region JOSL writer
// Serializes a JS value to JOSL text, or to strict TOML 1.0 with
// `mode: 'toml'` — in which case the JOSL-only types must be downleveled:
// null is omitted or an error (`onNull`), regexps become strings or an
// error (`onRegExp`), and bigints are emitted plain while they fit TOML's
// 64-bit integer range. Round-trips are faithful for data, not for
// formatting: key order is preserved, comments do not exist in the value
// model, and any array whose elements are all plain objects is emitted in
// array-of-tables form.

import { JoslStringifyError } from './errors.js';
import { LocalDate, LocalTime, LocalDateTime } from './values.js';

const RE_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const TOML_INT_MIN = -(2n ** 63n);
const TOML_INT_MAX = 2n ** 63n - 1n;

/**
 * Whether a value serializes as a table (a plain object).
 * @param {*} v - The value
 * @returns {boolean} True for plain objects
 */
export function isPlainTable(v) {
  return isPlainObject(v);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// eslint-disable-next-line no-control-regex
const RE_NEEDS_ESCAPE = /["\\\u0000-\u001F\u007F]/;

function escapeChar(c) {
  if (c === 0x22)
    return '\\"';
  if (c === 0x5C)
    return '\\\\';
  if (c === 0x08)
    return '\\b';
  if (c === 0x09)
    return '\\t';
  if (c === 0x0A)
    return '\\n';
  if (c === 0x0C)
    return '\\f';
  if (c === 0x0D)
    return '\\r';
  return `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

function quoteString(s) {
  if (!RE_NEEDS_ESCAPE.test(s))
    return `"${s}"`;
  // Copy unescaped runs whole; only escape characters break the run.
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; ++i) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5C || c < 0x20 || c === 0x7F) {
      if (start < i)
        out += s.slice(start, i);
      out += escapeChar(c);
      start = i + 1;
    }
  }
  if (start < s.length)
    out += s.slice(start);
  return out + '"';
}

function fmtKey(k) {
  return RE_BARE_KEY.test(k) ? k : quoteString(k);
}

function fmtPath(path) {
  let out = '';
  for (let i = 0; i < path.length; ++i)
    out += (i === 0 ? '' : '.') + fmtKey(path[i]);
  return out;
}

function fmtNumber(v) {
  if (Number.isFinite(v))
    return Object.is(v, -0) ? '-0.0' : String(v);
  if (Number.isNaN(v))
    return 'nan';
  return v === Infinity ? 'inf' : '-inf';
}

// The error path lives on `ctx.path` as a mutable stack (pushed/popped
// around each descent) so the happy path allocates no per-key arrays; it
// is sliced only at a throw site.
function fmtValue(ctx, v) {
  switch (typeof v) {
    case 'string':
      return quoteString(v);
    case 'number':
      return fmtNumber(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      if (ctx.mode === 'toml') {
        if (v < TOML_INT_MIN || v > TOML_INT_MAX)
          throw new JoslStringifyError('bigint exceeds the TOML 64-bit integer range', ctx.path.slice());
        return String(v);
      }
      return `${v}n`;
    case 'object':
      break;
    default:
      throw new JoslStringifyError(`cannot represent a ${typeof v} value`, ctx.path.slice());
  }
  if (v === null) {
    if (ctx.mode === 'toml')
      throw new JoslStringifyError('TOML cannot represent null', ctx.path.slice());
    return 'null';
  }
  if (v instanceof Date)
    return v.toISOString();
  if (v instanceof LocalDate || v instanceof LocalTime || v instanceof LocalDateTime)
    return v.toString();
  if (v instanceof RegExp) {
    if (ctx.mode === 'toml') {
      if (ctx.onRegExp === 'string')
        return quoteString(`/${v.source}/${v.flags}`);
      throw new JoslStringifyError('TOML cannot represent a RegExp', ctx.path.slice());
    }
    return `/${v.source}/${v.flags}`;
  }
  if (Array.isArray(v)) {
    if (ctx.seen.has(v))
      throw new JoslStringifyError('circular reference', ctx.path.slice());
    ctx.seen.add(v);
    let out = '[';
    for (let i = 0; i < v.length; ++i) {
      ctx.path.push(i);
      out += (i === 0 ? ' ' : ', ') + fmtValue(ctx, v[i]);
      ctx.path.pop();
    }
    ctx.seen.delete(v);
    return v.length === 0 ? '[]' : out + ' ]';
  }
  if (isPlainObject(v)) {
    if (ctx.seen.has(v))
      throw new JoslStringifyError('circular reference', ctx.path.slice());
    ctx.seen.add(v);
    let out = '{';
    let first = true;
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; ++i) {
      const k = keys[i];
      const e = v[k];
      if (e === null && ctx.mode === 'toml' && ctx.onNull === 'omit')
        continue;
      ctx.path.push(k);
      out += (first ? ' ' : ', ') + `${fmtKey(k)} = ${fmtValue(ctx, e)}`;
      ctx.path.pop();
      first = false;
    }
    ctx.seen.delete(v);
    return first ? '{}' : out + ' }';
  }
  throw new JoslStringifyError('cannot represent this object type', ctx.path.slice());
}

// `header` is the already-formatted dotted header prefix ('' at the root),
// so a nested section formats only its own key instead of re-walking every
// ancestor. Values are read exactly once (a getter must not fire twice):
// deferred tables/arrays-of-tables are kept as flat [key, value, ...] runs.
function emitTable(ctx, header, obj) {
  if (ctx.seen.has(obj))
    throw new JoslStringifyError('circular reference', ctx.path.slice());
  ctx.seen.add(obj);
  const keys = Object.keys(obj);
  let tables = null;
  let aots = null;
  for (let i = 0; i < keys.length; ++i) {
    const k = keys[i];
    const v = obj[k];
    if (v === undefined)
      continue;
    if (v === null && ctx.mode === 'toml' && ctx.onNull === 'omit')
      continue;
    if (isPlainObject(v))
      (tables ??= []).push(k, v);
    else if (Array.isArray(v) && v.length !== 0 && v.every(isPlainObject))
      (aots ??= []).push(k, v);
    else {
      ctx.path.push(k);
      ctx.out.push(`${fmtKey(k)} = ${fmtValue(ctx, v)}`);
      ctx.path.pop();
    }
  }
  if (tables !== null) {
    for (let i = 0; i < tables.length; i += 2) {
      const k = tables[i];
      const h = header === '' ? fmtKey(k) : `${header}.${fmtKey(k)}`;
      if (ctx.out.length !== 0)
        ctx.out.push('');
      ctx.out.push(`[${h}]`);
      ctx.path.push(k);
      emitTable(ctx, h, tables[i + 1]);
      ctx.path.pop();
    }
  }
  if (aots !== null) {
    for (let i = 0; i < aots.length; i += 2) {
      const k = aots[i];
      const arr = aots[i + 1];
      const h = header === '' ? fmtKey(k) : `${header}.${fmtKey(k)}`;
      const line = `[[${h}]]`;
      ctx.path.push(k);
      for (let j = 0; j < arr.length; ++j) {
        if (ctx.out.length !== 0)
          ctx.out.push('');
        ctx.out.push(line);
        ctx.path.push(j);
        emitTable(ctx, h, arr[j]);
        ctx.path.pop();
      }
      ctx.path.pop();
    }
  }
  ctx.seen.delete(obj);
}

function makeCtx(options) {
  return {
    mode: options.mode === 'toml' ? 'toml' : 'josl',
    onNull: options.onNull === 'omit' ? 'omit' : 'error',
    onRegExp: options.onRegExp === 'string' ? 'string' : 'error',
    out: [],
    seen: new Set(),
    path: [],
  };
}

/**
 * Format a single key (bare when possible, quoted otherwise).
 * @param {string} key - The key
 * @returns {string} JOSL/TOML key text
 */
export function formatKey(key) {
  return fmtKey(key);
}

/**
 * Format a dotted key path.
 * @param {string[]} path - Key path segments
 * @returns {string} Dotted key path text
 */
export function formatKeyPath(path) {
  return fmtPath(path);
}

/**
 * Format a single value (scalars, inline arrays, inline tables).
 * @param {*} value - The value
 * @param {object} [options] - Writer options; see `stringifyJosl`
 * @param {(string|number)[]} [path] - Error-reporting path
 * @returns {string} JOSL/TOML value text
 * @throws {JoslStringifyError} When the value cannot be represented
 */
export function formatValue(value, options = {}, path = []) {
  const ctx = makeCtx(options);
  ctx.path = path.slice();
  return fmtValue(ctx, value);
}

/**
 * Format a table body: its pairs followed by nested `[header]` /
 * `[[header]]` sections, with headers made relative to `headerPath`.
 * @param {object} obj - A plain object table
 * @param {object} [options] - Writer options; see `stringifyJosl`
 * @param {string[]} [headerPath] - Prefix for nested section headers
 * @returns {string} Section text (newline terminated, may be empty)
 * @throws {JoslStringifyError} When a value cannot be represented
 */
export function formatSection(obj, options = {}, headerPath = []) {
  const ctx = makeCtx(options);
  emitTable(ctx, fmtPath(headerPath), obj);
  return ctx.out.length === 0 ? '' : ctx.out.join('\n') + '\n';
}

/**
 * Serialize a value to JOSL (or strict TOML) text.
 * @param {object|Array} value - A plain object root, or (JOSL mode only)
 *  an array of plain objects for a [[]] root-array document
 * @param {object} [options] - Writer options
 * @param {'josl'|'toml'} [options.mode] - 'toml' emits strict TOML 1.0
 * @param {'error'|'omit'} [options.onNull] - TOML mode: what to do with
 *  null table values (array elements always error)
 * @param {'error'|'string'} [options.onRegExp] - TOML mode: represent
 *  regexps as strings, or error
 * @returns {string} The serialized document, newline terminated
 * @throws {JoslStringifyError} When the value cannot be represented
 */
export function stringifyJosl(value, options = {}) {
  const ctx = makeCtx(options);
  if (Array.isArray(value)) {
    if (ctx.mode === 'toml')
      throw new JoslStringifyError('a TOML root must be a table; root arrays are a JOSL extension');
    for (let i = 0; i < value.length; ++i) {
      if (!isPlainObject(value[i]))
        throw new JoslStringifyError('root array elements must be tables', [i]);
      if (ctx.out.length !== 0)
        ctx.out.push('');
      ctx.out.push('[[]]');
      ctx.path.push(i);
      emitTable(ctx, '', value[i]);
      ctx.path.pop();
    }
    if (value.length === 0)
      return '';
  }
  else if (isPlainObject(value))
    emitTable(ctx, '', value);
  else
    throw new JoslStringifyError(ctx.mode === 'toml'
      ? 'a TOML root must be a table'
      : 'a JOSL root must be a table or an array of tables');
  return ctx.out.length === 0 ? '' : ctx.out.join('\n') + '\n';
}

/**
 * Serialize a value to strict TOML 1.0 text.
 * @param {object} value - A plain object root
 * @param {object} [options] - Writer options minus `mode`
 * @returns {string} The serialized document
 */
export function stringifyToml(value, options = {}) {
  return stringifyJosl(value, { ...options, mode: 'toml' });
}

export { JoslStringifyError } from './errors.js';

//#endregion
