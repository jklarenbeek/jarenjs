//@ts-check
/**
 * @file An incremental Server-Sent-Events codec (WHATWG HTML §9.2).
 * `createSseEventDecoder` yields complete events `{ event, id, data,
 * retry }` from network chunks fed in any split — mid-line, mid-event,
 * CR, LF or CRLF line endings; `createSseDecoder` is the data-only view
 * of the same machine (the shape every OpenAI-compatible streaming
 * endpoint needs: just the `data:` payloads, in order); and
 * `encodeSseEvent` renders one event back to wire text.
 *
 * Dispatch follows the specification: field lines are `name: value`
 * with one optional leading space in the value, `:` lines are comments,
 * an event is dispatched on the blank line exactly when its data buffer
 * is non-empty (multi-line data joins with `\n`), the last-event-id is
 * a stream attribute that persists across events (an `id` field whose
 * value carries U+0000 is ignored), and `retry` must be ASCII digits.
 * `end()` flushes a final event from a stream that never sent its
 * closing blank line.
 */

/**
 * One decoded event. `event` is the `event:` field of the block, `null`
 * when the block had none (the specification's default type "message");
 * `id` is the stream's last-event-id at dispatch, `null` while the
 * stream has not set one; `data` is the joined data payload; `retry` is
 * the reconnection time a `retry:` field set since the previous
 * dispatch, `null` otherwise.
 * @typedef {Object} SseEvent
 * @property {string | null} event
 * @property {string | null} id
 * @property {string} data
 * @property {number | null} retry
 */

/**
 * An incremental decoder yielding complete events.
 * @returns {{ feed: (chunk: string) => SseEvent[], end: () => SseEvent[] }}
 *   `feed` returns the events completed by this chunk; `end` flushes a
 *   final event from a stream that never sent its closing blank line.
 */
export function createSseEventDecoder() {
  let tail = '';
  /** @type {string[]} */
  let data = [];
  /** @type {string | null} */
  let eventType = null;
  /** @type {string | null} */
  let lastId = null;
  /** @type {number | null} */
  let retry = null;

  /**
   * @param {string} line - one complete line, no line terminator
   * @param {SseEvent[]} out
   */
  function consumeLine(line, out) {
    if (line === '') {
      // the dispatch rule: no data, no event — but the type buffer resets
      if (data.length > 0) {
        out.push({ event: eventType, id: lastId, data: data.join('\n'), retry });
        data = [];
        retry = null;
      }
      eventType = null;
      return;
    }
    if (line.charCodeAt(0) === 0x3A) return; // a comment
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1
      ? ''
      : line.slice(line.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1);
    switch (name) {
      case 'data':
        data.push(value);
        break;
      case 'event':
        eventType = value;
        break;
      case 'id':
        if (value.indexOf('\0') === -1) lastId = value;
        break;
      case 'retry':
        if (value.length > 0 && /^[0-9]+$/.test(value)) retry = Number.parseInt(value, 10);
        break;
      // every other field name is ignored by the specification
    }
  }

  return {
    feed(chunk) {
      /** @type {SseEvent[]} */
      const out = [];
      const text = tail + chunk;
      const length = text.length;
      // a trailing CR is held: the next chunk may complete a CRLF
      const limit = length > 0 && text.charCodeAt(length - 1) === 0x0D ? length - 1 : length;
      let start = 0;
      let i = 0;
      while (i < limit) {
        const c = text.charCodeAt(i);
        if (c === 0x0A) {
          consumeLine(text.slice(start, i), out);
          i += 1;
          start = i;
        }
        else if (c === 0x0D) {
          consumeLine(text.slice(start, i), out);
          i += 1;
          if (i < length && text.charCodeAt(i) === 0x0A) i += 1;
          start = i;
        }
        else i += 1;
      }
      tail = text.slice(start);
      return out;
    },
    end() {
      /** @type {SseEvent[]} */
      const out = [];
      if (tail !== '') {
        consumeLine(tail.charCodeAt(tail.length - 1) === 0x0D ? tail.slice(0, -1) : tail, out);
        tail = '';
      }
      if (data.length > 0) {
        out.push({ event: eventType, id: lastId, data: data.join('\n'), retry });
        data = [];
        retry = null;
      }
      eventType = null;
      return out;
    },
  };
}

/**
 * The data-only view of the event decoder: `feed` yields the complete
 * `data:` payloads in order and every other field is ignored — the
 * shape a chat-completion stream consumer needs.
 * @returns {{ feed: (chunk: string) => string[], end: () => string[] }}
 */
export function createSseDecoder() {
  const inner = createSseEventDecoder();
  /** @param {SseEvent[]} events */
  const dataOf = (events) => events.map((e) => e.data);
  return {
    feed: (chunk) => dataOf(inner.feed(chunk)),
    end: () => dataOf(inner.end()),
  };
}

/**
 * Render one event as wire text: the optional `event:`, `id:` and
 * `retry:` lines, the data split on `\n` into one `data:` line each,
 * and the dispatching blank line. Throws `TypeError` for text the frame
 * cannot carry: a line terminator inside `event` or `id`, U+0000 inside
 * `id`, a bare carriage return inside `data` (a decoder would read it
 * as a line break and corrupt the framing), or a `retry` that is not a
 * non-negative integer.
 * @param {{ event?: string | null, id?: string | null, data: string, retry?: number | null }} fields
 * @returns {string}
 */
export function encodeSseEvent(fields) {
  if (fields === null || typeof fields !== 'object' || typeof fields.data !== 'string') {
    throw new TypeError('encodeSseEvent: the argument must be { event?, id?, data, retry? } with a string data');
  }
  let out = '';
  const event = fields.event;
  if (event !== undefined && event !== null) {
    if (typeof event !== 'string' || /[\r\n]/.test(event)) {
      throw new TypeError('encodeSseEvent: event must be a single-line string');
    }
    out += 'event: ' + event + '\n';
  }
  const id = fields.id;
  if (id !== undefined && id !== null) {
    if (typeof id !== 'string' || /[\r\n\0]/.test(id)) {
      throw new TypeError('encodeSseEvent: id must be a single-line string without U+0000');
    }
    out += 'id: ' + id + '\n';
  }
  const retry = fields.retry;
  if (retry !== undefined && retry !== null) {
    if (!Number.isInteger(retry) || retry < 0) {
      throw new TypeError('encodeSseEvent: retry must be a non-negative integer');
    }
    out += 'retry: ' + retry + '\n';
  }
  const lines = fields.data.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('\r') !== -1) {
      throw new TypeError('encodeSseEvent: data must not contain a bare carriage return — a decoder reads it as a line break');
    }
    out += 'data: ' + lines[i] + '\n';
  }
  return out + '\n';
}
