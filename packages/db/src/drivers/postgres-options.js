//@ts-check
/** Finite resource and server deadline defaults, shared by PG host owners. */
import { positiveOption } from './worker-protocol.js';
import { DbCompileError } from '../errors.js';

export const POSTGRES_DEFAULTS = Object.freeze({ windowRows: 64, windowBytes: 1048576,
  maxPending: 64, maxStatements: 256, maxCursors: 64, allMaxRows: 100000,
  allMaxBytes: 16777216, maxConnections: 8, queueCapacity: 64,
  acquisitionTimeoutMs: 5000, statementTimeoutMs: 30000, lockTimeoutMs: 5000,
  closeTimeoutMs: 5000, cursorLifetimeMs: 30000 });

/** The closed notification identifier shared by publishers and listeners.
 * @param {any} value @returns {string} */
export function postgresChannel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value) || value.length > 63)
    throw new DbCompileError('JD0003', 'notification channel must be a plain identifier of at most 63 bytes');
  return value;
}

/** @param {any} options */
export function postgresSettings(options = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(POSTGRES_DEFAULTS)) {
    result[key] = positiveOption(key, options[key], fallback);
    if (key.endsWith('Ms') && result[key] > 2147483647)
      throw new TypeError(`${key} exceeds the timer range`);
  }
  if (options.prepared !== undefined && !['named', 'unnamed'].includes(options.prepared))
    throw new TypeError('prepared is named or unnamed');
  if (options.cursorMode !== undefined && !['native', 'buffered'].includes(options.cursorMode))
    throw new TypeError('cursorMode is native or buffered');
  if (options.poolMode !== undefined && options.poolMode !== 'session')
    throw new DbCompileError('JD0003', 'the PostgreSQL Store requires session affinity; transaction poolers are unsupported');
  return Object.freeze(result);
}
