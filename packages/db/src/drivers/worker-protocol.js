//@ts-check
/** Structured-clone frames; identities belong to one connection generation. */
import { DbRuntimeError } from '../errors.js';
import { jsonStringBytes } from '../json-bytes.js';

export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_DEFAULTS = Object.freeze({ windowRows: 64, windowBytes: 1048576,
  maxPending: 64, maxStatements: 1024, maxCursors: 64, allMaxRows: 100000,
  allMaxBytes: 16777216, closeTimeoutMs: 5000, startupTimeoutMs: 10000 });
export const PROCESS_DEFAULTS = Object.freeze({ ...WORKER_DEFAULTS, closeTimeoutMs: 1000,
  maxOwners: 4, timeoutMs: 250, maxRequestBytes: 1048576 });
const operations = new Set(['exec', 'prepare', 'run', 'get', 'iterate', 'next', 'return', 'finalize', 'close']);

/** @param {number} generation @param {boolean} [transaction] @param {unknown} [cause] */
export function generationFailure(generation, transaction = false, cause = undefined) {
  return Object.assign(new DbRuntimeError('JD2090',
    `driver generation ${generation} is no longer available; reopen the connection; no operation was replayed`,
    { cause }), { class: 'generation', retryable: !transaction, generation });
}

/** @param {any} frame @returns {boolean} */
export function validRequest(frame) {
  if (frame === null || typeof frame !== 'object' || frame.v !== WORKER_PROTOCOL_VERSION
    || frame.kind !== 'request' || !Number.isSafeInteger(frame.id) || frame.id < 1
    || !Number.isSafeInteger(frame.generation) || frame.generation < 1 || !operations.has(frame.op)) return false;
  if (frame.op === 'exec' || frame.op === 'prepare') return typeof frame.sql === 'string';
  if (['run', 'get', 'iterate'].includes(frame.op))
    return Number.isSafeInteger(frame.statement) && frame.statement > 0 && Array.isArray(frame.params);
  if (frame.op === 'next') return Number.isSafeInteger(frame.cursor) && frame.cursor > 0
    && Number.isSafeInteger(frame.rows) && frame.rows > 0 && Number.isSafeInteger(frame.bytes) && frame.bytes > 0;
  if (frame.op === 'return') return Number.isSafeInteger(frame.cursor) && frame.cursor > 0;
  if (frame.op === 'finalize') return Number.isSafeInteger(frame.statement) && frame.statement > 0;
  return true;
}

/** Validate clone frames before dereferencing a remote payload.
 * @param {any} frame @param {number} generation @returns {boolean}
 */
export function validResponse(frame, generation) {
  if (frame === null || typeof frame !== 'object' || frame.v !== WORKER_PROTOCOL_VERSION
    || frame.generation !== generation || !Number.isSafeInteger(frame.id) || frame.id < 0) return false;
  if (frame.kind === 'ready') return frame.id === 0 && frame.capabilities !== null
    && typeof frame.capabilities === 'object' && typeof frame.capabilities.version === 'string';
  if (frame.kind === 'failure') return frame.error !== null && typeof frame.error === 'object'
    && typeof frame.error.message === 'string';
  return frame.kind === 'result' && frame.id > 0;
}

/** @param {string} op @param {any} value @param {{rows:number, bytes:number}} limits */
export function validResult(op, value, limits) {
  if (op === 'prepare' || op === 'iterate') return Number.isSafeInteger(value) && value > 0;
  if (op !== 'next') return true;
  return value !== null && typeof value === 'object' && Array.isArray(value.rows)
    && value.rows.length <= limits.rows && typeof value.done === 'boolean'
    && (value.rows.length > 0 || value.done) && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0 && value.bytes <= limits.bytes
    && value.rows.reduce((sum, row) => sum + rowBytes(row), 0) === value.bytes;
}

/** A stable credit measure: JSON keys/scalars and raw blob bytes. Transport
 * metadata is fixed per frame; no JSON string or copied blob is allocated.
 * @param {any} value @returns {number}
 */
export function rowBytes(value) {
  if (value === null || value === undefined) return 4;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'string') return jsonStringBytes(value);
  if (typeof value !== 'object') return String(value).length;
  let bytes = 2;
  for (const key of Object.keys(value)) bytes += jsonStringBytes(key) + 2 + rowBytes(value[key]);
  return bytes;
}

/** @param {string} name @param {any} value @param {number} fallback @returns {number} */
export function positiveOption(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

/** One validation and spelling of shared transport credits.
 * @param {any} configuration @param {typeof WORKER_DEFAULTS} [defaults] */
export function workerSettings(configuration, defaults = WORKER_DEFAULTS) {
  const values = Object.fromEntries(Object.keys(WORKER_DEFAULTS).map((name) =>
    [name, positiveOption(name, configuration[name], defaults[name])]));
  return { limits: { rows: values.windowRows, bytes: values.windowBytes, statements: values.maxStatements, cursors: values.maxCursors },
    maxPending: values.maxPending, allRows: values.allMaxRows, allBytes: values.allMaxBytes,
    closeMs: values.closeTimeoutMs, startupMs: values.startupTimeoutMs };
}

/** @param {string} reason @param {number} depth */
export function queueFailure(reason, depth) {
  return Object.assign(new DbRuntimeError('JD2091', reason), { class: 'queue', retryable: true, depth });
}
