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
