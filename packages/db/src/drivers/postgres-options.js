//@ts-check
/** Finite resource and server deadline defaults, shared by PG host owners. */
import { positiveOption } from './worker-protocol.js';
import { DbCompileError } from '../errors.js';
import { refuseUnknownMembers } from '../options.js';

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

/** Every member `postgresDriver` reads: the limits and its session
 * policy. A CLOSED set — a misspelt `statmentTimeoutMs` used to leave
 * the server default in force without a word. */
export const POSTGRES_DRIVER_OPTIONS = Object.freeze([...Object.keys(POSTGRES_DEFAULTS),
  'schema', 'notifyChannel', 'queueTimeout', 'poolMode', 'prepared', 'cursorMode', 'destroy', 'cancel']);

/** What `adaptPostgresClient` reads: the driver's set, plus the members
 * the driver hands one acquired client. */
export const POSTGRES_ADAPTER_OPTIONS = Object.freeze([...POSTGRES_DRIVER_OPTIONS,
  'onClose', 'nativeCursor', 'serverTimeouts', 'cacheIdentity']);

/** What `postgresNotifications` reads: the limits and its listener policy. */
export const POSTGRES_NOTIFICATION_OPTIONS = Object.freeze([...Object.keys(POSTGRES_DEFAULTS),
  'channel', 'maxReconnects', 'retryBaseMs', 'retryMaxMs']);

/**
 * Refuse an option outside a PostgreSQL owner's closed set (`JD0003`,
 * the driver's configuration refusal), naming the nearest member.
 * @param {any} options
 * @param {readonly string[]} known
 * @param {string} owner - how the call reads, for the message
 */
export function refuseUnknownPostgresOptions(options, known, owner) {
  if (options === null || typeof options !== 'object') return;
  refuseUnknownMembers(options, known, (key, hint) =>
    new DbCompileError('JD0003', `${owner} option '${key}' is not one it reads${hint}`));
}

/**
 * @param {any} options
 * @param {readonly string[]} [known] - the caller's closed set
 * @param {string} [owner] - how the call reads, for the message
 */
export function postgresSettings(options = {}, known = POSTGRES_DRIVER_OPTIONS, owner = 'postgresDriver') {
  refuseUnknownPostgresOptions(options, known, owner);
  const result = {};
  for (const [key, fallback] of Object.entries(POSTGRES_DEFAULTS)) {
    result[key] = positiveOption(key, options[key], fallback);
    if (key.endsWith('Ms') && result[key] > 2147483647)
      throw new TypeError(`${key} exceeds the timer range`);
  }
  // the store's own rule for the same member: `Infinity`, a negative or a
  // fraction used to become a 1 ms wait (or none) behind a transaction
  const { queueTimeout } = options;
  if (queueTimeout !== undefined
    && (!Number.isInteger(queueTimeout) || queueTimeout < 0 || queueTimeout > 0x7fffffff))
    throw new DbCompileError('JD0003', `${owner} option 'queueTimeout' is a whole number of milliseconds from 0 to 2147483647`);
  if (options.prepared !== undefined && !['named', 'unnamed'].includes(options.prepared))
    throw new TypeError('prepared is named or unnamed');
  if (options.cursorMode !== undefined && !['native', 'buffered'].includes(options.cursorMode))
    throw new TypeError('cursorMode is native or buffered');
  if (options.poolMode !== undefined && options.poolMode !== 'session')
    throw new DbCompileError('JD0003', 'the PostgreSQL Store requires session affinity; transaction poolers are unsupported');
  return Object.freeze(result);
}
