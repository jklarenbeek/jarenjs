//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { jsonBytes, jsonStringBytes, decodeCountedJson } from '../../packages/db/src/json-bytes.js';

describe('decoded JSON byte accounting', () => {
  it('matches the native serializer for every UTF-16 code unit, paired and unpaired', () => {
    for (let code = 0; code <= 0xffff; code++) {
      for (const value of [String.fromCharCode(code), `x${String.fromCharCode(code)}😀\ud800\udc00\udfff`])
        assert.equal(jsonStringBytes(value), Buffer.byteLength(JSON.stringify(value)), `code unit ${code}`);
    }
  });
  it('agrees for nested arrays, objects, numeric keys, escaping, numbers and null', () => {
    const corpus = [null, true, false, 0, -0, 1e21, 1e-7, Number.MAX_VALUE, NaN, Infinity,
      [], {}, { '2': '\u0000', '1': '\ud800', text: 'é😀', nested: [{ '\t"\\': [-7.1, null, false] }] },
      JSON.parse('{"__proto__":{"text":"abc"},"constructor":123}')];
    for (const value of corpus) {
      const text = JSON.stringify(value);
      const sizes = new WeakMap();
      const decoded = decodeCountedJson(text, sizes);
      assert.equal(jsonBytes(value), Buffer.byteLength(text));
      assert.equal(jsonBytes(decoded, sizes), Buffer.byteLength(text));
      assert.deepEqual(decoded, JSON.parse(text));
    }
  });
  it('remembers the encoded size before graph reconstruction mutates a child document', () => {
    const sizes = new WeakMap();
    const value = decodeCountedJson('{"child":{"__doc":{"text":"a"},"id":1}}', sizes);
    const bytes = Buffer.byteLength(JSON.stringify(value.child));
    value.child.__doc.id = 1;
    assert.equal(jsonBytes(value.child, sizes), bytes);
  });
});
