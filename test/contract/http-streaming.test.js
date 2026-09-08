//@ts-check
/**
 * @file Opaque bytes end to end (docs/CONTRACT-FORMAT.md §4.5, §7.1, §9,
 * §10.6): the body helpers on their own (normalization, the bounded
 * JSON collector, the counting opaque source), direct dispatch with a
 * pull source in and a pull source out (a JSON body drained under its
 * limit, an upload pulled chunk by chunk, a limit crossing that
 * propagates as `JC2003`, an unread upload cancelled before a plain
 * response, a transform that keeps the upload alive, HEAD cancelling a
 * returned stream), the node adapter over a real socket (a streamed
 * upload and download, `drain` between chunks, a mid-upload crossing
 * answered through a closing 413, a peer that goes away mid-download),
 * the fetch adapter (a streamed `Request` in, a `ReadableStream` out
 * that pulls one chunk per read), `client.bytes()` (a live body on
 * success and never `text()`, every failure class, a streamed upload
 * with `duplex: 'half'`, no retry), and the fixed-heap probe: 100 MiB
 * up and down through both carriers in a child whose old space is a
 * fraction of the payload.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compileContract, ContractHostError } from '@jarenjs/contract';
import { serveHttp, BodyLimitError } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';
import { collectBytes, countingSource, normalizeBody } from '../../packages/contract/src/http/body.js';
import { req, json } from './helpers.js';

const LIMIT = 4096;
const CONTRACT = compileContract({
  $contract: '0.1',
  operations: {
    'blob.put': {
      kind: 'command',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      output: true,
      errors: { gone: { status: 410 } },
      policy: { limits: { maxBodyBytes: LIMIT } },
      http: { method: 'PUT', path: '/blobs/{id}', media: 'application/octet-stream' },
    },
    'blob.get': {
      kind: 'read',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      output: true,
      errors: { gone: { status: 410 } },
      policy: { retry: { max: 2, on: ['gone'] } },
      http: { method: 'GET', path: '/blobs/{id}', media: 'application/octet-stream' },
    },
    'note.put': {
      kind: 'command',
      input: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } },
      output: true,
      policy: { limits: { maxBodyBytes: 64 } },
      http: { method: 'PUT', path: '/notes/{id}', in: { text: 'body' } },
    },
  },
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A pull source over the given chunks that counts pulls and returns.
 * @param {Uint8Array[]} chunks
 * @param {{ throwAt?: number }} [shape] - throw instead of yielding chunk `throwAt`
 */
function chunkSource(chunks, shape = {}) {
  const counts = { pulled: 0, returned: 0 };
  const source = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (shape.throwAt === i) throw new Error('the source broke');
          if (i >= chunks.length) return { done: true, value: undefined };
          counts.pulled++;
          return { done: false, value: chunks[i++] };
        },
        async return(/** @type {unknown} */ value) {
          counts.returned++;
          return { done: true, value };
        },
      };
    },
  };
  return { counts, source };
}

/** @param {string} text @param {number} at - split the UTF-8 bytes at every `at` bytes */
function split(text, at) {
  const bytes = encoder.encode(text);
  /** @type {Uint8Array[]} */
  const out = [];
  for (let i = 0; i < bytes.length; i += at) out.push(bytes.slice(i, i + at));
  return out;
}

/** @param {AsyncIterable<Uint8Array>} source */
async function drain(source) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for await (const chunk of source) parts.push(chunk);
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** @param {Uint8Array[]} chunks */
function sha(chunks) {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest('hex');
}

/** @param {() => boolean} until */
async function wait(until) {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(until(), 'the condition never held');
}

describe('bytes — the body helpers', () => {
  it('normalizeBody: none is null, text and bytes and async iterables pass, a Web stream becomes an async iterable whose return() cancels it once, anything else is refused', async () => {
    assert.strictEqual(normalizeBody(undefined), null);
    assert.strictEqual(normalizeBody(null), null);
    assert.strictEqual(normalizeBody('x'), 'x');
    const bytes = new Uint8Array([1]);
    assert.strictEqual(normalizeBody(bytes), bytes);
    const { source } = chunkSource([]);
    assert.strictEqual(normalizeBody(source), source);
    let cancels = 0;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
      },
      cancel() { cancels++; },
    });
    const normalized = /** @type {AsyncIterable<Uint8Array>} */ (normalizeBody(stream));
    const iterator = normalized[Symbol.asyncIterator]();
    assert.deepStrictEqual((await iterator.next()).value, new Uint8Array([1, 2]));
    await iterator.return?.();
    await iterator.return?.();
    assert.strictEqual(cancels, 1, 'the stream was cancelled exactly once');
    const whole = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([9])); c.close(); } });
    assert.deepStrictEqual(await drain(/** @type {AsyncIterable<Uint8Array>} */ (normalizeBody(whole))), new Uint8Array([9]));
    for (const bad of [42, {}, [], () => {}]) assert.strictEqual(normalizeBody(bad), undefined, String(bad));
  });

  it('collectBytes: reassembles split UTF-8, holds the exact limit, refuses limit+1 with one return(), reports a broken source, an abort and a non-byte chunk', async () => {
    const { counts, source } = chunkSource(split('héllo wörld', 1));
    const ok = await collectBytes(source, LIMIT, null);
    assert.ok(ok.ok);
    if (ok.ok) assert.strictEqual(decoder.decode(ok.bytes), 'héllo wörld');
    assert.strictEqual(counts.returned, 0, 'a source read to EOF is not cancelled');

    const exact = await collectBytes(chunkSource([new Uint8Array(3), new Uint8Array(3)]).source, 6, null);
    assert.ok(exact.ok && exact.bytes.byteLength === 6);
    const over = chunkSource([new Uint8Array(3), new Uint8Array(4), new Uint8Array(1)]);
    const crossed = await collectBytes(over.source, 6, null);
    assert.deepStrictEqual(crossed, { ok: false, kind: 'limit' });
    assert.deepStrictEqual(over.counts, { pulled: 2, returned: 1 }, 'the crossing chunk stopped the read; the third was never pulled');

    const broken = chunkSource([new Uint8Array(1)], { throwAt: 1 });
    const failed = await collectBytes(broken.source, LIMIT, null);
    assert.strictEqual(failed.ok, false);
    if (!failed.ok) assert.strictEqual(failed.kind, 'error');
    assert.strictEqual(broken.counts.returned, 1);

    const controller = new AbortController();
    controller.abort();
    const aborted = chunkSource([new Uint8Array(1)]);
    assert.deepStrictEqual(await collectBytes(aborted.source, LIMIT, controller.signal), { ok: false, kind: 'aborted' });
    assert.deepStrictEqual(aborted.counts, { pulled: 0, returned: 1 });

    const strings = { [Symbol.asyncIterator]: async function* () { yield /** @type {any} */ ('text'); } };
    const wrong = await collectBytes(/** @type {any} */ (strings), LIMIT, null);
    assert.strictEqual(wrong.ok, false);
    if (!wrong.ok) assert.strictEqual(wrong.kind, 'error');

    const empty = await collectBytes(chunkSource([]).source, LIMIT, null);
    assert.ok(empty.ok && empty.bytes.byteLength === 0);
  });

  it('countingSource: yields up to the limit, throws BodyLimitError for the crossing chunk after one upstream return(), and cancels once on an early return', async () => {
    const over = chunkSource([new Uint8Array(4), new Uint8Array(4), new Uint8Array(1)]);
    const counting = countingSource(over.source, 6);
    const iterator = counting[Symbol.asyncIterator]();
    assert.strictEqual((await iterator.next()).value?.byteLength, 4);
    await assert.rejects(iterator.next(), (e) => e instanceof BodyLimitError && e.limit === 6);
    assert.deepStrictEqual(over.counts, { pulled: 2, returned: 1 });
    assert.deepStrictEqual(counting.state, { started: true, finished: true, cancelled: true, crossed: true, bytes: 8 });
    assert.deepStrictEqual(await iterator.next(), { done: true, value: undefined }, 'finished stays finished');
    await counting.cancel();
    assert.strictEqual(over.counts.returned, 1, 'cancel after the crossing is a no-op');

    const early = chunkSource([new Uint8Array(1), new Uint8Array(1)]);
    const source = countingSource(early.source, LIMIT);
    for await (const chunk of source) {
      assert.strictEqual(chunk.byteLength, 1);
      break;
    }
    assert.deepStrictEqual(early.counts, { pulled: 1, returned: 1 }, 'the consumer\'s break cancelled the upstream once');
    assert.strictEqual(source.state.cancelled, true);

    const whole = chunkSource([new Uint8Array(2), new Uint8Array(2)]);
    const read = countingSource(whole.source, 4);
    assert.strictEqual((await drain(read)).byteLength, 4, 'the exact limit passes');
    assert.deepStrictEqual(whole.counts, { pulled: 2, returned: 0 });
    assert.strictEqual(read.state.finished, true);
    assert.strictEqual(read.state.cancelled, false);
  });
});

describe('bytes — direct dispatch', () => {
  /** @type {unknown[]} */
  let observed = [];
  /** @param {Record<string, any>} handlers */
  function serve(handlers) {
    observed = [];
    return serveHttp(CONTRACT, {
      'blob.put': () => ({ status: 201 }),
      'blob.get': () => ({ status: 200, body: new Uint8Array([1]) }),
      'note.put': (input) => input.text,
      ...handlers,
    }, { trace: () => 't', onError: (err) => { observed.push(err); } });
  }
  const octet = { 'content-type': 'application/octet-stream' };

  it('an opaque upload reaches the handler as a pull source it consumes one chunk at a time', async () => {
    /** @type {number[]} */
    const seen = [];
    const server = serve({
      'blob.put': async (input, ctx) => {
        const h = createHash('sha256');
        for await (const chunk of ctx.body) {
          seen.push(chunk.byteLength);
          h.update(chunk);
        }
        return { status: 201, headers: { 'content-type': 'text/plain' }, body: h.digest('hex') };
      },
    });
    const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2), new Uint8Array(96).fill(3)];
    const { counts, source } = chunkSource(chunks);
    const response = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (source)));
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body, sha(chunks));
    assert.deepStrictEqual(seen, [1000, 1000, 96]);
    assert.deepStrictEqual(counts, { pulled: 3, returned: 0 });
  });

  it('a JSON operation drains a source under its limit: split UTF-8 parses, limit+1 is JC2003 with one return(), a broken source and invalid UTF-8 are JC2005, a media mismatch never pulls', async () => {
    const server = serve({});
    const body = JSON.stringify({ text: 'héllo wörld' });
    const ok = await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'application/json' }, /** @type {any} */ (chunkSource(split(body, 1)).source)));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(json(ok), 'héllo wörld');

    const exact = JSON.stringify({ text: 'x'.repeat(64 - '{"text":""}'.length) });
    assert.strictEqual(encoder.encode(exact).byteLength, 64);
    assert.strictEqual((await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'application/json' }, /** @type {any} */ (chunkSource(split(exact, 7)).source)))).status, 200);
    const over = chunkSource(split(JSON.stringify({ text: 'x'.repeat(54) }), 7));
    const refused = await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'application/json' }, /** @type {any} */ (over.source)));
    assert.strictEqual(refused.status, 413);
    assert.strictEqual(json(refused).code, 'JC2003');
    assert.strictEqual(over.counts.returned, 1);
    assert.ok(over.counts.pulled <= 10, 'the read stopped at the crossing');

    const broken = chunkSource(split(body, 4), { throwAt: 2 });
    const failed = await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'application/json' }, /** @type {any} */ (broken.source)));
    assert.strictEqual(failed.status, 400);
    assert.strictEqual(json(failed).code, 'JC2005');
    assert.strictEqual(broken.counts.returned, 1);

    const invalid = await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'application/json' }, /** @type {any} */ (chunkSource([new Uint8Array([0x7b, 0xff, 0x7d])]).source)));
    assert.strictEqual(json(invalid).code, 'JC2005');

    const wrongMedia = chunkSource(split(body, 4));
    const unsupported = await server.dispatch(req('PUT', '/notes/n1', { 'content-type': 'text/plain' }, /** @type {any} */ (wrongMedia.source)));
    assert.strictEqual(unsupported.status, 415);
    await wait(() => wrongMedia.counts.returned === 1);
    assert.strictEqual(wrongMedia.counts.pulled, 0, 'a refused media never pulls the body');

    // a body-less operation with a source ignores it: released, never read
    const ignored = chunkSource([new Uint8Array(1)]);
    const got = await server.dispatch(req('GET', '/blobs/z', {}, /** @type {any} */ (ignored.source)));
    assert.strictEqual(got.status, 200);
    await wait(() => ignored.counts.returned === 1);
    assert.strictEqual(ignored.counts.pulled, 0);
  });

  it('a limit crossing the handler lets propagate is JC2003, never a host fault; a handler that catches it decides for itself', async () => {
    let seenBytes = 0;
    const server = serve({
      'blob.put': async (input, ctx) => {
        for await (const chunk of ctx.body) seenBytes += chunk.byteLength;
        return { status: 201 };
      },
    });
    const over = chunkSource([new Uint8Array(LIMIT), new Uint8Array(1)]);
    const refused = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (over.source)));
    assert.strictEqual(refused.status, 413);
    assert.strictEqual(json(refused).code, 'JC2003');
    assert.strictEqual(seenBytes, LIMIT, 'not one byte past the limit reached the handler');
    assert.deepStrictEqual(over.counts, { pulled: 2, returned: 1 });
    assert.deepStrictEqual(observed, [], 'the crossing is the request\'s fault, not the host\'s');

    const catching = serve({
      'blob.put': async (input, ctx) => {
        let total = 0;
        try {
          for await (const chunk of ctx.body) total += chunk.byteLength;
        }
        catch (err) {
          if (!(err instanceof BodyLimitError)) throw err;
          return { status: 200, headers: { 'content-type': 'text/plain' }, body: `kept ${total}` };
        }
        return { status: 201 };
      },
    });
    const kept = await catching.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (chunkSource([new Uint8Array(LIMIT), new Uint8Array(1)]).source)));
    assert.strictEqual(kept.status, 200);
    assert.strictEqual(kept.body, `kept ${LIMIT}`);
  });

  it('a plain response cancels an unread upload once before it is exposed', async () => {
    const server = serve({ 'blob.put': () => ({ status: 202 }) });
    const untouched = chunkSource([new Uint8Array(10)]);
    const response = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (untouched.source)));
    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(untouched.counts, { pulled: 0, returned: 1 }, 'cancelled before the response resolved');
    const partial = chunkSource([new Uint8Array(10), new Uint8Array(10)]);
    const half = serve({
      'blob.put': async (input, ctx) => {
        for await (const chunk of ctx.body) {
          void chunk;
          break;
        }
        return { status: 202 };
      },
    });
    await half.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (partial.source)));
    assert.deepStrictEqual(partial.counts, { pulled: 1, returned: 1 }, 'the consumer\'s break cancelled it; the response did not cancel it twice');
  });

  it('a streamed response keeps the upload alive for a transform and releases it once at EOF; a crossing met mid-transform cuts the body and is observed', async () => {
    const server = serve({
      'blob.put': (input, ctx) => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: (async function* () {
          for await (const chunk of ctx.body) yield chunk.map((b) => b + 1);
        })(),
      }),
    });
    const upload = chunkSource([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const response = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (upload.source)));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(upload.counts.pulled, 0, 'nothing was pulled before the consumer read the response');
    assert.deepStrictEqual(await drain(/** @type {AsyncIterable<Uint8Array>} */ (response.body)), new Uint8Array([2, 3, 4]));
    assert.deepStrictEqual(upload.counts, { pulled: 2, returned: 0 }, 'read to EOF: released without a cancel');

    const crossing = chunkSource([new Uint8Array(LIMIT), new Uint8Array(1)]);
    const cut = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (crossing.source)));
    assert.strictEqual(cut.status, 200, 'the status was decided before the body crossed');
    await assert.rejects(drain(/** @type {AsyncIterable<Uint8Array>} */ (cut.body)), (e) => e instanceof BodyLimitError);
    assert.strictEqual(observed.length, 1, 'the cut body was observed once');
    assert.ok(observed[0] instanceof BodyLimitError);
    assert.deepStrictEqual(crossing.counts, { pulled: 2, returned: 1 });

    // the consumer cancels the response early: the unread upload is cancelled once
    const abandoned = chunkSource([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    const early = await server.dispatch(req('PUT', '/blobs/a', octet, /** @type {any} */ (abandoned.source)));
    const iterator = /** @type {AsyncIterable<Uint8Array>} */ (early.body)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await iterator.return?.();
    assert.deepStrictEqual(abandoned.counts, { pulled: 1, returned: 1 });
  });

  it('HEAD on an opaque read cancels a returned stream instead of draining it; a Web stream body is normalized; a bad body value is JC1004', async () => {
    const returned = chunkSource([new Uint8Array(3), new Uint8Array(3)]);
    const server = serve({ 'blob.get': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: returned.source }) });
    const head = await server.dispatch(req('HEAD', '/blobs/a'));
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body, null);
    await wait(() => returned.counts.returned === 1);
    assert.strictEqual(returned.counts.pulled, 0, 'never pulled');

    const web = serve({
      'blob.get': () => ({ status: 200, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([7, 8])); c.enqueue(new Uint8Array([9])); c.close(); } }) }),
    });
    const got = await web.dispatch(req('GET', '/blobs/a'));
    assert.deepStrictEqual(await drain(/** @type {AsyncIterable<Uint8Array>} */ (got.body)), new Uint8Array([7, 8, 9]));

    for (const bad of [42, {}, [1]]) {
      await assert.rejects(server.dispatch(/** @type {any} */ ({ method: 'PUT', url: '/blobs/a', headers: octet, body: bad })),
        (e) => e instanceof ContractHostError && e.code === 'JC1004', String(bad));
    }
    const bogus = serve({ 'blob.get': () => ({ status: 200, body: 42 }) });
    const invalid = await bogus.dispatch(req('GET', '/blobs/a'));
    assert.strictEqual(json(invalid).code, 'JC2010');
  });
});

describe('bytes — the node adapter over a real socket', () => {
  /** @type {ReturnType<typeof serveHttp>} */
  let dispatcher;
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let origin;
  /** the download source of the last blob.get, with its counters */
  /** @type {ReturnType<typeof chunkSource> | null} */
  let lastDownload = null;
  /** @type {(() => void) | null} */
  let releaseDownload = null;

  before(async () => {
    dispatcher = serveHttp(CONTRACT, {
      'blob.put': async (input, ctx) => {
        const h = createHash('sha256');
        let n = 0;
        for await (const chunk of ctx.body) {
          h.update(chunk);
          n += chunk.byteLength;
        }
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: `${n}:${h.digest('hex')}` };
      },
      'blob.get': (input) => {
        const count = Number(input.id);
        const chunks = Array.from({ length: count }, (_, i) => new Uint8Array(1024).fill(i & 255));
        lastDownload = chunkSource(chunks);
        const source = lastDownload.source;
        if (releaseDownload === null) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: source };
        // a gated download: the second chunk waits for the test's release
        const gate = new Promise((resolve) => { releaseDownload = () => resolve(undefined); });
        return {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: (async function* () {
            let i = 0;
            for await (const chunk of source) {
              if (i++ === 1) await gate;
              yield chunk;
            }
          })(),
        };
      },
      'note.put': (input) => input.text,
    }, { trace: () => 't' });
    server = http.createServer(toNodeHandler(dispatcher));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });

  it('a streamed upload is hashed chunk by chunk on the server, and a streamed download arrives chunked with the same hash', async () => {
    const chunks = Array.from({ length: 4 }, (_, i) => new Uint8Array(1000).fill(i + 1));
    let i = 0;
    const upload = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });
    const put = await fetch(`${origin}/blobs/a`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: upload, duplex: 'half' });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(await put.text(), `4000:${sha(chunks)}`);

    const get = await fetch(`${origin}/blobs/8`);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(get.headers.get('content-length'), null, 'a streamed body is chunked');
    assert.strictEqual(get.headers.get('transfer-encoding'), 'chunked');
    const got = new Uint8Array(await get.arrayBuffer());
    assert.strictEqual(got.byteLength, 8 * 1024);
    assert.strictEqual(sha([got]), sha(Array.from({ length: 8 }, (_, k) => new Uint8Array(1024).fill(k & 255))));
    assert.deepStrictEqual(lastDownload?.counts, { pulled: 8, returned: 0 });
  });

  it('a chunked upload that crosses the limit is answered 413 through a closing connection, and the handler saw nothing past the limit', async () => {
    const request = http.request(`${origin}/blobs/big`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    /** @type {unknown[]} */
    const errors = [];
    request.on('error', (err) => { errors.push(err); });
    const settled = new Promise((resolve) => {
      request.on('response', (incoming) => resolve({ res: incoming }));
      request.on('error', (err) => resolve({ err }));
      request.on('close', () => resolve({ closed: true }));
    });
    request.write(Buffer.alloc(LIMIT, 1));
    request.write(Buffer.alloc(16, 2));
    request.end();
    const outcome = /** @type {any} */ (await settled);
    if (outcome.res !== undefined) {
      assert.strictEqual(outcome.res.statusCode, 413);
      assert.strictEqual(outcome.res.headers.connection, 'close');
      let text = '';
      for await (const c of outcome.res) text += c;
      assert.strictEqual(JSON.parse(text).code, 'JC2003');
    }
    else {
      const code = /** @type {any} */ (outcome.err ?? errors[0])?.code ?? 'close without a response';
      assert.match(String(code), /^(ECONNRESET|ECANCELED|EPIPE|ECONNABORTED)$/);
    }
    request.destroy();
  });

  it('the pump waits for drain: on a full response no second chunk is pulled before drain, and a close cancels the source once', async () => {
    /** A response whose write always answers false. */
    class Full extends EventEmitter {
      constructor() {
        super();
        /** @type {(string | Uint8Array)[]} */
        this.chunks = [];
        this.ended = 0;
        this.destroyed = false;
        this.writableEnded = false;
        this.writableFinished = false;
      }

      writeHead() {}

      /** @param {Uint8Array} chunk */
      write(chunk) {
        this.chunks.push(chunk);
        return false;
      }

      end() {
        this.ended++;
        this.writableEnded = true;
        this.writableFinished = true;
      }

      destroy() {
        this.destroyed = true;
      }
    }
    const handler = toNodeHandler(dispatcher);
    const res = new Full();
    handler(/** @type {any} */ ({ method: 'GET', url: '/blobs/3', headers: {}, on: () => {} }), /** @type {any} */ (res));
    await wait(() => res.chunks.length === 1);
    assert.strictEqual(lastDownload?.counts.pulled, 1, 'one chunk pulled, written, and parked');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lastDownload?.counts.pulled, 1, 'no second pull while the socket is full');
    res.emit('drain');
    await wait(() => res.chunks.length === 2);
    assert.strictEqual(lastDownload?.counts.pulled, 2);
    res.emit('drain');
    await wait(() => res.chunks.length === 3);
    res.emit('drain');
    await wait(() => res.ended === 1);
    assert.deepStrictEqual(lastDownload?.counts, { pulled: 3, returned: 0 });

    const gone = new Full();
    handler(/** @type {any} */ ({ method: 'GET', url: '/blobs/3', headers: {}, on: () => {} }), /** @type {any} */ (gone));
    await wait(() => gone.chunks.length === 1);
    gone.emit('close');
    await wait(() => lastDownload?.counts.returned === 1);
    assert.deepStrictEqual(lastDownload?.counts, { pulled: 1, returned: 1 }, 'the peer went away: the source was cancelled once');
    assert.strictEqual(gone.ended, 0);
  });

  it('a peer that goes away mid-download cancels the source exactly once, at the next point the source can observe it', async (t) => {
    releaseDownload = () => {};
    t.after(() => {
      releaseDownload?.();
      releaseDownload = null;
    });
    const closed = new Promise((resolve) => {
      server.once('request', (_req, res) => res.once('close', resolve));
    });
    const controller = new AbortController();
    const get = await fetch(`${origin}/blobs/4`, { signal: controller.signal });
    const reader = /** @type {NonNullable<typeof get.body>} */ (get.body).getReader();
    await reader.read();
    assert.ok(lastDownload !== null);
    const download = /** @type {ReturnType<typeof chunkSource>} */ (lastDownload);
    await wait(() => download.counts.pulled === 2);
    controller.abort();
    // the handler's generator is parked on an await inside its body: a
    // cancel cannot interrupt that await, so nothing is released yet —
    // the cancel is queued for the generator's next step
    // Observe cancellation at the server before releasing the source;
    // client abort propagation has no fixed wall-clock deadline.
    await closed;
    assert.strictEqual(download.counts.returned, 0);
    /** @type {() => void} */ (releaseDownload)();
    await wait(() => download.counts.returned === 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(download.counts, { pulled: 2, returned: 1 }, 'released once; the chunk it was about to yield was never pulled past');
    releaseDownload = null;
  });
});

describe('bytes — the fetch adapter', () => {
  const dispatcher = serveHttp(CONTRACT, {
    'blob.put': async (input, ctx) => {
      const h = createHash('sha256');
      for await (const chunk of ctx.body) h.update(chunk);
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: h.digest('hex') };
    },
    'blob.get': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: download.source }),
    'note.put': (input) => input.text,
  }, { trace: () => 't' });
  const handler = toFetchHandler(dispatcher);
  let download = chunkSource([]);

  it('a streamed Request body reaches the handler chunk by chunk; the Response body pulls one chunk per read and cancel() returns the source once', async () => {
    const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(1000).fill(2)];
    let i = 0;
    const body = new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
    const put = await handler(new Request('http://contract.local/blobs/a', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body, duplex: 'half' }));
    assert.strictEqual(put.status, 200);
    assert.strictEqual(await put.text(), sha(chunks));

    download = chunkSource(Array.from({ length: 5 }, (_, k) => new Uint8Array(3).fill(k)));
    const get = await handler(new Request('http://contract.local/blobs/x'));
    assert.strictEqual(get.status, 200);
    assert.strictEqual(download.counts.pulled, 0, 'nothing pulled before a read');
    const reader = /** @type {NonNullable<typeof get.body>} */ (get.body).getReader();
    const first = await reader.read();
    assert.deepStrictEqual(first.value, new Uint8Array([0, 0, 0]));
    assert.strictEqual(download.counts.pulled, 1, 'one read, one pull');
    await reader.read();
    assert.strictEqual(download.counts.pulled, 2);
    await reader.cancel();
    await reader.cancel();
    assert.deepStrictEqual(download.counts, { pulled: 2, returned: 1 });

    // a JSON body over the fetch adapter is drained under its limit, invalid UTF-8 refused strictly
    const invalid = await handler(new Request('http://contract.local/notes/n', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }));
    assert.strictEqual(invalid.status, 400);
    assert.strictEqual((await invalid.json()).code, 'JC2005');
    const over = await handler(new Request('http://contract.local/notes/n', { method: 'PUT', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, body: new ReadableStream({ start(c) { c.enqueue(encoder.encode(JSON.stringify({ text: 'x'.repeat(100) }))); c.close(); } }), duplex: 'half' }));
    assert.strictEqual(over.status, 413);
  });
});

describe('bytes — client.bytes()', () => {
  /** @param {Record<string, any>} [handlers] */
  function pair(handlers = {}) {
    const server = serveHttp(CONTRACT, {
      'blob.put': async (input, ctx) => {
        const h = createHash('sha256');
        let n = 0;
        for await (const chunk of ctx.body) {
          h.update(chunk);
          n += chunk.byteLength;
        }
        return { status: 200, headers: { 'content-type': 'text/plain', etag: '"b1"' }, body: `${n}:${h.digest('hex')}` };
      },
      'blob.get': (input) => (input.id === 'gone' ? ContractFailureGone() : {
        status: 200, headers: { 'content-type': 'image/png', 'x-extra': 'yes', etag: '"g1"' },
        body: (async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); })(),
      }),
      'note.put': (input) => input.text,
      ...handlers,
    }, { trace: () => 'trace-b' });
    const handler = toFetchHandler(server);
    /** @type {{ url: string, init: any }[]} */
    const sent = [];
    const client = openHttpClient(CONTRACT, {
      baseUrl: 'http://shop.test',
      fetch: async (url, init) => { sent.push({ url, init }); return handler(new Request(url, init)); },
    });
    return { client, sent };
  }
  /** @type {any} */
  let failFactory = null;
  function ContractFailureGone() {
    return failFactory('gone', {}, { at: 1 });
  }

  it('a 2xx exposes status, lowercase headers, media and the LIVE body without calling text(); meta carries trace and etag', async () => {
    const { client, sent } = pair({ 'blob.get': (input, ctx) => { failFactory = ctx.fail; return { status: 200, headers: { 'Content-Type': 'image/png', 'X-Extra': 'yes', etag: '"g1"' }, body: (async function* () { yield new Uint8Array([1, 2]); yield new Uint8Array([3]); })() }; } });
    const outcome = await client.bytes('blob.get', { id: 'a' }, { attempt: 7 });
    assert.strictEqual(outcome.ok, true);
    if (!outcome.ok) return;
    const value = /** @type {any} */ (outcome.value);
    assert.strictEqual(value.status, 200);
    assert.strictEqual(value.headers['content-type'], 'image/png');
    assert.strictEqual(value.headers['x-extra'], 'yes');
    assert.strictEqual(value.media, 'image/png');
    assert.ok(value.body instanceof ReadableStream);
    assert.deepStrictEqual(await drain(/** @type {any} */ (normalizeBody(value.body))), new Uint8Array([1, 2, 3]));
    assert.deepStrictEqual(outcome.meta, { op: 'blob.get', attempt: 7, trace: 'trace-b', revision: null, etag: '"g1"', notModified: false });
    assert.strictEqual(sent[0].init.method, 'GET');
    assert.strictEqual(sent[0].init.body, undefined);

    // a fake response proves text() is never touched on success
    let textCalls = 0;
    const spying = openHttpClient(CONTRACT, {
      fetch: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([9])); c.close(); } }),
        text: async () => { textCalls++; return ''; },
      }),
    });
    const spied = await spying.bytes('blob.get', { id: 'a' });
    assert.strictEqual(spied.ok, true);
    assert.strictEqual(textCalls, 0);
  });

  it('a declared failure, an undeclared response, a JSON operation, invalid input, a transport failure without retry, and an abort each classify as invoke does', async () => {
    const { client, sent } = pair({ 'blob.get': (input, ctx) => ctx.fail('gone', {}, { at: 1 }) });
    const gone = await client.bytes('blob.get', { id: 'gone' });
    assert.strictEqual(gone.ok, false);
    if (gone.ok) return;
    assert.strictEqual(gone.kind, 'failure');
    assert.deepStrictEqual(gone.error, { code: 'gone', message: 'operation blob.get failed with gone', status: 410, details: { at: 1 }, retryable: true }, 'retryable by the declared policy — and still not retried by bytes');
    assert.strictEqual(gone.meta.trace, 'trace-b');

    const html = openHttpClient(CONTRACT, { fetch: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
    const undeclared = await html.bytes('blob.get', { id: 'a' });
    assert.strictEqual(undeclared.ok, false);
    if (!undeclared.ok) {
      assert.strictEqual(undeclared.kind, 'contract');
      assert.strictEqual(undeclared.error.code, 'JC2055');
      assert.strictEqual(undeclared.error.retryable, true);
    }

    await assert.rejects(async () => client.bytes('note.put', { id: 'n', text: 'x' }), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1005');
    await assert.rejects(async () => client.bytes('nope', {}), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1005');
    const invalid = await client.bytes('blob.get', { id: 5 });
    assert.strictEqual(invalid.ok, false);
    if (!invalid.ok) assert.strictEqual(invalid.error.code, 'JC2050');
    assert.strictEqual(sent.length, 1, 'the refusals sent nothing');

    let calls = 0;
    const down = openHttpClient(CONTRACT, { fetch: async () => { calls++; throw new TypeError('fetch failed'); } });
    const network = await down.bytes('blob.get', { id: 'a' });
    assert.strictEqual(network.ok, false);
    if (!network.ok) {
      assert.strictEqual(network.kind, 'network');
      assert.strictEqual(network.error.code, 'JC2051');
    }
    assert.strictEqual(calls, 1, 'bytes never retries, whatever the retry policy declares');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await client.bytes('blob.get', { id: 'a' }, { signal: controller.signal });
    assert.strictEqual(cancelled.ok, false);
    if (!cancelled.ok) assert.strictEqual(cancelled.kind, 'cancelled');
    const aborting = openHttpClient(CONTRACT, { fetch: (url, init) => new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal?.reason)); }) });
    const late = new AbortController();
    const pending = aborting.bytes('blob.get', { id: 'a' }, { signal: late.signal });
    late.abort();
    const lateOutcome = await pending;
    assert.strictEqual(lateOutcome.ok, false);
    if (!lateOutcome.ok) assert.strictEqual(lateOutcome.kind, 'cancelled');
  });

  it('a streamed upload goes out half-duplex from an async iterable, text and bytes go out as they are, the media becomes the content-type, and a bad body is JC1008', async () => {
    const { client, sent } = pair();
    const chunks = [new Uint8Array(500).fill(4), new Uint8Array(500).fill(5)];
    const upload = await client.bytes('blob.put', { id: 'u' }, { body: chunkSource(chunks).source });
    assert.strictEqual(upload.ok, true);
    if (upload.ok) {
      const value = /** @type {any} */ (upload.value);
      assert.strictEqual(await new Response(value.body).text(), `1000:${sha(chunks)}`);
      assert.strictEqual(upload.meta.etag, '"b1"');
    }
    assert.ok(sent[0].init.body instanceof ReadableStream);
    assert.strictEqual(sent[0].init.duplex, 'half');
    assert.strictEqual(sent[0].init.headers['content-type'], 'application/octet-stream');

    const text = await client.bytes('blob.put', { id: 'u' }, { body: 'abc', headers: { 'content-type': 'text/plain' } });
    assert.strictEqual(text.ok, true);
    assert.strictEqual(sent[1].init.body, 'abc');
    assert.strictEqual(sent[1].init.duplex, undefined);
    assert.strictEqual(sent[1].init.headers['content-type'], 'text/plain', 'a caller\'s content-type wins');
    const bytes = await client.bytes('blob.put', { id: 'u' }, { body: new Uint8Array([1, 2, 3]) });
    assert.strictEqual(bytes.ok, true);
    if (bytes.ok) assert.strictEqual(await new Response(/** @type {any} */ (bytes.value).body).text(), `3:${sha([new Uint8Array([1, 2, 3])])}`);
    const web = await client.bytes('blob.put', { id: 'u' }, { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([7])); c.close(); } }) });
    assert.strictEqual(web.ok, true);
    assert.strictEqual(sent[3].init.duplex, 'half');
    await assert.rejects(async () => client.bytes('blob.put', { id: 'u' }, { body: /** @type {any} */ (42) }), (/** @type {any} */ e) => e.code === 'JC1008');
  });

  it('an upload the transport stops reading is cancelled once: the async iterable behind the request stream gets one return()', async () => {
    const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)];
    const upload = chunkSource(chunks);
    const client = openHttpClient(CONTRACT, {
      fetch: async (url, init) => {
        const reader = /** @type {ReadableStream<Uint8Array>} */ (init.body).getReader();
        await reader.read();
        await reader.cancel();
        await reader.cancel();
        return new Response('{"code":"gone","message":"m","requestId":"t","retryable":false}', { status: 410, headers: { 'content-type': 'application/json' } });
      },
    });
    const outcome = await client.bytes('blob.put', { id: 'u' }, { body: upload.source });
    assert.strictEqual(outcome.ok, false);
    if (!outcome.ok) assert.strictEqual(outcome.error.code, 'gone');
    assert.deepStrictEqual(upload.counts, { pulled: 1, returned: 1 });
  });

  it('a body that fails after the headers rejects the read, once, with no second request; a 304 is a notModified success with no body', async () => {
    let calls = 0;
    const failing = openHttpClient(CONTRACT, {
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([1])); },
          pull(c) { c.error(new Error('the socket hung up')); },
        }), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      },
    });
    const outcome = await failing.bytes('blob.get', { id: 'a' });
    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      const reader = /** @type {any} */ (outcome.value).body.getReader();
      await reader.read();
      await assert.rejects(reader.read(), /hung up/);
    }
    assert.strictEqual(calls, 1);

    const { client } = pair({ 'blob.get': () => ({ status: 304, headers: { etag: '"g1"' } }) });
    const notModified = await client.bytes('blob.get', { id: 'a' }, { ifNoneMatch: '"g1"' });
    assert.strictEqual(notModified.ok, true);
    if (notModified.ok) {
      assert.deepStrictEqual(/** @type {any} */ (notModified.value).body, null);
      assert.strictEqual(/** @type {any} */ (notModified.value).status, 304);
      assert.strictEqual(notModified.meta.notModified, true);
      assert.strictEqual(notModified.meta.etag, '"g1"');
    }
  });
});

describe('bytes — the fixed-heap probe', () => {
  it('moves 100 MiB up and down through the node adapter and the fetch adapter in a child with a 48 MiB old space, hashes equal, backpressure bounded', async () => {
    const child = spawn(process.execPath, ['--max-old-space-size=48', fileURLToPath(new URL('./fixtures/streaming-child.mjs', import.meta.url)), String(100 * 1024 * 1024)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const [code] = await once(child, 'close');
    assert.strictEqual(code, 0, `the child failed: ${err}`);
    const report = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    assert.strictEqual(report.total, 100 * 1024 * 1024);
    assert.strictEqual(report.node.uploadHash, report.expected);
    assert.strictEqual(report.node.downloadHash, report.expected);
    assert.strictEqual(report.fetch.uploadHash, report.expected);
    assert.strictEqual(report.fetch.downloadHash, report.expected);
    // what was generated but not yet consumed never approached the
    // payload: a few MiB of socket and transport buffering over
    // loopback, nothing at all in-process
    assert.ok(report.node.upOutstanding < 16 * 1024 * 1024, `node upload outstanding ${report.node.upOutstanding}`);
    assert.ok(report.node.downOutstanding < 16 * 1024 * 1024, `node download outstanding ${report.node.downOutstanding}`);
    assert.strictEqual(report.fetch.upOutstanding, 0);
    assert.strictEqual(report.fetch.downOutstanding, 0);
  });
});
