//@ts-check
/**
 * @file The frame grammar of the port binding (docs/CONTRACT-FORMAT.md
 * §16), shared by `servePort` and `openPortClient`: JSON-safe plain
 * objects marked `jaren: "contract/0.1"`, so contract traffic is
 * distinguishable BY SHAPE from anything else on a shared channel — a
 * frame without the marker is never touched, and never answered.
 *
 * Request ids are `"<clientId>:<seq>"` — the client id a UUID per
 * client instance, the sequence a per-client counter — so two clients
 * on one broadcast channel can never collide, and a client recognizes
 * its own responses with one cheap prefix test before any map lookup.
 * The request members `attempt` and `key` are reserved by the grammar
 * (`schemas/jaren-contract-port.schema.json`) and ignored by this
 * order's server: the attempt id stays caller-side in `meta` (D6 — the
 * identities live in state, never in the transport) and idempotency is
 * not carried on this binding (`capabilities` says so).
 */

/** The frame marker: the protocol and its version. */
export const FRAME_MARKER = 'contract/0.1';

/**
 * A request frame. `input` is the whole (validated) input object, or
 * `null` for an input-less operation.
 * @typedef {{ jaren: string, id: string, op: string, input: unknown }} RequestFrame
 */

/**
 * A response frame: success with the value, or an error envelope —
 * `code` a declared error code or a `JC2xxx` taxonomy/binding code,
 * `details` present only when the failure carries some. Every response
 * carries the server's `trace`.
 * @typedef {{ jaren: string, id: string, ok: true, value: unknown, trace: string }
 *   | { jaren: string, id: string, ok: false, error: { code: string, message: string, details?: unknown, retryable?: boolean }, trace: string }} ResponseFrame
 */

/**
 * A cancel frame: aborts the server-side signal of the named request —
 * an optimization; the client's id scoping is the guarantee. Never
 * answered.
 * @typedef {{ jaren: string, cancel: string }} CancelFrame
 */

/**
 * A subscribe frame: opens one stream (docs/CONTRACT-FORMAT.md §18.2).
 * `input` is the whole (validated) input object or `null`; `lastSeq`,
 * when present, asks to resume after that seq.
 * @typedef {{ jaren: string, subscribe: string, op: string, input: unknown, lastSeq?: number }} SubscribeFrame
 */

/**
 * An unsubscribe frame: closes the named stream. Never answered.
 * @typedef {{ jaren: string, unsubscribe: string }} UnsubscribeFrame
 */

/**
 * A push frame: one stream event, server → client. `event` is
 * `snapshot | patch | error | end` with the §18 data shapes; `seq` is
 * the event's seq (`error`/`end` carry the last delivered one).
 * @typedef {{ jaren: string, id: string, event: string, seq: number, data: unknown }} PushFrame
 */

/**
 * The channel shape both halves accept: a `MessagePort`, a `Worker`, a
 * `BroadcastChannel`, a worker's own `self`, or any object with
 * `postMessage` and a message-listener surface. `start` is called when
 * present (a `MessagePort` queues until it is).
 * @typedef {{ postMessage: (message: any) => void,
 *   addEventListener?: (type: string, listener: (event: any) => void) => void,
 *   removeEventListener?: (type: string, listener: (event: any) => void) => void,
 *   onmessage?: ((event: any) => void) | null,
 *   start?: () => void }} ChannelLike
 */

/**
 * Whether a value is a contract frame at all — the marker test every
 * listener applies first, so foreign traffic on a shared channel is
 * ignored by shape. Reads one member of a plain object; total.
 * @param {unknown} value
 * @returns {value is { jaren: string }}
 */
export function isContractFrame(value) {
  return value !== null && typeof value === 'object' && /** @type {any} */ (value).jaren === FRAME_MARKER;
}

/**
 * @param {string} id
 * @param {string} op
 * @param {unknown} input
 * @returns {RequestFrame}
 */
export function requestFrame(id, op, input) {
  return { jaren: FRAME_MARKER, id, op, input };
}

/**
 * @param {string} id
 * @param {unknown} value - `undefined` is carried as `null` (frames are JSON)
 * @param {string} trace
 * @returns {ResponseFrame}
 */
export function valueFrame(id, value, trace) {
  return { jaren: FRAME_MARKER, id, ok: true, value: value === undefined ? null : value, trace };
}

/**
 * @param {string} id
 * @param {string} code
 * @param {string} message
 * @param {unknown} details - omitted from the frame when `undefined`
 * @param {boolean} retryable
 * @param {string} trace
 * @returns {ResponseFrame}
 */
export function errorFrame(id, code, message, details, retryable, trace) {
  return details === undefined
    ? { jaren: FRAME_MARKER, id, ok: false, error: { code, message, retryable }, trace }
    : { jaren: FRAME_MARKER, id, ok: false, error: { code, message, details, retryable }, trace };
}

/**
 * @param {string} id
 * @returns {CancelFrame}
 */
export function cancelFrame(id) {
  return { jaren: FRAME_MARKER, cancel: id };
}

/**
 * @param {string} id
 * @param {string} op
 * @param {unknown} input
 * @param {number | null} lastSeq - omitted from the frame when `null`
 * @returns {SubscribeFrame}
 */
export function subscribeFrame(id, op, input, lastSeq) {
  return lastSeq === null
    ? { jaren: FRAME_MARKER, subscribe: id, op, input }
    : { jaren: FRAME_MARKER, subscribe: id, op, input, lastSeq };
}

/**
 * @param {string} id
 * @returns {UnsubscribeFrame}
 */
export function unsubscribeFrame(id) {
  return { jaren: FRAME_MARKER, unsubscribe: id };
}

/**
 * @param {string} id
 * @param {string} event - `snapshot | patch | error | end`
 * @param {number} seq
 * @param {unknown} data
 * @returns {PushFrame}
 */
export function pushFrame(id, event, seq, data) {
  return { jaren: FRAME_MARKER, id, event, seq, data: data === undefined ? null : data };
}

/**
 * Attach a message listener to a channel: `addEventListener` where the
 * channel has one (plus `start()`, which a `MessagePort` needs to begin
 * delivery), the `onmessage` slot otherwise. Returns the detacher.
 * @param {ChannelLike} channel
 * @param {(event: any) => void} listener
 * @returns {() => void}
 */
export function attach(channel, listener) {
  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', listener);
    if (typeof channel.start === 'function') channel.start();
    return () => {
      if (typeof channel.removeEventListener === 'function') channel.removeEventListener('message', listener);
    };
  }
  channel.onmessage = listener;
  return () => {
    if (channel.onmessage === listener) channel.onmessage = null;
  };
}

/**
 * Whether a value is a usable channel. The listener surface is either
 * `addEventListener` or an assignable `onmessage` slot — `in` sees the
 * slot on platform channels and plain fakes alike.
 * @param {unknown} value
 * @returns {value is ChannelLike}
 */
export function isChannel(value) {
  if (value === null || typeof value !== 'object') return false;
  const c = /** @type {any} */ (value);
  return typeof c.postMessage === 'function'
    && (typeof c.addEventListener === 'function' || 'onmessage' in c);
}
