//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSseDecoder } from '@jarenjs/ai';

describe('ai — the SSE decoder', function () {
  it('decodes complete events and ignores non-data fields', function () {
    const decoder = createSseDecoder();
    const events = decoder.feed(
      ': keep-alive\n'
      + 'event: message\n'
      + 'data: {"a":1}\n'
      + '\n'
      + 'id: 7\n'
      + 'data: [DONE]\n'
      + '\n');
    assert.deepStrictEqual(events, ['{"a":1}', '[DONE]']);
  });

  it('reassembles events split at arbitrary chunk boundaries', function () {
    const decoder = createSseDecoder();
    const whole = 'data: {"delta":"hel';
    assert.deepStrictEqual(decoder.feed(whole), []);
    assert.deepStrictEqual(decoder.feed('lo"}\n\nda'), ['{"delta":"hello"}']);
    assert.deepStrictEqual(decoder.feed('ta: {"delta":"!"}\n'), []);
    assert.deepStrictEqual(decoder.feed('\n'), ['{"delta":"!"}']);
  });

  it('handles CRLF line endings and the optional space after data:', function () {
    const decoder = createSseDecoder();
    assert.deepStrictEqual(decoder.feed('data:{"x":1}\r\n\r\ndata: y\r\n\r\n'),
      ['{"x":1}', 'y']);
  });

  it('joins multi-line data with newlines per the specification', function () {
    const decoder = createSseDecoder();
    assert.deepStrictEqual(decoder.feed('data: line one\ndata: line two\n\n'),
      ['line one\nline two']);
  });

  it('end() flushes a final event that never got its blank line', function () {
    const decoder = createSseDecoder();
    assert.deepStrictEqual(decoder.feed('data: {"tail":true}'), []);
    assert.deepStrictEqual(decoder.end(), ['{"tail":true}']);
    assert.deepStrictEqual(decoder.end(), [], 'end is idempotent');
  });
});
