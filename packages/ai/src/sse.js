//@ts-check
/**
 * An incremental Server-Sent-Events decoder — the transport every
 * OpenAI-compatible streaming endpoint uses. Feed it network chunks in
 * any split (mid-line, mid-event, CRLF or LF); it yields the complete
 * `data:` payloads in order. Non-data fields (`event:`, `id:`,
 * `retry:`, `:` comments) are ignored, multi-line data joins with a
 * newline per the SSE specification.
 */

/**
 * @returns {{ feed: (chunk: string) => string[], end: () => string[] }}
 *   `feed` returns the data payloads completed by this chunk; `end`
 *   flushes a final event from a stream that never sent its closing
 *   blank line.
 */
export function createSseDecoder() {
  let tail = '';
  /** @type {string[]} */
  let data = [];

  /**
   * @param {string} line
   * @param {string[]} out
   */
  function consumeLine(line, out) {
    if (line === '') {
      if (data.length > 0) {
        out.push(data.join('\n'));
        data = [];
      }
      return;
    }
    if (line.startsWith('data:'))
      data.push(line.slice(line.charCodeAt(5) === 0x20 ? 6 : 5));
    // every other field and comment line is ignored by design
  }

  return {
    feed(chunk) {
      /** @type {string[]} */
      const out = [];
      const lines = (tail + chunk).split('\n');
      tail = lines.pop() ?? '';
      for (let line of lines) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        consumeLine(line, out);
      }
      return out;
    },
    end() {
      /** @type {string[]} */
      const out = [];
      if (tail !== '') {
        consumeLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail, out);
        tail = '';
      }
      if (data.length > 0) {
        out.push(data.join('\n'));
        data = [];
      }
      return out;
    },
  };
}
