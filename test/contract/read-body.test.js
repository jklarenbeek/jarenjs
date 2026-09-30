//@ts-check
/**
 * @file `readBody` — the one helper an opaque handler reads its body with
 * (docs/CONTRACT-FORMAT.md §4.5): every `ctx.body` shape (a string, bytes,
 * the counting source of a streamed upload, `null`), as bytes or strictly
 * decoded text with the BOM stripped. Through the dispatcher, invalid
 * UTF-8 answers 400 `JC2016` and a body over the operation's limit answers
 * 413 `JC2003` — for a string body, a bytes body and a streamed body alike
 * — never the handler's 500.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, CONTRACT_CODES, contractCatalogEn } from '@jarenjs/contract';
import { serveHttp, readBody, BodyEncodingError, BodyLimitError, HTTP_ERRORS } from '@jarenjs/contract/http';
import { req, json } from './helpers.js';

const BOM = [0xEF, 0xBB, 0xBF];
const INVALID = [0x61, 0xC3, 0x28]; // 'a', then a lead byte with no continuation

/**
 * A pull source over the given chunks, counting pulls and cancels.
 * @param {number[][]} chunks
 */
function chunked(chunks) {
  const counts = { next: 0, returned: 0 };
  let i = 0;
  /** @type {AsyncIterable<Uint8Array>} */
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          counts.next += 1;
          if (i === chunks.length) return { done: true, value: undefined };
          return { done: false, value: new Uint8Array(chunks[i++]) };
        },
        async return() {
          counts.returned += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { source, counts };
}

describe('readBody — the shapes of ctx.body', () => {
  it('null is empty; a string is the text (BOM stripped) or its UTF-8 bytes; bytes are returned as given', async () => {
    assert.deepStrictEqual(await readBody(null), new Uint8Array(0));
    assert.strictEqual(await readBody(null, { as: 'text' }), '');
    assert.strictEqual(await readBody(undefined, { as: 'text' }), '');
    assert.strictEqual(await readBody('héllo', { as: 'text' }), 'héllo');
    assert.strictEqual(await readBody('﻿héllo', { as: 'text' }), 'héllo');
    assert.deepStrictEqual(await readBody('é'), new Uint8Array([0xC3, 0xA9]));
    const bytes = new Uint8Array([0x68, 0x69]);
    assert.strictEqual(await readBody(bytes), bytes, 'bytes are not copied');
    assert.strictEqual(await readBody(bytes, { as: 'text' }), 'hi');
    assert.strictEqual(await readBody(new Uint8Array([...BOM, 0x68, 0x69]), { as: 'text' }), 'hi');
  });

  it('a streamed source is read whole, in order; text decodes across a split code point', async () => {
    const { source, counts } = chunked([[0x68, 0xC3], [0xA9], [0x21]]);
    assert.strictEqual(await readBody(source, { as: 'text' }), 'hé!');
    assert.strictEqual(counts.next, 4);
    const again = chunked([[1, 2], [3]]);
    assert.deepStrictEqual(await readBody(again.source), new Uint8Array([1, 2, 3]));
  });

  it('invalid UTF-8 throws BodyEncodingError (its cause the decoder\'s), for bytes and a stream; as bytes it is not decoded at all', async () => {
    for (const body of [new Uint8Array(INVALID), chunked([INVALID.slice(0, 2), INVALID.slice(2)]).source]) {
      await assert.rejects(readBody(body, { as: 'text' }), (/** @type {any} */ err) => {
        assert.ok(err instanceof BodyEncodingError);
        assert.ok(err instanceof Error);
        assert.strictEqual(err.name, 'BodyEncodingError');
        assert.ok(err.cause instanceof TypeError, 'the fatal decoder\'s own error');
        return true;
      });
    }
    assert.deepStrictEqual(await readBody(new Uint8Array(INVALID)), new Uint8Array(INVALID));
  });

  it('a source that throws rethrows its error as is — a BodyLimitError included, so the binding still answers 413', async () => {
    const limit = new BodyLimitError(8);
    /** @param {unknown} error @returns {AsyncIterable<Uint8Array>} */
    const failing = (error) => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw error;
          },
        };
      },
    });
    await assert.rejects(readBody(failing(limit)), (err) => err === limit);
    const boom = new Error('socket reset');
    await assert.rejects(readBody(failing(boom), { as: 'text' }), (err) => err === boom);
  });

  it('an aborted signal rejects with its reason and cancels the source', async () => {
    const controller = new AbortController();
    const why = new Error('client gone');
    controller.abort(why);
    const { source, counts } = chunked([[1], [2]]);
    await assert.rejects(readBody(source, { signal: controller.signal }), (err) => err === why);
    assert.strictEqual(counts.returned, 1);
  });

  it('options are closed: as is bytes or text; an unknown member, a non-object or a foreign body is a TypeError', async () => {
    await assert.rejects(readBody('x', /** @type {any} */ ({ as: 'json' })), TypeError);
    await assert.rejects(readBody('x', /** @type {any} */ ({ limit: 4 })), /no member 'limit'/);
    await assert.rejects(readBody('x', /** @type {any} */ (null)), TypeError);
    await assert.rejects(readBody(/** @type {any} */ (5)), TypeError);
    await assert.rejects(readBody(/** @type {any} */ ({ length: 1 })), TypeError);
  });
});

describe('readBody — through the dispatcher', () => {
  const contract = compileContract({ $contract: '0.1', operations: {
    'note.put': { kind: 'command', output: true,
      http: { method: 'PUT', path: '/notes', media: 'text/plain' }, policy: { limits: { maxBodyBytes: 8 } } },
  } });
  /** @type {unknown[]} */
  const seen = [];
  const server = serveHttp(contract, {
    'note.put': async (input, ctx) => {
      const text = await readBody(/** @type {any} */ (ctx).body, { as: 'text', signal: ctx.signal });
      return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `[${text}]` };
    },
  }, { onError: (err) => { seen.push(err); } });
  /** @param {any} body */
  const put = (body) => server.dispatch(req('PUT', '/notes', { 'content-type': 'text/plain' }, body));

  it('valid text answers the handler\'s 200 — a string, bytes (BOM stripped) and a stream', async () => {
    for (const body of ['ab', new Uint8Array([...BOM, 0x61, 0x62]), chunked([[0x61], [0x62]]).source]) {
      const r = await put(body);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body, '[ab]');
    }
  });

  it('invalid UTF-8 answers 400 JC2016 (contract/malformed-body), not the handler\'s 500, and is not observed as a fault', async () => {
    seen.length = 0;
    for (const body of [new Uint8Array(INVALID), chunked([INVALID]).source]) {
      const r = await put(body);
      assert.strictEqual(r.status, 400);
      const payload = json(r);
      assert.strictEqual(payload.code, 'JC2016');
      assert.strictEqual(payload.message, 'the request body of operation note.put is not valid UTF-8 text');
      assert.strictEqual(payload.retryable, false);
    }
    assert.deepStrictEqual(seen, [], 'a malformed request is the client\'s, never the host\'s fault');
  });

  it('a body over maxBodyBytes answers 413 JC2003 — a string and bytes before the handler, a stream when the read crosses it', async () => {
    const over = 'abcdefghij';
    for (const body of [over, new TextEncoder().encode(over), chunked([[0x61, 0x62, 0x63, 0x64], [0x65, 0x66, 0x67, 0x68], [0x69, 0x6A]]).source]) {
      const r = await put(body);
      assert.strictEqual(r.status, 413);
      assert.strictEqual(json(r).code, 'JC2003');
    }
  });

  it('JC2016 is a registered code: CONTRACT_CODES, the HTTP table and the English catalog', () => {
    assert.ok(Object.hasOwn(CONTRACT_CODES, 'JC2016'));
    assert.deepStrictEqual({ ...HTTP_ERRORS.JC2016 }, { status: 400, msgid: 'contract/malformed-body', retryable: false });
    assert.ok(Object.hasOwn(contractCatalogEn, 'contract/malformed-body'));
  });
});
