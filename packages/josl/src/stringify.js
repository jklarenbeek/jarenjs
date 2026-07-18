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

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function quoteString(s) {
  let out = '"';
  for (let i = 0; i < s.length; ++i) {
    const c = s.charCodeAt(i);
    if (c === 0x22)
      out += '\\"';
    else if (c === 0x5C)
      out += '\\\\';
    else if (c === 0x08)
      out += '\\b';
    else if (c === 0x09)
      out += '\\t';
    else if (c === 0x0A)
      out += '\\n';
    else if (c === 0x0C)
      out += '\\f';
    else if (c === 0x0D)
      out += '\\r';
    else if (c < 0x20 || c === 0x7F)
      out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
    else
      out += s[i];
  }
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
  if (Number.isNaN(v))
    return 'nan';
  if (v === Infinity)
    return 'inf';
  if (v === -Infinity)
    return '-inf';
  if (Object.is(v, -0))
    return '-0.0';
  return String(v);
}

function fmtValue(ctx, v, path) {
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
          throw new JoslStringifyError('bigint exceeds the TOML 64-bit integer range', path);
        return String(v);
      }
      return `${v}n`;
    case 'object':
      break;
    default:
      throw new JoslStringifyError(`cannot represent a ${typeof v} value`, path);
  }
  if (v === null) {
    if (ctx.mode === 'toml')
      throw new JoslStringifyError('TOML cannot represent null', path);
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
      throw new JoslStringifyError('TOML cannot represent a RegExp', path);
    }
    return `/${v.source}/${v.flags}`;
  }
  if (Array.isArray(v)) {
    if (ctx.seen.has(v))
      throw new JoslStringifyError('circular reference', path);
    ctx.seen.add(v);
    let out = '[';
    for (let i = 0; i < v.length; ++i)
      out += (i === 0 ? ' ' : ', ') + fmtValue(ctx, v[i], path.concat(i));
    ctx.seen.delete(v);
    return v.length === 0 ? '[]' : out + ' ]';
  }
  if (isPlainObject(v)) {
    if (ctx.seen.has(v))
      throw new JoslStringifyError('circular reference', path);
    ctx.seen.add(v);
    let out = '{';
    let first = true;
    for (const [k, e] of Object.entries(v)) {
      if (e === null && ctx.mode === 'toml' && ctx.onNull === 'omit')
        continue;
      out += (first ? ' ' : ', ') + `${fmtKey(k)} = ${fmtValue(ctx, e, path.concat(k))}`;
      first = false;
    }
    ctx.seen.delete(v);
    return first ? '{}' : out + ' }';
  }
  throw new JoslStringifyError('cannot represent this object type', path);
}

function emitTable(ctx, headerPath, errPath, obj) {
  if (ctx.seen.has(obj))
    throw new JoslStringifyError('circular reference', errPath);
  ctx.seen.add(obj);
  const pairs = [];
  const tables = [];
  const aots = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined)
      continue;
    if (v === null && ctx.mode === 'toml' && ctx.onNull === 'omit')
      continue;
    if (isPlainObject(v))
      tables.push([k, v]);
    else if (Array.isArray(v) && v.length !== 0 && v.every(isPlainObject))
      aots.push([k, v]);
    else
      pairs.push([k, v]);
  }
  for (const [k, v] of pairs)
    ctx.out.push(`${fmtKey(k)} = ${fmtValue(ctx, v, errPath.concat(k))}`);
  for (const [k, v] of tables) {
    if (ctx.out.length !== 0)
      ctx.out.push('');
    ctx.out.push(`[${fmtPath(headerPath.concat(k))}]`);
    emitTable(ctx, headerPath.concat(k), errPath.concat(k), v);
  }
  for (const [k, arr] of aots) {
    for (let i = 0; i < arr.length; ++i) {
      if (ctx.out.length !== 0)
        ctx.out.push('');
      ctx.out.push(`[[${fmtPath(headerPath.concat(k))}]]`);
      emitTable(ctx, headerPath.concat(k), errPath.concat(k, i), arr[i]);
    }
  }
  ctx.seen.delete(obj);
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
  const ctx = {
    mode: options.mode === 'toml' ? 'toml' : 'josl',
    onNull: options.onNull === 'omit' ? 'omit' : 'error',
    onRegExp: options.onRegExp === 'string' ? 'string' : 'error',
    out: [],
    seen: new Set(),
  };
  if (Array.isArray(value)) {
    if (ctx.mode === 'toml')
      throw new JoslStringifyError('a TOML root must be a table; root arrays are a JOSL extension');
    for (let i = 0; i < value.length; ++i) {
      if (!isPlainObject(value[i]))
        throw new JoslStringifyError('root array elements must be tables', [i]);
      if (ctx.out.length !== 0)
        ctx.out.push('');
      ctx.out.push('[[]]');
      emitTable(ctx, [], [i], value[i]);
    }
    if (value.length === 0)
      return '';
  }
  else if (isPlainObject(value))
    emitTable(ctx, [], [], value);
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
