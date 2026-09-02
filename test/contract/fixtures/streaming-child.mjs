// The fixed-heap probe of the opaque byte path: run with a V8 old space
// far below the payload (`--max-old-space-size=48` for 100 MiB), it
// uploads a generated body chunk by chunk through the node adapter over
// a real socket with `client.bytes()`, downloads the same amount back,
// hashes both sides on the fly, and repeats the carrier half through
// the fetch adapter in-process. It prints one JSON line: the hashes, the
// most bytes ever generated but not yet consumed (backpressure), and the
// peak RSS. Nothing here retains a body.
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { openHttpClient } from '@jarenjs/contract/client';

const CHUNK = 64 * 1024;
const TOTAL = Number(process.argv[2] ?? 100 * 1024 * 1024);
const CHUNKS = TOTAL / CHUNK;

const contract = compileContract({
  $contract: '0.1',
  operations: {
    'blob.put': {
      kind: 'command',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      output: true,
      policy: { limits: { maxBodyBytes: TOTAL } },
      http: { method: 'PUT', path: '/blobs/{id}', media: 'application/octet-stream' },
    },
    'blob.get': {
      kind: 'read',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      output: true,
      http: { method: 'GET', path: '/blobs/{id}', media: 'application/octet-stream' },
    },
  },
});

let peakRss = 0;
function sample() {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}

/** The deterministic payload: chunk i is filled with (i * 7 + 3) & 255. */
function* payload() {
  for (let i = 0; i < CHUNKS; i++) yield new Uint8Array(CHUNK).fill((i * 7 + 3) & 255);
}
const expected = (() => {
  const h = createHash('sha256');
  for (const c of payload()) h.update(c);
  return h.digest('hex');
})();

/** A generated upload that counts what it yielded. */
function generated(counter) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of payload()) {
        counter.yielded += c.byteLength;
        yield c;
      }
    },
  };
}

const up = { yielded: 0, consumed: 0, maxOutstanding: 0 };
const down = { yielded: 0, consumed: 0, maxOutstanding: 0 };

const server = serveHttp(contract, {
  'blob.put': async (input, ctx) => {
    const h = createHash('sha256');
    for await (const chunk of ctx.body) {
      h.update(chunk);
      up.consumed += chunk.byteLength;
      const outstanding = up.yielded - up.consumed;
      if (outstanding > up.maxOutstanding) up.maxOutstanding = outstanding;
      sample();
    }
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: h.digest('hex') };
  },
  'blob.get': () => ({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const c of payload()) {
          down.yielded += c.byteLength;
          yield c;
        }
      },
    },
  }),
});

async function readAll(stream, counter) {
  const h = createHash('sha256');
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    counter.consumed += value.byteLength;
    const outstanding = counter.yielded - counter.consumed;
    if (outstanding > counter.maxOutstanding) counter.maxOutstanding = outstanding;
    sample();
  }
  return h.digest('hex');
}

const nodeServer = http.createServer(toNodeHandler(server));
nodeServer.listen(0, '127.0.0.1');
await once(nodeServer, 'listening');
const origin = `http://127.0.0.1:${nodeServer.address().port}`;
const client = openHttpClient(contract, { baseUrl: origin });

/** A small text body (the hash the upload handler answers), read whole. */
async function readText(stream) {
  const reader = stream.getReader();
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const started = Date.now();
const upload = await client.bytes('blob.put', { id: 'a' }, { body: generated(up) });
if (!upload.ok) throw new Error(`upload failed: ${JSON.stringify(upload)}`);
const uploadHash = await readText(upload.value.body);
const download = await client.bytes('blob.get', { id: 'a' });
if (!download.ok) throw new Error(`download failed: ${JSON.stringify(download)}`);
const downloadHash = await readAll(download.value.body, down);
const nodeMs = Date.now() - started;

// the fetch carrier, in-process: the same dispatcher behind (Request) => Response
const fetchUp = { yielded: 0, consumed: 0, maxOutstanding: 0 };
const fetchDown = { yielded: 0, consumed: 0, maxOutstanding: 0 };
const fetchServer = serveHttp(contract, {
  'blob.put': async (input, ctx) => {
    const h = createHash('sha256');
    for await (const chunk of ctx.body) {
      h.update(chunk);
      fetchUp.consumed += chunk.byteLength;
      const outstanding = fetchUp.yielded - fetchUp.consumed;
      if (outstanding > fetchUp.maxOutstanding) fetchUp.maxOutstanding = outstanding;
      sample();
    }
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: h.digest('hex') };
  },
  'blob.get': () => ({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const c of payload()) {
          fetchDown.yielded += c.byteLength;
          yield c;
        }
      },
    },
  }),
});
const fetchHandler = toFetchHandler(fetchServer);
const fetchClient = openHttpClient(contract, { baseUrl: 'http://contract.local', fetch: (url, init) => fetchHandler(new Request(url, init)) });
const fetchStarted = Date.now();
const fetchUpload = await fetchClient.bytes('blob.put', { id: 'b' }, { body: generated(fetchUp) });
if (!fetchUpload.ok) throw new Error(`fetch upload failed: ${JSON.stringify(fetchUpload)}`);
const fetchUploadHash = await readText(fetchUpload.value.body);
const fetchDownload = await fetchClient.bytes('blob.get', { id: 'b' });
if (!fetchDownload.ok) throw new Error(`fetch download failed: ${JSON.stringify(fetchDownload)}`);
const fetchDownloadHash = await readAll(fetchDownload.value.body, fetchDown);
const fetchMs = Date.now() - fetchStarted;

client.close();
nodeServer.closeAllConnections();
nodeServer.close();
process.stdout.write(`${JSON.stringify({
  total: TOTAL, chunk: CHUNK, expected,
  node: { uploadHash, downloadHash, upOutstanding: up.maxOutstanding, downOutstanding: down.maxOutstanding, ms: nodeMs },
  fetch: { uploadHash: fetchUploadHash, downloadHash: fetchDownloadHash, upOutstanding: fetchUp.maxOutstanding, downOutstanding: fetchDown.maxOutstanding, ms: fetchMs },
  peakRss,
})}\n`);
