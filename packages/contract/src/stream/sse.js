//@ts-check
/**
 * @file The stream wire's shared shapes (docs/CONTRACT-FORMAT.md §18):
 * the stream code table as data (`STREAM_ERRORS`, the same
 * table-as-data shape as `HTTP_ERRORS` and `PORT_LOCAL_ERRORS`), the
 * event names both carriers speak, and the SSE text framing on top of
 * `@jarenjs/core/text/sse` — one JSON value per event, a heartbeat
 * comment line, and the `JC1009` host refusal for text the frame
 * cannot carry. The port carrier uses the same tables and data shapes
 * with no SSE text at all (§18.2).
 */

import { encodeSseEvent } from '@jarenjs/core/text/sse';

import { ContractHostError } from '../errors.js';

/**
 * The stream request-time codes — code → `{ kind, msgid, retryable }`.
 * The normative table is docs/CONTRACT-FORMAT.md §18.3; a test holds
 * them equal. `JC2095` (a refused resume) is deliberately absent: it is
 * informational, carried as `resumed: false` in a snapshot's event
 * data, never an outcome.
 */
export const STREAM_ERRORS = Object.freeze({
  JC2090: Object.freeze({ kind: 'contract', msgid: 'contract/not-a-stream', retryable: false }),
  JC2091: Object.freeze({ kind: 'contract', msgid: 'contract/invalid-snapshot', retryable: false }),
  JC2092: Object.freeze({ kind: 'contract', msgid: 'contract/seq-regression', retryable: false }),
  JC2093: Object.freeze({ kind: 'contract', msgid: 'contract/stream-error', retryable: false }),
  JC2094: Object.freeze({ kind: 'network', msgid: 'contract/heartbeat-missed', retryable: true }),
});

/** The event names of the stream wire, on both carriers. */
export const STREAM_EVENTS = Object.freeze(['snapshot', 'patch', 'error', 'end']);

/** The media type of the SSE carrier. */
export const STREAM_MEDIA = 'text/event-stream';

/** The heartbeat comment line the SSE carrier writes every `heartbeatMs`. */
export const HEARTBEAT_LINE = ':\n\n';

/**
 * One stream event as SSE text: the event name, the seq as the SSE id,
 * the JSON data. JSON output never carries a raw CR, so the encoder's
 * refusal is reachable only through a host handing this function
 * non-JSON text — `JC1009`, thrown.
 * @param {string} event - `snapshot | patch | error | end`
 * @param {number | null} seq - the event's seq; `null` writes no id line
 * @param {unknown} data - the event's JSON data
 * @returns {string}
 * @throws {ContractHostError} `JC1009` when the text cannot ride an SSE frame
 */
export function encodeStreamEvent(event, seq, data) {
  let text;
  try {
    text = JSON.stringify(data);
  }
  catch (err) {
    throw new ContractHostError('JC1009', `the ${event} event's data cannot be serialized as JSON (${err instanceof Error ? err.message : 'not JSON'})`);
  }
  if (text === undefined) text = 'null';
  try {
    return encodeSseEvent({ event, id: seq === null ? null : String(seq), data: text });
  }
  catch (err) {
    throw new ContractHostError('JC1009', err instanceof Error ? err.message : 'the event cannot ride an SSE frame');
  }
}
