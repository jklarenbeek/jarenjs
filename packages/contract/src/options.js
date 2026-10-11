//@ts-check
/** @file Admission shared by the contract bindings: the handler table a server
 * serves, the option members every server reads, closed option records,
 * subscribe options and genuine AbortSignals, refused before a transport or
 * handler sees them. */
import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * @param {unknown} options
 * @param {readonly string[]} known
 * @param {(reason: string) => Error} refusal
 * @param {string} [label]
 * @returns {asserts options is Record<string, any>}
 */
export function admitOptions(options, known, refusal, label = 'options') {
  if (!isPlainOptions(options)) throw refusal(`${label} must be a plain object`);
  refuseUnknownMembers(options, known, (key, hint) => refusal(`${label} has no member '${key}'${hint}`));
}

/**
 * Use the platform's brand check, which also accepts signals from another
 * realm. A shape with an `aborted` member can still fail AbortSignal.any
 * or lose its listeners, so it is not an admitted cancellation signal.
 * @param {unknown} value
 * @param {(reason: string) => Error} refusal
 * @param {string} [label]
 * @returns {AbortSignal | null}
 */
export function admitSignal(value, refusal, label = 'options.signal') {
  if (value === undefined || value === null) return null;
  try {
    const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (readAborted === undefined) throw new TypeError('AbortSignal has no aborted accessor');
    readAborted.call(value);
    return /** @type {AbortSignal} */ (value);
  }
  catch {
    throw refusal(`${label} must be an AbortSignal or null`);
  }
}

/**
 * The handler table every server binding takes: a compiled contract and an
 * object of operation id → function, each id an operation of the contract.
 * @param {any} contract
 * @param {any} handlers
 * @param {(reason: string) => Error} refusal
 * @returns {void}
 */
export function admitHandlers(contract, handlers, refusal) {
  if (contract === null || typeof contract !== 'object' || typeof contract.match !== 'function'
    || contract.operations === null || typeof contract.operations !== 'object' || !Array.isArray(contract.ids)) {
    throw refusal('the first argument must be a compiled contract (compileContract)');
  }
  if (handlers === null || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw refusal('handlers must be an object of operation id → function');
  }
  for (const id of Object.keys(handlers)) {
    if (!Object.hasOwn(contract.operations, id)) {
      throw refusal(`handlers names '${id}', which is not an operation of the contract`);
    }
    if (typeof handlers[id] !== 'function') {
      throw refusal(`the handler of '${id}' must be a function, got ${typeof handlers[id]}`);
    }
  }
}

/**
 * The option members every server binding reads alike: `validateOutput`
 * (`'always'` by default), the named function members, and a message
 * catalog object.
 * @param {Record<string, any>} options
 * @param {readonly string[]} functions - the members that must be functions
 * @param {(reason: string) => Error} refusal
 * @returns {'always' | 'never'} the validated `validateOutput`
 */
export function admitServeOptions(options, functions, refusal) {
  const validateOutput = options.validateOutput === undefined ? 'always' : options.validateOutput;
  if (validateOutput !== 'always' && validateOutput !== 'never') {
    throw refusal("options.validateOutput must be 'always' or 'never'");
  }
  for (const name of functions) {
    if (options[name] !== undefined && typeof options[name] !== 'function') throw refusal(`options.${name} must be a function`);
  }
  if (options.catalog !== undefined && (options.catalog === null || typeof options.catalog !== 'object')) {
    throw refusal('options.catalog must be a message catalog object');
  }
  return validateOutput;
}

/**
 * The options of a client's `subscribe`: the four callbacks, `lastSeq`, the
 * `reconnect` budget and a signal. Both client carriers admit them alike; a
 * carrier with no reconnect reads `reconnectMax` as nothing.
 * @param {unknown} options
 * @param {(reason: string) => Error} refusal
 * @returns {{ lastSeq: number | null, reconnectMax: number, signal: AbortSignal | null }}
 */
export function admitSubscribeOptions(options, refusal) {
  admitOptions(options, ['onSnapshot', 'onPatch', 'onError', 'onEnd', 'signal', 'lastSeq', 'reconnect'], refusal, 'subscribe options');
  for (const name of ['onSnapshot', 'onPatch', 'onError', 'onEnd']) {
    const cb = options[name];
    if (cb !== undefined && typeof cb !== 'function') throw refusal(`options.${name} must be a function`);
  }
  let lastSeq = null;
  if (options.lastSeq !== undefined && options.lastSeq !== null) {
    if (!Number.isInteger(options.lastSeq) || options.lastSeq < 0) throw refusal('options.lastSeq must be a non-negative integer');
    lastSeq = options.lastSeq;
  }
  let reconnectMax = 0;
  if (options.reconnect !== undefined && options.reconnect !== null) {
    const reconnect = options.reconnect;
    admitOptions(reconnect, ['max'], refusal, 'options.reconnect');
    if (!Number.isInteger(reconnect.max) || reconnect.max < 0) {
      throw refusal('options.reconnect must be { max } with a non-negative integer number of further attempts');
    }
    reconnectMax = reconnect.max;
  }
  return { lastSeq, reconnectMax, signal: admitSignal(options.signal, refusal) };
}
