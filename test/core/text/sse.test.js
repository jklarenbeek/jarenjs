//@ts-check
/**
 * @file The SSE codec: the event decoder against the WHATWG dispatch
 * rules (field parsing, comments, last-event-id persistence, retry,
 * CR/LF/CRLF), the split-anywhere property (the same stream cut at
 * every byte offset yields identical events), the data-only view, and
 * the encoder round trip with its framing refusals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createSseEventDecoder, createSseDecoder, encodeSseEvent } from '@jarenjs/core/text/sse';

/** Decode a whole stream in one feed plus the end() flush. @param {string} text */
function decodeAll(text) {
  const decoder = createSseEventDecoder();
  return [...decoder.feed(text), ...decoder.end()];
}

describe('core/text/sse — the event decoder', () => {
  it('dispatches an event on the blank line with type, id, data and retry', () => {
    const events = decodeAll('event: patch\nid: 7\nretry: 250\ndata: {"a":1}\ndata: more\n\n');
    assert.deepStrictEqual(events, [{ event: 'patch', id: '7', data: '{"a":1}\nmore', retry: 250 }]);
  });

  it('a block without data dispatches nothing, and its event type does not leak', () => {
    const events = decodeAll('event: gone\n\ndata: x\n\n');
    assert.deepStrictEqual(events, [{ event: null, id: null, data: 'x', retry: null }]);
  });

  it('the last-event-id persists across events; an id with U+0000 is ignored', () => {
    const events = decodeAll('id: 3\ndata: a\n\ndata: b\n\nid: bad\0\ndata: c\n\n');
    assert.deepStrictEqual(events.map((e) => e.id), ['3', '3', '3']);
  });

  it('comment lines are ignored; a field line without a colon carries an empty value', () => {
    const events = decodeAll(': keep-alive\ndata\ndata: x\n\n');
    assert.deepStrictEqual(events, [{ event: null, id: null, data: '\nx', retry: null }]);
  });

  it('a retry that is not ASCII digits is ignored; retry resets after dispatch', () => {
    const events = decodeAll('retry: 5s\ndata: a\n\nretry: 10\ndata: b\n\ndata: c\n\n');
    assert.deepStrictEqual(events.map((e) => e.retry), [null, 10, null]);
  });

  it('handles CR, LF and CRLF line endings alike', () => {
    for (const nl of ['\n', '\r', '\r\n']) {
      const events = decodeAll(`event: e${nl}data: one${nl}${nl}data: two${nl}${nl}`);
      assert.deepStrictEqual(events.map((e) => [e.event, e.data]), [['e', 'one'], [null, 'two']], JSON.stringify(nl));
    }
  });

  it('end() flushes a final event that never got its blank line, idempotently', () => {
    const decoder = createSseEventDecoder();
    assert.deepStrictEqual(decoder.feed('event: end\ndata: tail'), []);
    assert.deepStrictEqual(decoder.end(), [{ event: 'end', id: null, data: 'tail', retry: null }]);
    assert.deepStrictEqual(decoder.end(), []);
  });

  it('the split-anywhere property: every cut offset of a 3-event fixture yields identical events', () => {
    const stream = 'event: snapshot\r\nid: 0\r\ndata: {"value":{"rows":[]}}\r\n\r\n'
      + ': heartbeat\n'
      + 'id: 4\nevent: patch\ndata: {"patch":[],\ndata: "seq":4}\n\n'
      + 'retry: 1500\revent: end\rid: 9\rdata: {"reason":"closed"}\r\r';
    const expected = decodeAll(stream);
    assert.strictEqual(expected.length, 3);
    for (let cut = 0; cut <= stream.length; cut++) {
      const decoder = createSseEventDecoder();
      const events = [
        ...decoder.feed(stream.slice(0, cut)),
        ...decoder.feed(stream.slice(cut)),
        ...decoder.end(),
      ];
      assert.deepStrictEqual(events, expected, `cut at ${cut}`);
    }
  });
});

/**
 * The decoder as it was when every feed rescanned the held tail: the
 * oracle the chunk-linear decoder must match event for event, feed for
 * feed. Kept verbatim (state in its own closure).
 */
function oracleDecoder() {
  let tail = '';
  /** @type {string[]} */
  let data = [];
  /** @type {string | null} */
  let eventType = null;
  /** @type {string | null} */
  let lastId = null;
  /** @type {number | null} */
  let retry = null;
  /** @param {string} line @param {any[]} out */
  function consumeLine(line, out) {
    if (line === '') {
      if (data.length > 0) {
        out.push({ event: eventType, id: lastId, data: data.join('\n'), retry });
        data = [];
        retry = null;
      }
      eventType = null;
      return;
    }
    if (line.charCodeAt(0) === 0x3A) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(line.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1);
    switch (name) {
      case 'data': data.push(value); break;
      case 'event': eventType = value; break;
      case 'id': if (value.indexOf('\0') === -1) lastId = value; break;
      case 'retry': if (value.length > 0 && /^[0-9]+$/.test(value)) retry = Number.parseInt(value, 10); break;
    }
  }
  return {
    /** @param {string} chunk */
    feed(chunk) {
      /** @type {any[]} */
      const out = [];
      const text = tail + chunk;
      const length = text.length;
      const limit = length > 0 && text.charCodeAt(length - 1) === 0x0D ? length - 1 : length;
      let start = 0;
      let i = 0;
      while (i < limit) {
        const c = text.charCodeAt(i);
        if (c === 0x0A) { consumeLine(text.slice(start, i), out); i += 1; start = i; }
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
      /** @type {any[]} */
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

/** A seeded generator (mulberry32), so a failing case can be replayed. @param {number} seed */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('core/text/sse — chunked feeding', () => {
  it('matches the rescanning decoder feed for feed over random streams and random chunkings', () => {
    const random = seeded(20261007);
    const pick = (/** @type {string[]} */ items) => items[Math.floor(random() * items.length)];
    const text = () => {
      let s = '';
      const n = Math.floor(random() * 6);
      for (let k = 0; k < n; k++) s += pick(['a', 'b', ' ', ':', 'é', '😀', '1', '\0', 'x y']);
      return s;
    };
    const ending = () => pick(['\n', '\r', '\r\n']);
    for (let round = 0; round < 400; round++) {
      let stream = random() < 0.2 ? '﻿' : '';
      const lines = 1 + Math.floor(random() * 12);
      for (let k = 0; k < lines; k++) {
        const kind = random();
        if (kind < 0.35) stream += 'data:' + pick(['', ' ']) + text();
        else if (kind < 0.45) stream += 'event: ' + text();
        else if (kind < 0.55) stream += 'id: ' + text();
        else if (kind < 0.62) stream += 'retry: ' + pick(['1500', '0', '12a', '', ' 7']);
        else if (kind < 0.7) stream += ':' + text();
        else if (kind < 0.75) stream += 'other' + text();
        stream += ending();
      }
      if (random() < 0.3) stream += 'data: unterminated';
      // cut at random offsets; a cut between CR and LF, and empty chunks, included
      const chunks = [];
      let at = 0;
      while (at < stream.length) {
        const size = random() < 0.1 ? 0 : 1 + Math.floor(random() * 7);
        chunks.push(stream.slice(at, at + size));
        at += size;
      }
      const oracle = oracleDecoder();
      const decoder = createSseEventDecoder();
      for (let k = 0; k < chunks.length; k++) {
        assert.deepStrictEqual(decoder.feed(chunks[k]), oracle.feed(chunks[k]),
          `round ${round}, chunk ${k} of ${JSON.stringify(chunks)}`);
      }
      assert.deepStrictEqual(decoder.end(), oracle.end(), `round ${round}, end of ${JSON.stringify(stream)}`);
    }
  });

  it('holds a CR across feeds exactly as the rescanning decoder does', () => {
    for (const chunks of [['data: a\r', '\ndata: b\n\n'], ['data: a\n\r', '', '\n'], ['data: a\n\r', '\r'],
      ['data: a\r', '\r', '\r'], ['data: a\n\r'], ['\r', '\n', '\r\n']]) {
      const oracle = oracleDecoder();
      const decoder = createSseEventDecoder();
      for (const chunk of chunks) assert.deepStrictEqual(decoder.feed(chunk), oracle.feed(chunk), JSON.stringify(chunks));
      assert.deepStrictEqual(decoder.end(), oracle.end(), JSON.stringify(chunks));
    }
  });

  it('decodes a long line fed in small chunks in time linear in its bytes', () => {
    // relative, not absolute: a 1 MB data line in 1 KB chunks against the
    // same line in one feed, best of three each (the rescanning decoder
    // was ~500x slower chunked, quadratic in the line)
    const chunk = 'x'.repeat(1024);
    const line = 'x'.repeat(1024 * 1024);
    const best = (/** @type {() => void} */ run) => {
      let min = Infinity;
      for (let k = 0; k < 3; k++) {
        const start = performance.now();
        run();
        min = Math.min(min, performance.now() - start);
      }
      return min;
    };
    const whole = best(() => {
      const events = createSseEventDecoder().feed('data: ' + line + '\n\n');
      assert.strictEqual(events[0].data.length, line.length);
    });
    const chunked = best(() => {
      const decoder = createSseEventDecoder();
      decoder.feed('data: ');
      for (let k = 0; k < 1024; k++) decoder.feed(chunk);
      const events = decoder.feed('\n\n');
      assert.strictEqual(events[0].data.length, line.length);
    });
    assert.ok(chunked < Math.max(whole, 1) * 25, `chunked ${chunked.toFixed(1)} ms vs one feed ${whole.toFixed(1)} ms`);
  });
});

describe('core/text/sse — the data-only view', () => {
  it('yields the data payloads in order and ignores every other field', () => {
    const decoder = createSseDecoder();
    assert.deepStrictEqual(
      decoder.feed(': hi\nevent: message\ndata: {"a":1}\n\nid: 7\ndata: [DONE]\n\n'),
      ['{"a":1}', '[DONE]']);
    assert.deepStrictEqual(decoder.feed('data: tail'), []);
    assert.deepStrictEqual(decoder.end(), ['tail']);
  });
});

describe('core/text/sse — the encoder', () => {
  it('renders the fields, splits multi-line data, and round-trips through the decoder', () => {
    const text = encodeSseEvent({ event: 'patch', id: '12', data: 'a\nb', retry: 100 });
    assert.strictEqual(text, 'event: patch\nid: 12\nretry: 100\ndata: a\ndata: b\n\n');
    assert.deepStrictEqual(decodeAll(text), [{ event: 'patch', id: '12', data: 'a\nb', retry: 100 }]);
    assert.strictEqual(encodeSseEvent({ data: 'x' }), 'data: x\n\n');
  });

  it('refuses text the frame cannot carry', () => {
    assert.throws(() => encodeSseEvent({ data: 'a\rb' }), TypeError);
    assert.throws(() => encodeSseEvent({ event: 'two\nlines', data: 'x' }), TypeError);
    assert.throws(() => encodeSseEvent({ id: 'a\0b', data: 'x' }), TypeError);
    assert.throws(() => encodeSseEvent({ retry: -1, data: 'x' }), TypeError);
    assert.throws(() => encodeSseEvent(/** @type {any} */ ({})), TypeError);
  });
});
